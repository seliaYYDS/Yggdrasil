import { registerInterface } from '../registry/interfaceRegistry';
import { fail, ok, strOr, type OpContext, type OpResult } from '../bus/opContext';
import type { DerivationOp } from '../types';
import { useDesktopStore } from '../../store/desktopStore';
import { runTool, toolSandboxKind } from '../plugin/sandbox';
import { policyFor } from '../security';
import {
  deleteEntry,
  formatBytes,
  getEntry,
  kindOf,
  listWorkspace,
  putEntry,
  usageBytes,
  validName,
  WORKSPACE_SOFT_LIMIT,
} from './store';

/**
 * ws_run：**执行一小段临时代码，输入输出都是工作区**。
 *
 * 为什么需要它（这是用户反馈的核心问题）：在此之前，"把内容变个样子"只能靠
 * **创建一个组件** —— 组件是唯一既拿得到内容、又能执行代码的地方。于是每处理一次
 * 就在桌面上多一个窗口，而那本来只是一次计算。
 *
 * 它解决的问题**不是图片问题**：CSV 转 JSON、日志归类、正则替换、拼接两份文件、
 * 算哈希、解 base64 —— 全都一样卡在这里。
 *
 * 三条刻意的约束：
 *
 * 1. **不创建任何节点**。加工一次 = 一次调用，桌面上什么都不多出来。
 * 2. **返回值不作为输出**（用户明确要求）。结果的唯一去处是**写回工作区**；
 *    脚本的返回值只用于诊断（类型/长度），不当作内容交付。这样"交付"永远只有
 *    一个渠道（组件），不会出现"有些内容在对话里、有些在界面上"的分裂。
 * 3. **跑在与插件 js 工具同一个 Worker 沙箱里**（无 DOM、无网络出口、有配额）。
 *    注意这比组件**更小**：组件在主页面 realm 里跑、有完整 DOM。
 *    所以"高安全档禁用插件 js 工具"那条规则不适用于这里 ——
 *    它是模型自己写的、在工作台上算一次的东西，堵死它却允许组件，逻辑上说不通。
 *
 * 沙箱本身不认识工作区（见 sandbox.ts）：它只把 ctx.workspace 的调用转发出来，
 * 由这里的桥去读写真正的后端。插件工具**不注入这个桥**，所以它们碰不到工作区。
 */

/** 一次调用最多写几次文件（防止脚本刷爆工作区）。 */
const MAX_WRITES = 20;

/** 单次读写的上限（与 ws_write 保持一致）。 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

interface WsWriteData {
  /** 文本内容。 */
  text?: string;
  /** 二进制内容（ArrayBuffer / 类型化数组 / Blob）。 */
  bytes?: unknown;
  /** 二进制时的类型。 */
  mime?: string;
}

/**
 * 把脚本传进来的"内容"归一成 { text } 或 { bytes }。
 *
 * 这里原来**只认** { text } / { bytes } 两种显式形状（理由是裸值有歧义）。但实践里
 * 模型天然会写 `write(name, "字符串")` / `write(name, 字节)` —— 于是脚本每次都在
 * **最后一步**炸掉，整次加工（读、转换、算）全部白做：用户反馈"ws_run 极易报错、
 * 完全没法按预期改工作区里的文件"就是这个。
 *
 * 歧义只存在于"一个孤立的值到底是内容还是文件名"这种**没有位置**的场合；
 * write 的第二个参数位置本身就是内容，所以收下裸值是安全的：
 *   string           → { text }
 *   ArrayBuffer / 视图 → { bytes }
 *   Blob             → { bytes }，并用 blob.type 当 mime
 *                      （canvas / OffscreenCanvas 转码的产物就是 Blob，它自带类型）
 */
async function normalizeWriteData(raw: unknown): Promise<WsWriteData> {
  if (typeof raw === 'string') return { text: raw };
  if (raw instanceof ArrayBuffer) return { bytes: raw };
  if (ArrayBuffer.isView(raw)) return { bytes: raw };
  if (typeof Blob !== 'undefined' && raw instanceof Blob) {
    const mime = raw.type;
    return { bytes: new Uint8Array(await raw.arrayBuffer()), ...(mime ? { mime } : {}) };
  }
  return (raw ?? {}) as WsWriteData;
}

export function registerWorkspaceRunInterface(): void {
  registerInterface({
    kind: 'ws_run',
    label: '运行脚本',
    description:
      '**Run a small script against the workspace** (your scratch bench) to transform content in place instead of building a component — parsing, converting, rewriting, combining, computing. The script is `async (args, ctx) => { ... }` (args is empty; it runs in a Worker with no DOM and no network of its own). In ctx: workspace.list(); .read(name) — **a text file comes back as a string, a binary one as { bytes: ArrayBuffer, mime, size }** (not a Blob: build it with new Blob([r.bytes], { type: r.mime })); .write(name, data) — data is a string, bytes (ArrayBuffer / typed array / Blob), or the explicit { text } / { bytes, mime }; .delete(name); ctx.log(...); ctx.fetch(...) — **no host allow-list here, so fetch always fails**; get web content with ws_write(url) first. **The return value is NOT an output channel**: write results into the workspace and deliver them by embedding in a component.',
    example: {
      kind: 'ws_run',
      script:
        'async (args, ctx) => {\n' +
        '  // text file -> a plain string\n' +
        '  const txt = await ctx.workspace.read("raw.txt");\n' +
        '  const lines = String(txt).split("\\n").filter((l) => l.trim());\n' +
        '  await ctx.workspace.write("clean.txt", lines.join("\\n"));  // a string is text content\n' +
        '  // binary file -> { bytes, mime, size }; pass the bytes straight back\n' +
        '  const img = await ctx.workspace.read("shot.png");\n' +
        '  await ctx.workspace.write("copy.png", { bytes: img.bytes, mime: img.mime });\n' +
        '  ctx.log("整理 " + lines.length + " 行");\n' +
        '}',
    },
    mutates: true,
    cap: 'net',
    handler: async (op: DerivationOp, ctx: OpContext): Promise<OpResult> => {
      const script = strOr(op.script, '');
      if (!script.trim()) return fail('ws_run 需要 script：一个函数表达式，形如 async (ctx) => { ... }。');
      if (toolSandboxKind() === 'unavailable') {
        return fail(
          '这个环境不支持隔离执行（没有 Worker），所以 ws_run 用不了。' +
            '要处理内容请把工作区里的文件嵌进组件，让组件里的代码去做。',
        );
      }

      const policy = policyFor(useDesktopStore.getState().settings.securityLevel);
      const touched: string[] = [];
      let writes = 0;
      /** 脚本自己声明"结果在哪" —— 回读里会告诉模型去看这个文件。 */
      const written: string[] = [];

      const workspace = async (req: { op: string; name?: string; data?: unknown }): Promise<unknown> => {
        const name = typeof req.name === 'string' ? req.name : '';
        switch (req.op) {
          case 'list': {
            const files = await listWorkspace();
            const used = files.reduce((n, f) => n + f.size, 0);
            return {
              files: files.map((f) => ({ name: f.name, kind: f.kind, mime: f.mime, size: f.size })),
              used,
              limit: WORKSPACE_SOFT_LIMIT,
            };
          }
          case 'read': {
            if (!validName(name)) throw new Error('名字不合法：' + name);
            const entry = await getEntry(name);
            if (!entry) throw new Error('工作区里没有 ' + name);
            if (entry.kind === 'text') return entry.text ?? '';
            if (!entry.blob) throw new Error(name + ' 没有内容');
            // 二进制：**给字节**（结构化克隆直接过），不是 base64。
            // 这正是"通用"的关键 —— 拿到字节的脚本能干任何事，不限于图像。
            const buf = await entry.blob.arrayBuffer();
            return { bytes: buf, mime: entry.mime, size: entry.size };
          }
          case 'write': {
            /*
             * 返回值**不作为输出**，所以写回工作区是唯一的结果去处；
             * 这里对"写几次"设上限，防止一次调用把工作区刷爆。
             */
            if (writes >= MAX_WRITES) {
              throw new Error('一次调用最多写 ' + MAX_WRITES + ' 次文件（已经写满了）。');
            }
            if (!validName(name)) throw new Error('名字不合法：' + name);
            const data = await normalizeWriteData(req.data);
            const existing = await getEntry(name);
            const replacing = existing?.size ?? 0;

            let size = 0;
            let entry;
            if (typeof data.text === 'string') {
              const text = data.text;
              size = new TextEncoder().encode(text).length;
              if (size > MAX_FILE_BYTES) throw new Error('文本太大（' + formatBytes(size) + '）。');
              entry = {
                name,
                kind: 'text' as const,
                mime: 'text/plain',
                size,
                createdAt: existing?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
                text,
              };
            } else {
              const raw = data.bytes;
              let bytes: Uint8Array;
              if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
              else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
              /*
               * 走到这里说明给的东西连归一化都认不出来（不是文本、不是字节、也不是
               * { text } / { bytes } 这两种显式形状）。报错里把**能用的形状**写全，
               * 模型下一次才知道该给什么。
               */
              else {
                throw new Error(
                  'write 的 data 只能是文本（string）、字节（ArrayBuffer / 类型化数组 / Blob），' +
                    '或者 { text } / { bytes, mime } 这样的显式形状。',
                );
              }
              size = bytes.length;
              if (size === 0) throw new Error('write 的字节是空的。');
              if (size > MAX_FILE_BYTES) throw new Error('字节太多（' + formatBytes(size) + '）。');
              const mime = typeof data.mime === 'string' && data.mime ? data.mime : 'application/octet-stream';
              const copy = new Uint8Array(bytes.length);
              copy.set(bytes);
              entry = {
                name,
                kind: kindOf(mime, name),
                mime,
                size,
                createdAt: existing?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
                blob: new Blob([copy], { type: mime }),
              };
            }

            const used = await usageBytes();
            if (used - replacing + size > WORKSPACE_SOFT_LIMIT) {
              throw new Error(
                '工作区装不下了（已用 ' + formatBytes(used) + '，上限 ' + formatBytes(WORKSPACE_SOFT_LIMIT) + '）。',
              );
            }
            await putEntry(entry);
            writes += 1;
            if (!written.includes(name)) written.push(name);
            if (!touched.includes(name)) touched.push(name);
            return { ok: true, name, size, kind: entry.kind };
          }
          case 'delete': {
            if (!validName(name)) throw new Error('名字不合法：' + name);
            const had = await deleteEntry(name);
            if (had && !touched.includes(name)) touched.push(name);
            return { ok: had, name };
          }
          default:
            throw new Error('工作区不认识这个操作：' + req.op);
        }
      };

      const res = await runTool({
        source: script,
        args: {},
        fields: {},
        plugin: { id: 'workspace', name: '工作区脚本', version: '1' },
        // 比插件工具宽一点：脚本可能要处理一张大图再写回去。
        timeoutMs: Math.min(30000, Math.max(8000, Number(op.timeoutMs) || 15000)),
        allowHosts: [], // 不给主机：ws_run 的定位是"加工内容"，要取网络内容先用 ws_write(url)
        maxFetches: 0,
        maxResponseBytes: policy.responseBytes,
        logChars: policy.logChars,
        workspace,
        // 停止时终止脚本：它可能正卡在一个长循环里。
        signal: ctx.signal,
      });

      const logText = res.logs.length ? '\n脚本日志：\n' + res.logs.join('\n') : '';

      if (!res.ok) {
        return fail('脚本执行失败：' + (res.error ?? '未知错误') + logText);
      }

      /*
       * **返回值只用于诊断，不作为输出。**
       * 这里只报它的类型/大小，让模型知道"脚本跑完了、有没有东西没接住"，
       * 但绝不把它的内容当成交付物 —— 交付的唯一渠道是组件。
       */
      const ret = res.value;
      const retNote =
        ret === null || ret === undefined
          ? '脚本没有返回值。'
          : '脚本返回了 ' + (typeof ret === 'object' ? '一个 ' + (Array.isArray(ret) ? '数组' : '对象') : '一个 ' + typeof ret) +
            '（**返回值不作为输出**：结果请用 ctx.workspace.write 写回工作区，再嵌进组件交付）。';

      if (written.length === 0 && touched.length === 0) {
        return ok('脚本跑完了，但没有改动工作区', {
          observation: retNote + logText + '\n提示：ws_run 的用途是加工工作区里的内容，不写回文件就等于什么都没发生。',
        });
      }

      const files = await listWorkspace();
      const used = files.reduce((n, f) => n + f.size, 0);
      return ok('脚本跑完了', {
        observation:
          (written.length ? '写入了：' + written.join('、') : '删除了：' + touched.join('、')) +
          '（工作区现在 ' + files.length + ' 个文件，' + formatBytes(used) + ' / ' + formatBytes(WORKSPACE_SOFT_LIMIT) + '）。' +
          '\n' + retNote + logText +
          (written.length
            ? '\n要看结果用 ws_read；要交付就把它嵌进组件（源码里写 "@ws/' + written[written.length - 1] + '"）。'
            : ''),
      });
    },
  });
}

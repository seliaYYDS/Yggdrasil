import { registerInterface } from '../registry/interfaceRegistry';
import { fail, ok, strOr, type OpContext, type OpResult } from '../bus/opContext';
import { fetchImageData } from '../net/fetchWeb';
import { useDesktopStore } from '../../store/desktopStore';
import { prepareImage } from '../../host/image';
import {
  bytesOfText,
  clearWorkspace,
  deleteEntry,
  embedValue,
  formatBytes,
  getEntry,
  kindOf,
  listWorkspace,
  putEntry,
  textOf,
  usageBytes,
  validName,
  workspaceLimits,
  type WorkspaceEntry,
} from '../workspace/store';
import { MAX_HIDDEN, hiddenPiece } from '../workspace/hide';

/**
 * 工作区（沙盒）的 Agent 接口。
 *
 * 六个 op：写 / 列 / 读 / 删 / 用量 / 取回隐藏内容。**注意没有"修改"这个独立动作** ——
 * 文本的"改"就是用一个新内容覆盖同名文件（ws_write 的 text 参数），
 * 二进制（图片、音频）**不能原地改**，只能整个替换。这条写在 description 里，
 * 免得模型以为能对图片做增量编辑。
 *
 * 全组挂在 net 能力开关下：它能联网取内容（从 URL 抓字节），
 * 所以没有 net 的 Agent 看不到、也调不动。
 */

/*
 * 单文件与总容量上限**都来自设置**（设置 → 常规 → 工作区），不再是写死的常量。
 * 每次调用现读一次：用户改了上限应当立刻生效，而不是等下次刷新。
 */

async function limitsText(): Promise<string> {
  const { total, file } = await workspaceLimits();
  return 'soft limit ' + formatBytes(total) + ' in total, ' + formatBytes(file) + ' per file';
}

async function guardSpace(adding: number, replacing: number): Promise<string | null> {
  const { total } = await workspaceLimits();
  const used = await usageBytes();
  if (used - replacing + adding > total) {
    return (
      '工作区装不下了：已用 ' + formatBytes(used) + '，这次要再加 ' + formatBytes(adding) +
      '，上限 ' + formatBytes(total) + '。先删掉一些不再需要的文件（ws_list 看清单、ws_delete 删）。'
    );
  }
  return null;
}

export function registerWorkspaceInterfaces(): void {
  registerInterface({
    kind: 'ws_write',
    label: '写工作区',
    description:
      '**Put something into your scratch workspace** (a temporary bench, not storage). Give name plus exactly one of: text (a string), url (fetch the bytes from the web and save them), or from (copy an existing workspace file). Writing an existing name **overwrites** it — that is also how you edit text. Binary files (images, audio) **cannot be edited in place**; replace them whole. Everything here is temporary: it is not saved with the scene and can be cleared at any time, so do not treat it as permanent storage.',
    example: { kind: 'ws_write', name: 'note.txt', text: '第一行' },
    mutates: true,
    cap: 'net',
    handler: async (op) => {
      const name = strOr(op.name, '');
      if (!validName(name)) {
        return fail('名字要用字母数字开头，只含字母数字与 . _ -（现在是 "' + name + '"）。它不是文件系统，没有目录。');
      }
      const hasText = typeof op.text === 'string';
      const url = strOr(op.url, '');
      const from = strOr(op.from, '');
      const given = [hasText, !!url, !!from].filter(Boolean).length;
      if (given !== 1) {
        return fail('ws_write 要**恰好**给一个内容来源：text（文本）、url（从网上取）、或 from（复制工作区里已有的文件）。');
      }

      const existing = await getEntry(name);
      const replacing = existing?.size ?? 0;

      let entry: WorkspaceEntry;
      if (hasText) {
        const text = String(op.text);
        const size = bytesOfText(text);
        const { file: maxFile } = await workspaceLimits();
        if (size > maxFile) {
          return fail('这个文本太大了（' + formatBytes(size) + '），单文件上限 ' + formatBytes(maxFile) + '。');
        }
        const room = await guardSpace(size, replacing);
        if (room) return fail(room);
        entry = { name, kind: 'text', mime: 'text/plain', size, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(), text };
      } else if (from) {
        if (!validName(from)) return fail('from 的名字不合法：' + from);
        const src = await getEntry(from);
        if (!src) return fail('工作区里没有 ' + from + '（用 ws_list 看有什么）。');
        const room = await guardSpace(src.size, replacing);
        if (room) return fail(room);
        // 复制而不是移动：from 是"拿它当素材再存一份"，动原文件会让人意外。
        entry = { ...src, name, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() };
      } else {
        // 从网上取字节。**这是工作区唯一的数据入口**，所以走与图片同一套读取路径
        // （直连优先、必要时用设置里的图片中转），并在这里卡体积。
        const relay = (useDesktopStore.getState().settings.imageRelay ?? '').trim() || undefined;
        let data;
        try {
          data = await fetchImageData(url, { relay });
        } catch (e) {
          return fail('取 ' + url + ' 失败：' + (e as Error).message);
        }
        const size = data.blob.size;
        const { file: maxFile } = await workspaceLimits();
        if (size > maxFile) {
          return fail('这个文件太大了（' + formatBytes(size) + '），单文件上限 ' + formatBytes(maxFile) + '。');
        }
        const room = await guardSpace(size, replacing);
        if (room) return fail(room);
        const mime = data.contentType || 'application/octet-stream';
        entry = {
          name,
          kind: kindOf(mime, name),
          mime,
          size,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          blob: data.blob,
        };
      }

      await putEntry(entry);
      const used = await usageBytes();
      const { total: maxTotal } = await workspaceLimits();
      return ok(
        'Wrote ' + name + ' (' + entry.kind + ', ' + formatBytes(entry.size) + ')',
        {
          observation:
            name + ' 已写入工作区：' + entry.kind + '，' + formatBytes(entry.size) + '，' +
            (existing ? '覆盖了原来的同名文件。' : '新建。') +
            '\n工作区已用 ' + formatBytes(used) + ' / ' + formatBytes(maxTotal) + '。' +
            (entry.kind === 'text'
              ? '\n要嵌入组件就在源码里写 "' + '@ws/' + name + '"，写入时会**复制**内容进去（之后改工作区不影响组件）。'
              : '\n要嵌入组件就在源码里写 "' + '@ws/' + name + '"，宿主会把它转成 data URL 复制进去。' +
                '\n想自己看一眼用 ws_read。'),
        },
      );
    },
  });

  registerInterface({
    kind: 'ws_list',
    label: '列工作区',
    description:
      'List what is in the scratch workspace: name, kind (text / image / binary), mime, size, last modified. **Call it before assuming a file exists** — the workspace can be cleared by the user at any time.',
    example: { kind: 'ws_list' },
    cap: 'net',
    handler: async () => {
      const files = await listWorkspace();
      const used = files.reduce((n, f) => n + f.size, 0);
      const { total: maxTotal } = await workspaceLimits();
      if (files.length === 0) {
        return ok('Workspace is empty.', {
          observation: '工作区是空的。（上限 ' + formatBytes(maxTotal) + '，当前 0 B）',
        });
      }
      const lines = files.map(
        (f) => '- ' + f.name + '  [' + f.kind + ']  ' + formatBytes(f.size) + '  ' +
          new Date(f.updatedAt).toLocaleString() + (f.mime ? '  ' + f.mime : ''),
      );
      return ok(files.length + ' file(s) in the workspace', {
        observation:
          '工作区里有 ' + files.length + ' 个文件（已用 ' + formatBytes(used) + ' / ' +
          formatBytes(maxTotal) + '）：\n' + lines.join('\n') +
          '\n在组件源码里写 "@ws/名字" 就能把内容嵌进去（写入时复制，之后改工作区不影响组件）。',
      });
    },
  });

  registerInterface({
    kind: 'ws_read',
    label: '读工作区',
    description:
      'Read one workspace file. Text comes back as text. **Images come back into your own eyes** (they are attached to a message, so you literally see them) and that message is added to this session. Other binary types are reported as metadata only — their bytes cannot enter the context, so work with them through a component (embed them) or convert them first.',
    example: { kind: 'ws_read', name: 'note.txt' },
    cap: 'net',
    handler: async (op, ctx: OpContext): Promise<OpResult> => {
      const name = strOr(op.name, '');
      const entry = await getEntry(name);
      if (!entry) {
        const files = await listWorkspace();
        return fail(
          '工作区里没有 ' + name + '。现有：' + (files.map((f) => f.name).join('、') || '（空）'),
        );
      }
      if (entry.kind === 'text') {
        const text = textOf(entry) ?? '';
        return ok('Read ' + name, {
          observation: text.length > 20000 ? text.slice(0, 20000) + '\n... (截断，共 ' + text.length + ' 字符)' : text,
        });
      }
      if (entry.kind === 'image' && entry.blob) {
        // 图片走**多模态**：和 view_image 同一条路 —— 压一遍、写进本次运行的会话记忆，
        // 于是模型下一轮真的"看见"它。这也是"沙盒能看图"的唯一正确做法。
        const prepared = await prepareImage(entry.blob);
        const caption = 'Workspace image ' + name + ' (' + entry.mime + ', ' + formatBytes(entry.size) + ')';
        const store = useDesktopStore.getState();
        if (ctx.originId === store.rootId) {
          store.appendSessionMessage(ctx.sessionId, { role: 'user', content: caption, images: [prepared?.dataUrl ?? ''] });
        } else {
          const fresh = store.nodes[ctx.originId];
          if (!fresh || fresh.kind !== 'component' || !fresh.agent) {
            return fail('读图时发起方已经不是一个有 agent 能力的组件了，图没能进上下文。');
          }
          const next = [...fresh.agent.messages, { role: 'user' as const, content: caption, images: [prepared?.dataUrl ?? ''] }];
          store.updateFacet(ctx.originId, { messages: next });
        }
        return ok('Read image ' + name, {
          observation:
            caption + '\n**这张图已经进入你的上下文**，下一轮你就能看到它。' +
            '\n想把它放进界面，就在组件源码里写 "' + '@ws/' + name + '"（写入时复制内容）。',
        });
      }
      return ok('Read ' + name + ' (metadata only)', {
        observation:
          name + ' 是 ' + entry.kind + '（' + entry.mime + '，' + formatBytes(entry.size) + '）。' +
          '\n它的字节**进不了上下文**（不是文本、也不是我能看的图片）。' +
          '\n要用它就在组件里嵌入（源码写 "' + '@ws/' + name + '"），或者先转成文本/图片再处理。',
      });
    },
  });

  registerInterface({
    kind: 'ws_delete',
    label: '删工作区文件',
    description:
      'Delete one workspace file by name, or pass all: true to clear the whole workspace. Safe: anything already embedded into a component stays there — embedding copies the content, so clearing the workspace never breaks a finished interface.',
    example: { kind: 'ws_delete', name: 'note.txt' },
    mutates: true,
    cap: 'net',
    handler: async (op) => {
      if (op.all === true) {
        const n = await clearWorkspace();
        return ok('Cleared the workspace', { observation: '清空了工作区，删掉 ' + n + ' 个文件。（已嵌入组件的内容不受影响）' });
      }
      const name = strOr(op.name, '');
      const had = await deleteEntry(name);
      if (!had) return fail('工作区里没有 ' + name + '。');
      return ok('Deleted ' + name, { observation: '已删除 ' + name + '。已嵌入组件的内容不受影响。' });
    },
  });

  registerInterface({
    kind: 'ws_usage',
    label: '工作区用量',
    description:
      'How much of the workspace is used and how much is left. Call it when a write is refused for space reasons. Note this is the workspace own soft limit, not the browser storage quota.',
    example: { kind: 'ws_usage' },
    cap: 'net',
    handler: async () => {
      const files = await listWorkspace();
      const used = files.reduce((n, f) => n + f.size, 0);
      const { total: maxTotal } = await workspaceLimits();
      return ok('Workspace usage', {
        observation:
          '已用 ' + formatBytes(used) + ' / ' + formatBytes(maxTotal) +
          '（' + files.length + ' 个文件）。' + (await limitsText()),
      });
    },
  });
}

export function registerWorkspaceHiddenInterface(): void {
  registerInterface({
    kind: 'ws_hidden',
    label: '取回隐藏内容',
    description:
      'Read back one piece that was left out of an earlier result and shown as [#N ... hidden on purpose]. Give ref (the number). Text comes back clipped; **images come back into your own eyes** (attached to a message, so you see them next round). Only pieces from this session can be read.',
    example: { kind: 'ws_hidden', ref: 1 },
    cap: 'net',
    handler: async (op, ctx: OpContext): Promise<OpResult> => {
      const ref = typeof op.ref === 'number' ? Math.floor(op.ref) : -1;
      const piece = hiddenPiece(ref);
      if (!piece) {
        return fail(
          '没有第 ' + ref + ' 号隐藏内容。序号只在**本次会话**内有效，而且只记得最近 ' +
            MAX_HIDDEN + ' 块 —— 需要内容请重新生成它（例如再写一次那个组件，或 ws_read 那个文件）。',
        );
      }
      const label = '#' + ref + ' ' + piece.what + (piece.detail ? ' in ' + piece.detail : '');
      if (piece.mime && piece.mime.startsWith('image/')) {
        const comma = piece.text.indexOf(',');
        const b64 = comma >= 0 ? piece.text.slice(comma + 1) : '';
        try {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: piece.mime });
          const prepared = await prepareImage(blob);
          const caption = 'Hidden ' + label;
          const store = useDesktopStore.getState();
          const dataUrl = prepared?.dataUrl ?? piece.text;
          if (ctx.originId === store.rootId) {
            store.appendSessionMessage(ctx.sessionId, {
              role: 'user',
              content: caption + '\n（这张图已经进入你的上下文，下一轮你能看到它）',
              images: [dataUrl],
            });
          } else {
            const fresh = store.nodes[ctx.originId];
            if (fresh && fresh.kind === 'component' && fresh.agent) {
              store.updateFacet(ctx.originId, {
                messages: [...fresh.agent.messages, { role: 'user' as const, content: caption, images: [dataUrl] }],
              });
            }
          }
          return ok('Read hidden ' + label + ' (image)', {
            observation: caption + '\n**这张图已经进入你的上下文**，下一轮就能看到它。',
          });
        } catch (e) {
          return fail('第 ' + ref + ' 号的图片还原失败：' + (e as Error).message);
        }
      }
      const text = piece.text;
      const shown =
        text.length > 20000
          ? text.slice(0, 20000) + '\n... (还有 ' + (text.length - 20000) + ' 字符没贴出来)'
          : text;
      return ok('Read hidden ' + label, { observation: label + '：\n' + shown });
    },
  });
}

/** 给"隐藏协议"用：把嵌入后的源码里，被复制进去的长内容记下来。 */
export async function embeddedValueOf(name: string): Promise<string | null> {
  const entry = await getEntry(name);
  if (!entry) return null;
  return await embedValue(entry);
}

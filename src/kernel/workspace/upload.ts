import {
  formatBytes,
  getEntry,
  kindOf,
  putEntry,
  validName,
  type WorkspaceEntry,
  type WorkspaceKind,
} from './store';

/**
 * 把用户上传的文件放进工作区。
 *
 * 这是"统一上传"的落点：**图片不再单独走一条路**，任何文件（图片、文本、PDF、
 * 压缩包…）都只做一件事 —— 写进工作区。之后的读取由 Agent 主动发起（ws_read），
 * 不再把内容直接塞进提示词。
 *
 * 为什么这样更好：
 * - **上下文不再被上传物污染**。原来粘贴一张图就自动进多模态、进历史、每轮重发；
 *   现在它安静地躺在工作区里，Agent 需要时才读。
 * - **和"加工"天然接上**。文件已经在工作区，ws_run 可以直接处理它、ws_read 可以看它、
 *   组件可以嵌入它 —— 不需要"上传的图"和"工作区里的图"两套。
 * - **图片之外的文件终于有地方去**。以前只有图片能被粘贴，其它文件无处可放。
 */

/** 单个上传文件的上限（与工作区其它入口一致）。 */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
/** 一次最多上传几个 —— 这是给人用的入口，不是批量导入。 */
export const MAX_UPLOAD_FILES = 8;

export interface UploadedFile {
  /** 工作区里的名字（可能被清洗/去重过）。 */
  name: string;
  /** 用户原本的文件名（被改过时才显示出来）。 */
  originalName?: string;
  kind: WorkspaceKind;
  mime: string;
  size: number;
}

export interface UploadResult {
  ok: UploadedFile[];
  /** 没进去的，带人能看懂的原因。 */
  errors: string[];
}

/**
 * 把用户给的文件名清洗成工作区能接受的名字。
 *
 * 为什么要清洗而不是拒绝：用户上传 "会议纪要 2026-10.md" 是完全正常的事，
 * 而工作区的命名规则（也是嵌入标记 @ws/ 的规则）只允许字母数字与 . _ -。
 * 直接拒绝等于"中文文件名传不上去"，那是很糟的体验；
 * 所以替换非法字符、保留扩展名，并把原名记下来给用户看。
 */
export function sanitizeFileName(raw: string): string {
  const name = (raw || 'file').trim();
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const clean = (s: string) =>
    s
      // 非 ASCII 与不允许的符号都换成 _（包括空格、中文、括号…）
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._-]+/, '')
      .replace(/[._-]+$/, '');
  let out = clean(base) || 'file';
  // 扩展名也只留安全字符
  const safeExt = ext ? '.' + clean(ext.slice(1)).replace(/\./g, '') : '';
  out = (out + safeExt).slice(0, 60);
  // 开头必须是字母数字（工作区与 @ws/ 标记都要求）
  if (!/^[A-Za-z0-9]/.test(out)) out = 'f_' + out;
  return validName(out) ? out : 'file' + safeExt;
}

/** 找一个不冲突的名字：a.txt -> a-2.txt -> a-3.txt … */
export async function uniqueName(wanted: string): Promise<string> {
  if (!(await getEntry(wanted))) return wanted;
  const dot = wanted.lastIndexOf('.');
  const base = dot > 0 ? wanted.slice(0, dot) : wanted;
  const ext = dot > 0 ? wanted.slice(dot) : '';
  for (let i = 2; i < 100; i += 1) {
    const candidate = base + '-' + i + ext;
    if (!validName(candidate)) continue;
    if (!(await getEntry(candidate))) return candidate;
  }
  // 极端情况下用一个带时间戳的名字，不报错了事
  return ('file-' + Date.now()).slice(0, 60) + ext;
}

/** 上传一批文件；每个独立的成功/失败，不因为一个坏文件全废。 */
export async function uploadFiles(files: File[]): Promise<UploadResult> {
  const ok: UploadedFile[] = [];
  const errors: string[] = [];
  for (const file of files.slice(0, MAX_UPLOAD_FILES)) {
    const original = file.name || 'file';
    try {
      if (file.size === 0) {
        errors.push(original + '：是空文件，跳过了。');
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        errors.push(original + '：' + formatBytes(file.size) + ' 超过单文件上限 ' + formatBytes(MAX_UPLOAD_BYTES) + '。');
        continue;
      }
      const wanted = sanitizeFileName(original);
      const name = await uniqueName(wanted);
      const mime = file.type || '';
      const kind = kindOf(mime, name);
      // 文本按 text 存（这样 ws_read 直接给文字、ws_run 读到的也是字符串）；
      // 其它一律存 blob（结构化克隆，不用 base64）。
      const entry: WorkspaceEntry = {
        name,
        kind,
        mime: mime || 'application/octet-stream',
        size: file.size,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(kind === 'text' ? { text: await file.text() } : { blob: file }),
      };
      // 文本用 text 字段时 size 要按实际字节算，免得与工作区用量对不上。
      if (typeof entry.text === 'string') entry.size = new TextEncoder().encode(entry.text).length;
      await putEntry(entry);
      ok.push({
        name,
        originalName: name === original ? undefined : original,
        kind: entry.kind,
        mime: entry.mime,
        size: entry.size,
      });
    } catch (e) {
      // 最常见的是"没有 IndexedDB，只能存文本" —— 那是环境限制，要说清楚。
      errors.push(original + '：' + (e as Error).message);
    }
  }
  if (files.length > MAX_UPLOAD_FILES) {
    errors.push('一次最多上传 ' + MAX_UPLOAD_FILES + ' 个文件，多余的已忽略。');
  }
  return { ok, errors };
}

/** 提交给 Agent 时用的那句话：告诉它文件在哪、以及"要主动读"。 */
export function uploadedFilesNote(files: UploadedFile[]): string {
  const lines = files.map(
    (f) => '- ' + f.name + ' (' + f.kind + ', ' + formatBytes(f.size) + ')',
  );
  return (
    '[UPLOADED FILES] The user uploaded ' + files.length + ' file(s) into your workspace. ' +
    'They are **not** in your context — read what you need with ws_read first:\n' +
    lines.join('\n')
  );
}

/** 从粘贴事件里挑出文件。**不按 MIME 过滤** —— 图片、文本、PDF 都要能进来。 */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  // 有些环境 items 是空的，但 files 里有 —— 兜一层。
  if (out.length === 0) {
    for (const f of Array.from(data.files ?? [])) out.push(f);
  }
  return out;
}

import {
  formatBytes,
  getEntry,
  kindOf,
  putEntry,
  validName,
  workspaceLimits,
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

/*
 * 单个上传文件的上限**来自设置**（设置 → 常规 → 工作区 → 单文件上限），
 * 与 ws_write / ws_run 共用同一个 workspaceLimits()。
 * 这里不再导出常量：上限是运行期可变的，导出快照只会让调用方拿到过期的数。
 */
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

export interface UploadedFailure {
  /** 原来那个文件 —— 失败时**要还给调用方**，让用户可以重试（而不是丢掉）。 */
  file: File;
  error: string;
}

export interface UploadResult {
  ok: UploadedFile[];
  /** 没进去的，带人能看懂的原因（字符串形式，便于直接显示）。 */
  errors: string[];
  /**
   * 失败的文件本身。
   *
   * 为什么要把 File 带回来：调用方（输入框）在失败时应当**保留这些文件**、
   * 把原因显示出来让用户重试；只给一句错误字符串的话，文件就悄悄消失了。
   */
  failed: UploadedFailure[];
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
  const failed: UploadedFailure[] = [];
  /** 记一条失败：错误字符串给人看，File 还给调用方重试。 */
  const reject = (file: File, error: string) => {
    errors.push((file.name || 'file') + '：' + error);
    failed.push({ file, error });
  };
  for (const file of files.slice(0, MAX_UPLOAD_FILES)) {
    const original = file.name || 'file';
    try {
      if (file.size === 0) {
        reject(file, '是空文件，跳过了。');
        continue;
      }
      const { file: maxFile } = await workspaceLimits();
      if (file.size > maxFile) {
        reject(file, formatBytes(file.size) + ' 超过单文件上限 ' + formatBytes(maxFile) + '。');
        continue;
      }
      const wanted = sanitizeFileName(original);
      // 起名 + 写入放在同一个临界区里，见下面 writeChain 的说明。
      const { name, entry } = await serialize(async () => {
        const picked = await uniqueName(wanted);
        const mime = file.type || '';
        const kind = kindOf(mime, picked);
        // 文本按 text 存（这样 ws_read 直接给文字、ws_run 读到的也是字符串）；
        // 其它一律存 blob（结构化克隆，不用 base64）。
        const made: WorkspaceEntry = {
          name: picked,
          kind,
          mime: mime || 'application/octet-stream',
          size: file.size,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(kind === 'text' ? { text: await file.text() } : { blob: file }),
        };
        // 文本用 text 字段时 size 要按实际字节算，免得与工作区用量对不上。
        if (typeof made.text === 'string') made.size = new TextEncoder().encode(made.text).length;
        await putEntry(made);
        return { name: picked, entry: made };
      });
      ok.push({
        name,
        // 占位名（image.png / blob…）不是用户起的名字，别把它当原名报出来。
        originalName: name === original || isPlaceholderName(original) ? undefined : original,
        kind: entry.kind,
        mime: entry.mime,
        size: entry.size,
      });
    } catch (e) {
      // 最常见的是"没有 IndexedDB，只能存文本" —— 那是环境限制，要说清楚。
      reject(file, (e as Error).message);
    }
  }
  if (files.length > MAX_UPLOAD_FILES) {
    errors.push('一次最多上传 ' + MAX_UPLOAD_FILES + ' 个文件；超出部分已忽略。');
  }
  return { ok, errors, failed };
}

/**
 * 上传前的**本地**检查：不碰存储，只回答"这个文件能不能收"。
 *
 * 输入框需要在用户还没发送时就能显示"这个文件收不了"（太大/空的），
 * 而不是等到发送那一刻才说 —— 那时用户已经在等结果了。
 */
export async function checkFileLocally(file: File): Promise<string | null> {
  if (file.size === 0) return '是空文件。';
  const { file: maxFile } = await workspaceLimits();
  if (file.size > maxFile) {
    return formatBytes(file.size) + ' 超过单文件上限 ' + formatBytes(maxFile) + '。';
  }
  return null;
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

/**
 * 上传串行化：**"起名"与"写入"必须连在一起**。
 *
 * uniqueName 做的是"查一下这个名字空着吗"，它与随后的 putEntry 之间隔着 await。
 * 两个上传并发时（用户连点两次发送、或两个输入框同时发），两边都会查到"空着"，
 * 于是同一个名字写两遍 —— 轻则一份被后写的覆盖（用户直接丢文件），
 * 重则同一张图在工作区里出现两次（看起来就是"重复上传"）。
 * 串起来之后，第二个上传会老老实实拿到 image-2。
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 浏览器给剪贴板图片的名字是**占位名**，不是文件名。
 *
 * 复制一张网页图片 / 截一张图之后，剪贴板里只有像素，没有"它叫什么"。
 * 浏览器只能现编一个：Chrome 给 `image.png`，有的平台干脆给 `image` 或 `blob`，
 * 甚至空字符串。直接拿来用，用户就会看到三个文件都叫 image —— 既看不懂，也分不清。
 */
const PLACEHOLDER_STEMS = new Set([
  '', 'image', 'imagefile', 'file', 'blob', 'clip', 'clipboard', 'paste', 'pasted', 'untitled', 'unnamed',
]);

/** 去掉最后一个扩展名后的主体（小写）。'image.PNG' -> 'image'，'a.b.png' -> 'a.b'。 */
function stemOf(name: string): string {
  const trimmed = (name || '').trim();
  const dot = trimmed.lastIndexOf('.');
  return (dot > 0 ? trimmed.slice(0, dot) : trimmed).toLowerCase();
}

/** 这个名字是不是浏览器的占位名（= 用户其实没给它起名字）。 */
export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_STEMS.has(stemOf(name));
}

/** 猜一个扩展名：先看原名，再看 MIME 子类型。 */
function extOfFile(file: File): string {
  const dot = (file.name || '').lastIndexOf('.');
  if (dot > 0) {
    const fromName = file.name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName;
  }
  const sub = (file.type || '').split('/')[1] || '';
  const fromMime = sub.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!fromMime) return /^image\//i.test(file.type) ? 'png' : 'bin';
  const alias: Record<string, string> = { jpeg: 'jpg', svgxml: 'svg', plain: 'txt', octetstream: 'bin', xmarkdown: 'md' };
  return alias[fromMime] ?? fromMime;
}

/** 现编名字用的序号：只在本次会话里递增，配合工作区的 uniqueName 足够唯一。 */
let clipSeq = 0;

/**
 * 给"没有名字"的剪贴板文件现编一个**不重复**的名字。
 *
 * 为什么必须在这一步做（而不是等上传时）：输入框里那一排待上传条目显示的就是 file.name，
 * 三个都叫 image.png 的话用户分不清哪个是哪个 —— **起名与显示必须是同一个名字**。
 *
 * 有真名字的文件一个字符都不动；拖进来的文件走另一条路，不会经过这里。
 */
export function nameClipboardFiles(files: File[]): File[] {
  return files.map((file) => {
    if (!isPlaceholderName(file.name)) return file;
    clipSeq += 1;
    const stem = /^image\//i.test(file.type) ? 'image' : 'clip';
    const named = stem + '-' + clipSeq + '.' + extOfFile(file);
    try {
      return new File([file], named, { type: file.type, lastModified: file.lastModified });
    } catch {
      // 极老的环境没有 File 构造器：宁可保留占位名，也不要让这次粘贴整个失败。
      return file;
    }
  });
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
  // 剪贴板文件没有真名字，带占位名的在这里换成互不相同的名字。
  return nameClipboardFiles(out);
}

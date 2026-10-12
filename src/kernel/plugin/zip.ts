/**
 * 极简 zip 读取器：只为了读 .graft（插件包）。
 *
 * 为什么自己写：浏览器没有原生"解 zip 目录"的 API，只能靠 DecompressionStream 解 deflate；
 * 而规范里我们把**默认压缩方式定为 stored（不压缩）** —— 那样读包就是读中央目录 + 取字节，
 * 不依赖任何浏览器 API，任何解压工具也都能打开我们的包。deflate 条目当兼容用（第三方打的包）。
 *
 * 安全：包是外部输入，所以这里有硬限制与路径检查（见 GUARDS）。宁可拒绝一个奇怪的包，
 * 也不要在解析器里留一个可以写到任意路径/把内存撑爆的口子。
 */
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 外部输入的硬限制：条目数、单文件、总大小、名字长度。 */
const GUARDS = { maxEntries: 64, maxFileBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxNameLen: 120 };

export interface ZipEntry { name: string; text: string }

export class ZipError extends Error {}

function u16(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8); }
function u32(b: Uint8Array, i: number): number { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }

/** 路径检查：不允许绝对路径、.. 、反斜杠、盘符 —— 防 zip slip。 */
export function safeEntryName(raw: string): string {
  const name = raw.replace(/\\\\/g, '/');
  if (!name || name.length > GUARDS.maxNameLen) throw new ZipError('非法文件名：' + raw);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new ZipError('不允许绝对路径：' + raw);
  const parts = name.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) throw new ZipError('不允许的路径：' + raw);
  return name;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!Ctor) throw new ZipError('这个环境不支持解压（DecompressionStream 缺失），请让插件包用不压缩的方式打包。');
  const ds = new Ctor('deflate-raw');
  // 复制成独立 buffer 再给 Blob：Uint8Array 的泛型在 TS 5.9 下不直接满足 BlobPart。
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * 读一个 zip，返回里面的文本文件。
 * 只处理 stored(0) 与 deflate(8)；其它压缩方式直接拒绝并说明原因，不做半吊子兼容。
 */
export async function readZip(input: Uint8Array): Promise<ZipEntry[]> {
  const b = input;
  if (b.length < 22) throw new ZipError('文件太小，不是 zip。');
  // 从尾部往前找 EOCD（末尾可能有注释，所以给 64KB 的搜索窗）。
  let eocd = -1;
  const from = Math.max(0, b.length - 65557);
  for (let i = b.length - 22; i >= from; i--) {
    if (u32(b, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('找不到 zip 目录（EOCD）：可能不是 zip，或者被截断了。');

  const count = u16(b, eocd + 10);
  const cdOffset = u32(b, eocd + 16);
  if (count > GUARDS.maxEntries) throw new ZipError('条目太多：' + count + '（上限 ' + GUARDS.maxEntries + '）。');
  if (cdOffset >= b.length) throw new ZipError('zip 目录偏移越界。');

  const out: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32(b, p) !== SIG_CENTRAL) throw new ZipError('zip 中央目录第 ' + (i + 1) + ' 条损坏。');
    const method = u16(b, p + 10);
    const compSize = u32(b, p + 20);
    const rawSize = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localAt = u32(b, p + 42);
    const name = safeEntryName(new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // 目录项，跳过
    if (rawSize > GUARDS.maxFileBytes) throw new ZipError(name + ' 太大（' + rawSize + ' 字节）。');
    total += rawSize;
    if (total > GUARDS.maxTotalBytes) throw new ZipError('解压后总量超过上限 ' + GUARDS.maxTotalBytes + ' 字节。');

    if (localAt + 30 > b.length || u32(b, localAt) !== SIG_LOCAL) throw new ZipError(name + ' 的本地头损坏。');
    const lNameLen = u16(b, localAt + 26);
    const lExtraLen = u16(b, localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const data = b.subarray(dataAt, dataAt + compSize);
    if (data.length < compSize) throw new ZipError(name + ' 的数据被截断。');

    if (method === 0) out.push({ name, text: new TextDecoder().decode(data) });
    else if (method === 8) out.push({ name, text: new TextDecoder().decode(await inflateRaw(data)) });
    else throw new ZipError(name + ' 用了不支持的压缩方式（' + method + '），只支持不压缩与 deflate。');
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 写出一个 **stored（不压缩）** 的 zip。确定性：条目顺序固定、时间戳固定为 0，
 * 这样同样的源码两次打包得到同样的字节 —— 哈希校验与"是否被改过"才答得清。
 */
export function writeZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of sorted) {
    const name = enc.encode(safeEntryName(e.name));
    const data = enc.encode(e.text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);      // version needed
    lv.setUint16(6, 0x0800, true);  // UTF-8 名字
    lv.setUint16(8, 0, true);       // stored
    lv.setUint16(10, 0, true);      // 时间（固定为 0 -> 确定性）
    lv.setUint16(12, 0x21, true);   // 日期（固定）
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    chunks.push(local);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, sorted.length, true);
  ev.setUint16(10, sorted.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

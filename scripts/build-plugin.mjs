#!/usr/bin/env node
/**
 * 把一个插件目录打成交付物：<公共目录>/<id>.graft（zip）与 <id>.json（单文件）。
 *
 * 用法：node scripts/build-plugin.mjs music-search
 *      （不带参数就打 plugins/ 下的全部）
 *
 * 这里**自己写一个极小 zip writer（stored 模式）**，是有意的：
 * - 默认不压缩是我们定的规范（读包就不必依赖 DecompressionStream），
 *   所以 writer 只需要"放字节 + 写目录"，几十行就够，不必引第三方库；
 * - 固定时间戳与排序 -> 同样的源码两次打包字节一致，哈希才有意义。
 *
 * 清单的完整校验在应用侧（src/kernel/plugin/package.ts），安装时与测试里都会跑；
 * 这里只做粗检，避免把一个明显缺字段的包发出去。
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** stored（不压缩）zip，确定性：条目按名字排序、时间戳固定为 0。 */
function zipStore(files) {
  const enc = new TextEncoder();
  const entries = files.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = enc.encode(e.text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    chunks.push(local);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
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
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

const args = process.argv.slice(2);
const root = 'plugins';
const dirs = args.length ? args : readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());

let failed = 0;
for (const dir of dirs) {
  const at = join(root, dir);
  const manifestRaw = readFileSync(join(at, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  for (const key of ['id', 'name', 'version', 'description', 'hosts', 'endpoints']) {
    if (manifest[key] === undefined) { console.error('[' + dir + '] manifest 缺少 ' + key); failed++; }
  }
  if (!Array.isArray(manifest.endpoints) || manifest.endpoints.length === 0) {
    console.error('[' + dir + '] 至少要有一个 endpoint'); failed++; continue;
  }
  const guidePath = join(at, 'guide.md');
  let guide = '';
  try { guide = readFileSync(guidePath, 'utf8'); } catch { console.warn('[' + dir + '] 没有 guide.md'); }

  const files = [{ name: 'manifest.json', text: manifestRaw }];
  if (guide) files.push({ name: 'guide.md', text: guide });
  const zip = zipStore(files);

  const outDir = 'public/plugins';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, manifest.id + '.graft'), zip);
  writeFileSync(
    join(outDir, manifest.id + '.json'),
    JSON.stringify({ format: 'yggdrasil.plugin', manifest, guide }, null, 2) + '\n',
  );
  console.log(
    '[' + manifest.id + '] -> ' + outDir + '/' + manifest.id + '.graft (' + zip.length + ' B)' +
      ' + .json (' + files.reduce((n, f) => n + f.text.length, 0) + ' 字符)',
  );
}
process.exit(failed ? 1 : 0);

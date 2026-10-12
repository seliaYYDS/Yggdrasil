#!/usr/bin/env node
/**
 * 给插件签名 / 验签。
 *
 * 用法：
 *   node scripts/sign-plugin.mjs keygen                    生成一对 Ed25519 密钥
 *   node scripts/sign-plugin.mjs sign <插件目录> <私钥文件>   算出包哈希并输出 signature 块
 *   node scripts/sign-plugin.mjs verify <插件目录>           按 manifest 里的签名验一遍
 *
 * 签的是"包内容哈希"（见 src/kernel/plugin/package.ts 的 packageHash）：
 * 包内所有文件按名字排序拼起来哈希，manifest.json 里的 signature 块不参与 ——
 * 否则签名会把自己算进去，永远验不过。所以**签完之后改任何一个文件都会导致验签失败**，
 * 这正是想要的：装的时候能发现"内容与签名不符"。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from 'node:crypto';

const ALLOWED = [/^manifest\.json$/, /^guide\.md$/, /^README\.md$/, /^tools\/[a-z][a-z0-9_-]{0,30}\.js$/, /^ui\/[a-z][a-z0-9_-]{0,30}\.tsx$/];

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

function loadPackage(dir) {
  const files = {};
  for (const name of walk(dir)) {
    if (!ALLOWED.some((re) => re.test(name))) {
      throw new Error('包里不允许有 ' + name);
    }
    files[name] = readFileSync(join(dir, name), 'utf8');
  }
  const manifest = JSON.parse(files['manifest.json']);
  return { manifest, files };
}

/** 与 packageHash 完全一致的算法。 */
function packageHash(manifest, files) {
  const { signature, ...rest } = manifest;
  const parts = [];
  for (const name of Object.keys(files).sort()) {
    parts.push(name + '\n' + (name === 'manifest.json' ? JSON.stringify(rest) : files[name]));
  }
  return createHash('sha256').update(parts.join('\n\0\n'), 'utf8').digest('hex');
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'keygen') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const out = { 'plugin-key.pub': pub.toString('base64'), 'plugin-key.priv': priv.toString('base64') };
  for (const [name, v] of Object.entries(out)) {
    writeFileSync(name, v + '\n');
    console.log('写好了 ' + name);
  }
  console.log('\n把 plugin-key.pub 的内容发给插件使用者，plugin-key.priv **不要外传**。');
} else if (cmd === 'sign') {
  const [dir, keyFile] = rest;
  if (!dir || !keyFile) { console.error('用法：sign <插件目录> <私钥文件>'); process.exit(1); }
  const { manifest, files } = loadPackage(dir);
  const hash = packageHash(manifest, files);
  const priv = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
  const key = createPrivateKeyFromRaw(priv);
  const sig = edSign(null, Buffer.from(hash, 'utf8'), key);
  const pub = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
  console.log('包哈希: ' + hash);
  console.log('\n把下面这段放进 manifest.json 的顶层：\n');
  console.log(JSON.stringify({ signature: { alg: 'ed25519', publicKey: pub.toString('base64'), value: sig.toString('base64') } }, null, 2));
} else if (cmd === 'verify') {
  const [dir] = rest;
  const { manifest, files } = loadPackage(dir);
  const hash = packageHash(manifest, files);
  const s = manifest.signature;
  if (!s) { console.log('这个包没有签名。哈希：' + hash); process.exit(0); }
  const pub = Buffer.from(s.publicKey, 'base64');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
  const ok = edVerify(null, Buffer.from(hash, 'utf8'), key, Buffer.from(s.value, 'base64'));
  console.log(ok ? '签名有效 ✓ 哈希 ' + hash : '签名**无效** ✗');
  process.exit(ok ? 0 : 1);
} else {
  console.log('用法：keygen | sign <插件目录> <私钥文件> | verify <插件目录>');
}

/** 从原始 32 字节私钥造出 KeyObject（PKCS#8 的 Ed25519 前缀是固定的）。 */
function createPrivateKeyFromRaw(raw) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}



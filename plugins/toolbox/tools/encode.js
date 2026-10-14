/**
 * 编码 / 摘要。**为什么需要**：几件事模型几乎算不对，而做错时又不容易被发现 ——
 * base64（用来拼 data: URI 把工作区文件嵌进组件）、URL 编码、
 * 十六进制、以及 sha256 校验和。
 *
 * sha256 是**自带实现**，不走 crypto.subtle：subtle 只在安全上下文（https / localhost）里存在，
 * 而这个应用可能跑在局域网 http 上 —— 那种环境下工具会突然不可用，比慢一点糟得多。
 */
async (args, ctx) => {
  const OPS = ['base64_encode','base64_decode','url_encode','url_decode','hex_encode','hex_decode','sha256','length'];
  const op = String(args.op || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const text = String(args.text ?? '');
  if (!op) throw new Error('op 是空的。可用：' + OPS.join(', '));
  if (!text && op !== 'sha256') throw new Error('text 是空的。');
  if (text.length > 200000) throw new Error('text 太长（' + text.length + '，上限 200000）。');

  const enc = new TextEncoder();
  const bytesOf = (s) => enc.encode(s);
  const strOf = (b) => new TextDecoder().decode(b);

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b64encode = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
      out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
      out += b2 === undefined ? '=' : B64[b2 & 63];
    }
    return out;
  };
  const b64decode = (s) => {
    const clean = s.replace(/[\s=]/g, '');
    const out = [];
    let buf = 0, bits = 0;
    for (const ch of clean) {
      const v = B64.indexOf(ch);
      if (v < 0) throw new Error('不是合法的 base64（遇到字符 "' + ch + '"）。');
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); }
    }
    return new Uint8Array(out);
  };

  /** 紧凑 sha256（FIPS 180-4）。纯 JS 是为了不依赖安全上下文。 */
  const sha256 = (bytes) => {
    const K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const l = bytes.length;
    const withPad = new Uint8Array((((l + 9) >> 6) + 1) << 6);
    withPad.set(bytes);
    withPad[l] = 0x80;
    // 长度按位写在最后 8 字节（大端）。用两个 32 位半字，避免超出 Number 精度。
    const bitsHi = Math.floor((l * 8) / 4294967296);
    const bitsLo = (l * 8) >>> 0;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 8, bitsHi);
    dv.setUint32(withPad.length - 4, bitsLo);
    const w = new Array(64);
    for (let off = 0; off < withPad.length; off += 64) {
      for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i += 1) {
        const s0 = (w[i-15] >>> 7 | w[i-15] << 25) ^ (w[i-15] >>> 18 | w[i-15] << 14) ^ (w[i-15] >>> 3);
        const s1 = (w[i-2] >>> 17 | w[i-2] << 15) ^ (w[i-2] >>> 19 | w[i-2] << 13) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i += 1) {
        const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [(H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,(H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0];
    }
    return H.map((x) => x.toString(16).padStart(8, '0')).join('');
  };

  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => {
    const clean = s.replace(/[\s]/g, '');
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error('不是合法的十六进制（长度要是偶数、只含 0-9a-f）。');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  };

  const run = {
    base64_encode: () => b64encode(bytesOf(text)),
    base64_decode: () => {
      const s = strOf(b64decode(text));
      // 解出来不是可读文本时如实说明：二进制该走工作区，不该塞进上下文。
      return /[\u0000-\u0008\u000e-\u001f]/.test(s) ? '(解出来是二进制，' + s.length + ' 字符，不适合放进文本上下文)' : s;
    },
    url_encode: () => encodeURIComponent(text),
    url_decode: () => decodeURIComponent(text),
    hex_encode: () => hex(bytesOf(text)),
    hex_decode: () => strOf(unhex(text)),
    sha256: () => sha256(bytesOf(text)),
    length: () => ({ chars: text.length, utf8Bytes: bytesOf(text).length }),
  };
  if (!Object.prototype.hasOwnProperty.call(run, op)) throw new Error('不认识的 op：' + op + '。可用：' + OPS.join(', '));

  let result;
  try { result = run[op](); }
  catch (e) { throw new Error(op + ' 失败：' + e.message); }

  ctx.log(op + ' → ' + String(typeof result === 'string' ? result.length + ' 字符' : 'ok'));
  return { op, result, byteLength: typeof result === 'string' ? bytesOf(result).length : undefined };
}

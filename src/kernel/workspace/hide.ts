/**
 * **大内容隐藏协议**：回读里出现超长内容（尤其是嵌入的图片、音频这类二进制）时，
 * 不把内容本身塞进上下文，而是换成一枚**带序号的占位**，并说清三件事：
 * 这是什么、为什么被隐藏、想读它该调哪个工具。
 *
 * 为什么必须有它：组件源码一旦嵌入了图片，就是几百 KB 的 base64。
 * 直接回灌的后果有两个，而且都很难查：
 * ① 一次就吃掉整个观察预算（当前 64000 字符封顶），别的结果全被挤掉；
 * ② 截断是**按字符数**切的 —— 会把 base64 从中间腰斩，得到一段既不是合法数据、
 *    又让人误以为"已经看到全部"的字符串。
 * 所以这里改成**整块隐藏 + 给一个取回的手柄**，而不是截断。
 *
 * 序号在**会话内**稳定且单调递增：Agent 下一轮用 ws_hidden 把它取回来。
 */

export interface HiddenPiece {
  /** 给模型看的序号（1 起，会话内唯一）。 */
  ref: number;
  /** 这是什么（例如 "image data (base64)"）。 */
  what: string;
  /** 藏在里面的具体是哪一段（例如组件名）。 */
  detail?: string;
  /** 字符数（说明它有多大）。 */
  chars: number;
  /** 想读它该怎么做 —— 必须是一句能照做的话。 */
  how: string;
  /** 取回时用：内容本身。 */
  text: string;
  /** 取回时用：图片要走多模态，才能真的被"看到"。 */
  mime?: string;
}

/** 超过这个长度的「内容型」文本就会被隐藏（不是截断）。 */
export const HIDE_THRESHOLD = 2000;

/** 一次回读里最多允许几枚占位（防止一屏全是占位）。 */
export const MAX_HIDDEN = 8;

let nextRef = 1;
const registry = new Map<number, HiddenPiece>();

/** 取一个序号对应的内容（ws_hidden 用）。 */
export function hiddenPiece(ref: number): HiddenPiece | undefined {
  return registry.get(ref);
}

/** 会话清空时一起清掉（序号是会话内的）。 */
export function resetHidden(): void {
  nextRef = 1;
  registry.clear();
}

/**
 * 只隐藏"看起来是一整块数据"的长片段（data URL、超长无空白串）。
 *
 * 为什么不只按长度：正常源码里也可能有很长的段落，但它有换行、有结构，
 * 隐藏它反而让模型看不懂；而这两种是"一整块载荷"，隐藏它不损失任何结构信息。
 */
const DATA_URL_RE = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)?;base64,[A-Za-z0-9+/=]{500,}/g;

export interface HideResult {
  text: string;
  hidden: HiddenPiece[];
}

function whatFor(mime: string): string {
  if (mime.startsWith('image/')) return 'image data (base64)';
  if (mime.startsWith('audio/')) return 'audio data (base64)';
  if (mime.startsWith('video/')) return 'video data (base64)';
  return 'embedded binary data (base64)';
}

/** 把超长载荷换成占位；sourceLabel 说明这段文本来自哪里（会写进占位里）。 */
export function hideLongPayload(text: string, sourceLabel?: string): HideResult {
  const hidden: HiddenPiece[] = [];
  if (text.length <= HIDE_THRESHOLD) return { text, hidden };

  const piece = (match: string, mime: string, label: string): string => {
    if (hidden.length >= MAX_HIDDEN) return match;
    const ref = nextRef++;
    const p: HiddenPiece = {
      ref,
      what: label,
      detail: sourceLabel,
      chars: match.length,
      how: 'call ws_hidden(ref: ' + ref + ') to read it back',
      text: match,
      mime: mime || undefined,
    };
    registry.set(ref, p);
    hidden.push(p);
    return (
      '[#' + ref + ' ' + label + (sourceLabel ? ' in ' + sourceLabel : '') + ' — ' + match.length +
      ' characters, hidden on purpose: it is too large to put in your context, and cutting it in half would ' +
      'leave you a broken value, so it was left out whole. ' + p.how + ']'
    );
  };

  let out = text.replace(DATA_URL_RE, (m: string, mime: string) => piece(m, mime ?? '', whatFor(mime ?? '')));
  /*
   * 第二段：处理**不是 data URL** 的超长无空白串（其他 base64、压缩串、加密串）。
   *
   * 只在整体明显超长时才启用（阈值×4）—— 这一条是刻意的：
   * 普通长文本（有空格有换行）不该被当成载荷；只有"长到不正常 + 里面真有一大坨无空白串"
   * 才值得隐藏。判松了会把正常的文档也藏起来，那才是帮倒忙。
   */
  if (out.length > HIDE_THRESHOLD * 4) {
    out = out.replace(/[A-Za-z0-9+/=]{3000,}/g, (m) => piece(m, '', 'long encoded blob'));
  }
  return { text: out, hidden };
}

/** 把隐藏说明拼成人能读懂的一段。 */
export function describeHidden(pieces: HiddenPiece[]): string {
  if (pieces.length === 0) return '';
  return pieces
    .map((p) => '[#' + p.ref + '] ' + p.what + (p.detail ? ' (' + p.detail + ')' : '') + ' — ' + p.chars + ' characters, hidden.')
    .join('\n');
}
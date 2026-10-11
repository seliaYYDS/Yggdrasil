/**
 * 窗口排布用的纯几何计算。
 *
 * 放在单独文件里，是因为 `update_component`（单窗口）与 `arrange_windows`（批量）都要用，
 * 而它们分别在两个接口模块里。这里不注册任何接口、不碰 store。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 普通窗口的尺寸下限，与 WindowFrame 的 minW / minH 对齐。 */
export const WIN_MIN_W = 200;
export const WIN_MIN_H = 120;

/** 窗口之间、以及窗口与视口边缘的留白。 */
export const GAP = 16;
export const MARGIN = 12;

/** 夹进视口：不低于最小尺寸、不超出视口、左上角不越界。 */
export function clampRect(r: Rect, viewW: number, viewH: number): Rect {
  const maxW = Math.max(WIN_MIN_W, viewW - MARGIN * 2);
  const maxH = Math.max(WIN_MIN_H, viewH - MARGIN * 2);
  const w = Math.min(Math.max(Math.round(r.w), WIN_MIN_W), maxW);
  const h = Math.min(Math.max(Math.round(r.h), WIN_MIN_H), maxH);
  return {
    x: Math.max(0, Math.min(Math.round(r.x), Math.max(0, viewW - w))),
    y: Math.max(0, Math.min(Math.round(r.y), Math.max(0, viewH - h))),
    w,
    h,
  };
}

export function centerRect(r: Rect, viewW: number, viewH: number): Rect {
  const base = clampRect(r, viewW, viewH);
  return {
    ...base,
    x: Math.max(0, Math.round((viewW - base.w) / 2)),
    y: Math.max(0, Math.round((viewH - base.h) / 2)),
  };
}

/** 铺满视口（留一圈边距）。 */
export function fillRect(viewW: number, viewH: number): Rect {
  return clampRect({ x: MARGIN, y: MARGIN, w: viewW - MARGIN * 2, h: viewH - MARGIN * 2 }, viewW, viewH);
}

export type Align = 'left' | 'right' | 'top' | 'bottom' | 'center';

export function alignRect(r: Rect, align: string, viewW: number, viewH: number): Rect {
  const base = clampRect(r, viewW, viewH);
  switch (align as Align) {
    case 'left':
      return { ...base, x: MARGIN };
    case 'right':
      return { ...base, x: Math.max(0, viewW - base.w - MARGIN) };
    case 'top':
      return { ...base, y: MARGIN };
    case 'bottom':
      return { ...base, y: Math.max(0, viewH - base.h - MARGIN) };
    case 'center':
      return centerRect(base, viewW, viewH);
    default:
      return base;
  }
}

/** 网格：按窗口数取一个尽量方的格子，每个窗口占一格。 */
export function gridLayout(count: number, viewW: number, viewH: number): Rect[] {
  if (count <= 0) return [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cols2 = Math.min(cols, count);
  const rows2 = Math.min(rows, count);
  const cellW = Math.floor((viewW - GAP * (cols2 + 1)) / cols2);
  const cellH = Math.floor((viewH - GAP * (rows2 + 1)) / rows2);
  const out: Rect[] = [];
  for (let i = 0; i < count; i += 1) {
    const c = i % cols2;
    const r = Math.floor(i / cols2);
    out.push(
      clampRect(
        { x: GAP + c * (cellW + GAP), y: GAP + r * (cellH + GAP), w: cellW, h: cellH },
        viewW,
        viewH,
      ),
    );
  }
  return out;
}

/** 层叠：每个窗口比前一个右下偏移一点，像窗口管理器那样错开。 */
export function cascadeLayout(count: number, viewW: number, viewH: number): Rect[] {
  const w = Math.min(620, Math.max(WIN_MIN_W, Math.round(viewW * 0.46)));
  const h = Math.min(460, Math.max(WIN_MIN_H, Math.round(viewH * 0.52)));
  const out: Rect[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(clampRect({ x: 44 + i * 34, y: 56 + i * 30, w, h }, viewW, viewH));
  }
  return out;
}

/** 叠放：全部摆在正中央、互相重叠，靠层级区分。 */
export function stackLayout(count: number, viewW: number, viewH: number): Rect[] {
  const w = Math.min(680, Math.max(WIN_MIN_W, Math.round(viewW * 0.56)));
  const h = Math.min(520, Math.max(WIN_MIN_H, Math.round(viewH * 0.6)));
  const r = centerRect({ x: 0, y: 0, w, h }, viewW, viewH);
  return Array.from({ length: Math.max(0, count) }, () => ({ ...r }));
}

export const ARRANGE_MODES = ['grid', 'cascade', 'stack'] as const;

export function layoutFor(mode: string, count: number, viewW: number, viewH: number): Rect[] | null {
  if (mode === 'grid') return gridLayout(count, viewW, viewH);
  if (mode === 'cascade') return cascadeLayout(count, viewW, viewH);
  if (mode === 'stack') return stackLayout(count, viewW, viewH);
  return null;
}

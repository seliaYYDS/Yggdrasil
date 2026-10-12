import type { ActCap } from '../types';

/**
 * 能力开关的**唯一定义处**。
 *
 * 三处都读这一份：提示词裁剪、接口目录过滤、执行时拒绝。
 * 各写一份清单迟早会走偏（某个接口在提示词里没有、但执行时放行，或者反过来）。
 */

/** 全部开关。desktop 是 act 档的基线，其余都要显式给。 */
export const ALL_CAPS: ActCap[] = ['desktop', 'style', 'global', 'net', 'browser', 'agents', 'tools'];

/** 中文名，用在错误信息与能力摘要里。 */
export const CAP_LABELS: Record<ActCap, string> = {
  desktop: 'desktop operations',
  style: 'local styling',
  global: 'global changes',
  net: 'networking',
  browser: 'browser and screen capture',
  agents: 'derived agents',
  tools: 'derived tools',
};

/** 提示词里的能力摘要用一句话说明它到底能干什么。 */
export const CAP_HINTS: Record<ActCap, string> = {
  desktop: 'create / change / delete components, set window state and layout, inspect the interface',
  style: 'change the style variables of one single component (set_node_tokens)',
  global: 'change the whole theme (update_theme) and the host surface slots (background / title bar / page overlay)',
  net: 'fetch pages and images (fetch_url / fetch_image)',
  browser: 'drive the user real browser tabs (browser_*, capture_screen)',
  agents: 'attach / detach agent capability and configure other agents',
  tools: 'derive new tool functions and call them',
};

/**
 * 新建 act 档 Agent 的默认开关。
 *
 * **刻意最小**：能画界面、能调自己窗口的样式就够了。
 * 需要联网 / 浏览器 / 派生 / 全局修改的，由创建者在创建时显式加上 ——
 * 不给就接不到对应的提示词，也调不动对应的接口。
 * 老数据没有 caps 字段，走"全开"（行为不变）。
 */
export const DEFAULT_ACT_CAPS: ActCap[] = ['desktop', 'style'];

/** 一个开关是否开着。`caps === undefined` 表示全开（基底 Agent 与老数据）。 */
export function capsAllow(caps: ActCap[] | undefined, cap: ActCap): boolean {
  return !caps || caps.includes(cap);
}

/**
 * 解析创建 / 配置指令里给的 caps。
 * 认不出来的字符串忽略（不报错），给出空数组时按"一个开关都没开"处理 ——
 * 但 desktop 是 act 档的基线，会被自动补上。
 */
export function parseCaps(raw: unknown): ActCap[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const set = new Set<ActCap>();
  for (const x of raw) {
    if (typeof x === 'string' && (ALL_CAPS as string[]).includes(x)) set.add(x as ActCap);
  }
  set.add('desktop');
  return ALL_CAPS.filter((c) => set.has(c));
}

/** 人类可读的能力摘要。 */
export function capSummary(caps: ActCap[]): string {
  if (caps.length === 0) return '(none)';
  return caps.map((c) => CAP_LABELS[c] ?? c).join('、');
}

/**
 * `global` 能力与受限作用域是**矛盾**的：受限 Agent 调 update_theme / replace_surface
 * 一定会被作用域拦下（见 derivationBus），所以别给它这项能力。
 *
 * 在**创建 / 配置时**就报出来 —— 那是唯一能一次说清"要么放开作用域、要么去掉开关"的地方。
 * 返回 null 表示没问题。
 */
export function capScopeConflict(
  caps: ActCap[] | undefined,
  scope: string[] | '*' | undefined,
): string | null {
  if (!caps || !caps.includes('global')) return null;
  if (scope === '*') return null;
  return (
    'The "global" capability requires an **unrestricted scope**: set scope to "*", or drop this switch.' +
    'A scoped agent calling update_theme / replace_surface is rejected by the scope check, so granting it is wasted.'
  );
}

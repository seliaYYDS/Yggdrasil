import type { ThemeTokens } from '../kernel/types';

/**
 * 默认样式变量：扁平化。
 * 只用金黄色描边 + 暗棕色填充，不加阴影与高光。
 * 这不是一个"主题"实体，只是 Agent 可随时改写的接口的初值。
 */
export const DEFAULT_TOKENS: ThemeTokens = {
  '--ygg-bg': '#1A120B',
  '--ygg-surface': '#241811',
  '--ygg-surface-2': '#33231A',
  '--ygg-border': '#D4A537',
  '--ygg-accent-dim': '#7A6224',
  '--ygg-fg': '#F0E2C8',
  '--ygg-fg-muted': '#A08F76',
  '--ygg-accent': '#D4A537',
  '--ygg-accent-hi': '#F5D77A',
  '--ygg-glow': 'none',
  '--ygg-shadow': 'none',
  '--ygg-radius': '4px',
  '--ygg-danger': '#C4553B',
  '--ygg-ok': '#7FA65A',
  /*
   * 字体：世界树 = 古树 / 刻痕 / 史诗。
   * 主字体是**霞鹜文楷（LXGW WenKai TC）**，由 `@font-face` 从本地文件加载
   * （见 src/styles/tokens.css，文件在 public/fonts/）。
   * 后面那一串是回退：拉丁衬线在前、中文衬线在后 —— 反过来的话拉丁字母会用中文字体画。
   * 全部本地资源，不依赖网络与地区。
   */
  '--ygg-font':
    '"LXGW WenKai TC", ' +
    '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, Cambria, ' +
    '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, SimSun, ' +
    '"Times New Roman", serif',
  /** 标题用：同一个楷体，配拉开的字距区分层级；回退到更古老的衬线。 */
  '--ygg-font-display':
    '"LXGW WenKai TC", "Trajan Pro", Cinzel, "Palatino Linotype", "Book Antiqua", Palatino, Georgia, ' +
    '"Source Han Serif SC", "Songti SC", STSong, SimSun, serif',
  '--ygg-font-mono':
    '"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", Consolas, "Courier New", ui-monospace, monospace',
};

/**
 * 允许被 Agent 改写的令牌白名单。
 * 未列入的 CSS 变量（例如动效时长）一律拒绝，否则生成指令可以改掉交互动效。
 */
export const THEMEABLE_KEYS: string[] = Object.keys(DEFAULT_TOKENS);

const THEMEABLE = new Set(THEMEABLE_KEYS);

export const TOKEN_KEYS = THEMEABLE_KEYS;

export function isTokenKey(key: string): boolean {
  return THEMEABLE.has(key);
}

/** 只保留白名单内的令牌，值做最基本的长度裁剪。 */
export function sanitizeTokens(tokens: ThemeTokens): ThemeTokens {
  const out: ThemeTokens = {};
  for (const [k, v] of Object.entries(tokens ?? {})) {
    if (!THEMEABLE.has(k)) continue;
    if (typeof v !== 'string') continue;
    out[k] = v.slice(0, 300);
  }
  return out;
}

export function applyTheme(tokens: ThemeTokens): void {
  const root = document.documentElement;
  for (const key of TOKEN_KEYS) root.style.removeProperty(key);
  for (const [k, v] of Object.entries(DEFAULT_TOKENS)) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(tokens)) {
    if (!THEMEABLE.has(k)) continue;
    root.style.setProperty(k, v);
  }
}

export function mergeTokens(base: ThemeTokens, patch: ThemeTokens): ThemeTokens {
  return { ...base, ...patch };
}

/**
 * 只保留"和默认值不一样"的令牌。
 *
 * 持久化必须存**差异**而不是整份令牌表。存整份的话，以后改默认值对老用户完全无效 ——
 * 他们本地存着旧默认值，hydrate 时又把它盖回默认值上（而且是写成 <html> 的行内样式，
 * 优先级高于 tokens.css 的 :root）。字体换了却只看到英文变，就是这个原因。
 */
export function diffTokens(tokens: ThemeTokens): ThemeTokens {
  const out: ThemeTokens = {};
  for (const [k, v] of Object.entries(tokens ?? {})) {
    if (!THEMEABLE.has(k)) continue;
    if (DEFAULT_TOKENS[k] === v) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 历史上当过默认值的令牌值。
 *
 * 老用户的存储里可能留着这些值 —— 那不是他们的选择，只是当时被存下来的默认值。
 * 按值精确比对后丢掉，这样新默认值能生效，而**用户自己改过**的值会被保留。
 * 以后每次改 DEFAULT_TOKENS 里的样式，把旧值补进来即可。
 */
const SUPERSEDED_DEFAULTS: Record<string, string[]> = {
  '--ygg-font': [
    'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, Cambria, ' +
      '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, SimSun, ' +
      '"Times New Roman", serif',
  ],
  '--ygg-font-display': [
    '"Trajan Pro", Cinzel, "Palatino Linotype", "Book Antiqua", Palatino, Georgia, ' +
      '"Source Han Serif SC", "Songti SC", STSong, SimSun, serif',
  ],
};

/**
 * 比较字体栈时忽略格式差异：引号、逗号前后空格、多余空白、大小写。
 * 持久化里的值可能被压缩器改写格式，光比字符串会漏。
 */
function normalizeFontValue(v: string): string {
  return v
    .replace(/["']/g, '')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 丢掉"等于某个历史默认值"的持久化令牌。 */
export function migrateTokens(tokens: ThemeTokens): ThemeTokens {
  const out: ThemeTokens = { ...tokens };
  for (const [key, olds] of Object.entries(SUPERSEDED_DEFAULTS)) {
    const cur = out[key];
    if (typeof cur !== 'string') continue;
    const n = normalizeFontValue(cur);
    if (olds.some((o) => normalizeFontValue(o) === n)) delete out[key];
  }
  return out;
}

import type { ActCap, PluginPage, PluginPromptPatch } from '../types';

/**
 * 插件（plugin）的包格式与运行时类型。
 *
 * 一个插件 = 一份**不执行就能读懂**的清单 + 一份给模型看的指南（+ 之后才会有的 js 工具）。
 * 这个文件只描述"插件长什么样"，不做校验、不做装载 —— 那两件事在 package.ts 与 runtime.ts。
 *
 * 为什么第一个版本只有**声明式 HTTP 端点**、没有 js：
 * 任意 js 要与主页面隔离（Worker）才谈得上安全，那是下一步；而"搜索一个 API、拿回 JSON"
 * 这类需求用声明就够了。先把包格式、授权、权限、提示词成本这几件难事跑通，
 * 再决定要不要开代码执行这个口子。
 */
export interface PluginField {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  /**
   * text（默认）会 URL 编码后插入；**url 会原样插入**。
   *
   * 存在的理由：像"自建 API 地址"这种值，编码进模板就废了（~~http://x~~ 变成 ~~http%3A%2F%2Fx~~）；
   * 而且地址这种值还必须能**出现在 hosts 白名单里** —— 见 hosts 的说明。
   */
  type?: 'text' | 'url';
  /**
   * 必填。**只有标了 required 的字段为空时才会拦住调用** ——
   * 否则"可选的 Cookie"会因为没填而让整个插件不能用。
   */
  required?: boolean;
  /** 密钥类字段（界面上遮住输入，也不写进日志/场景）。 */
  secret?: boolean;
  /** 没填时用它。 */
  default?: string;
}

export interface PluginParam {
  name: string;
  description: string;
  required?: boolean;
  /** 缺省值（模型不给参数时用它）。 */
  default?: string;
}

export interface PluginEndpoint {
  /** 端点名（插件内唯一，全小写字母数字连字符）。op kind 会被拼成 <插件id>.<名字>。 */
  name: string;
  /** 一行摘要，进度面板与提示词里用它。 */
  label: string;
  /** 给模型的说明：干什么、参数怎么给、返回里哪些字段有用。 */
  description: string;
  method?: 'GET' | 'POST';
  /**
   * 请求地址模板。可以写 {参数名} 与 {config:字段名}，两者都会被 URL 编码后替换。
   * **地址来自清单，模型碰不到** —— 模型只能给声明过的参数值，这样就不可能被指使去打别的地址。
   */
  url: string;
  params?: PluginParam[];
  /** 附加请求头，值可以写 {config:字段名}（例如 Authorization）。 */
  headers?: Record<string, string>;
  /** 需要哪个能力开关，默认 net。 */
  cap?: ActCap | null;
  /**
   * 只挑出要看的字段，别把整个响应灌进上下文。
   *
   * 写法是点路径，数组段末尾加 []：'results[].previewUrl' 表示"results 数组里每一项的 previewUrl"。
   * 建议把总数之类的字段也挑上（例如 resultCount），否则"0 条"与"字段没挑对"在回读里长得一样。
   * 有 pick 时返回的是挑出来的小对象；没有就返回原始正文（再按 maxChars 截断）。
   */
  pick?: string[];
  /** 返回文本超过这个长度就截断（默认 8000）。 */
  maxChars?: number;
  /**
   * 返回空结果时追加给模型的一句提示（例如"换个市场再试"）。
   *
   * 为什么需要它：这次实测暴露的问题——搜索返回 0 条，模型只能猜到"可能拼错了"然后瞎试。
   * 插件最清楚"空了通常意味着什么"，所以让它自己写这句话。
   */
  emptyHint?: string;
  /**
   * POST 时**只把这些参数**放进 JSON 请求体（默认全部）。
   * 路径参数（owner / repo）不该混进 body。
   */
  body?: string[];
  /** 会不会改到外部数据（只影响反馈措辞）。 */
  mutates?: boolean;
  example?: Record<string, unknown>;
}

/**
 * 插件自带的 **js 工具**。
 *
 * 它不在主页面里跑，而是在一个 Worker 里跑 —— 那个 Worker **没有网络**：
 * 全局的 fetch / XMLHttpRequest / WebSocket / importScripts 在进入工具前被抹掉，
 * 唯一的出口是 ~~ctx.fetch()~~，由父窗口校验主机白名单之后代为执行。
 * 所以"插件能访问哪些主机"这条墙对 js 工具同样成立，而不是只对声明式端点成立。
 */
export interface PluginTool {
  /** 工具名（插件内唯一），op kind 是 <插件id>.<名字>。 */
  name: string;
  label: string;
  description: string;
  /** 包内路径，必须形如 tools/xxx.js。 */
  file: string;
  params?: PluginParam[];
  /**
   * 这个工具**怎么被 Agent 使用**（默认 'op'，向后兼容）：
   *
   * - `'op'` —— 注册成一个 op（kind 就是 `<插件id>.<名字>`）。适合"一步做完一件事"：
   *   模型直接把它当操作调用，不需要先知道有哪些工具。**这是老行为，插件不用改。**
   * - `'tool'` —— 注册成一个**真工具**，出现在提示词的 `## Available tools` 里，
   *   由 `call_tool` 调用。与内置工具（calc / now / random）和 Agent 自己用 create_tool
   *   造的工具**完全同列**。适合"可复用的原子能力"：模型看得见它的参数 schema、
   *   能在一轮里调多次、结果和派生工具一样走完整回灌。
   *
   * 两者都能用；区别只是"模型怎么发现它、拿什么调它"。同一个工具也可以同时给两种？
   * 不 —— 那会在提示词里出现两份说明、模型两条路都能走，反而容易写错。选一个。
   */
  exposeAs?: 'op' | 'tool';
  /**
   * exposeAs: 'tool' 时的参数 schema（JSON Schema）。**不写就按 params 自动生成一个**。
   *
   * 工具目录（## Available tools）里展示的就是它 —— 有 schema 模型才知道参数类型。
   */
  paramsSchema?: Record<string, unknown>;
  cap?: ActCap | null;
  /** 执行上限，默认 8000ms，最多 30000ms（超时就终止 Worker）。 */
  timeoutMs?: number;
  mutates?: boolean;
  example?: Record<string, unknown>;
}

/**
 * 插件自带的**界面**：一个 TSX 模块，和普通组件源码同一种契约
 * （export default 一个函数组件，可以 import react 与 "yggdrasil"）。
 *
 * 它没有 props —— 渲染时是 ~~<C />~~。需要数据的话，Agent 调 plugin_ui 时传的 data
 * 会被注入成模块顶层的常量 ~~data~~，组件直接读它即可。
 */
export interface PluginUi {
  name: string;
  label: string;
  description: string;
  /** 包内路径，必须形如 ui/xxx.tsx。 */
  file: string;
  /** data 里能放什么（写给模型看）。 */
  dataDoc?: string;
  example?: Record<string, unknown>;
}

/** 签名块：对"包内容哈希"的签名（算法目前只支持 ed25519）。 */
export interface PluginSignature {
  alg: 'ed25519';
  /** 原始 32 字节公钥的 base64。 */
  publicKey: string;
  /** 对 packageHash 的 64 字节签名，base64。 */
  value: string;
  /** 签名者自称的名字，只用于显示，不参与验证。 */
  signer?: string;
}

export interface PluginManifest {
  /** 全小写字母数字与连字符，作为 op kind 的前缀。 */
  id: string;
  name: string;
  version: string;
  /** 需要的最低应用版本（比对 package.json 的 version）。 */
  minAppVersion?: string;
  author?: string;
  description: string;
  /**
   * 允许访问的主机名白名单（精确域名或后缀）。
   * **这是插件的出口墙**：执行时按最终地址校验，不在名单里直接拒绝。
   *
   * 条目可以写 ~~"{config:base_url}"~~ —— 表示"主机由用户填的字段决定"。
   * 这是给"自建服务"这类插件的：地址是用户自己起的，不可能写死在清单里。
   * 被引用的字段必须是 type: "url"。
   */
  hosts: string[];
  /** 用户可以填的字段（密钥或配置）。 */
  fields?: PluginField[];
  endpoints: PluginEndpoint[];
  tools?: PluginTool[];
  ui?: PluginUi[];
  /** 对系统提示词段落的改动（插入 / 替换 / 删除）。可寻址的段落 id 见 prompts 的 PROMPT_SECTIONS。 */
  prompts?: PluginPromptPatch[];
  /** 自带**默认页面**：每个页面变成工具栏上的一个按钮 + 一个常驻窗口。 */
  pages?: PluginPage[];
  /** 有签名时装机前会验一遍；验不过直接拒绝安装。 */
  signature?: PluginSignature;
  /**
   * 版本更新：一个返回 ~~{"version": "2.0", "url": "https://…/x.graft"}~~ 的地址。
   * **它的主机必须在 hosts 白名单里** —— 不给插件新开一个网络出口。
   */
  update?: { url: string };
  /** guide.md 的内容，装载时填进来。 */
  guide?: string;
}

/** 解析出来但还没安装的包。 */
export interface PluginPackage {
  manifest: PluginManifest;
  /** 包内文件（相对路径 -> 文本内容）。 */
  files: Record<string, string>;
  /** 包内容哈希（十六进制），用于"装的是哪一份"与更新检测。 */
  hash: string;
  /** 签名状态（bad 的包在解析时就被拒了）。 */
  signature: 'none' | 'ok' | 'unsupported';
  /** 签名者公钥指纹（前 16 位十六进制）。 */
  fingerprint?: string;
}

/** 已安装的插件：清单 + 用户填的值 + 开关状态。 */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  author?: string;
  description: string;
  hosts: string[];
  fields: PluginField[];
  endpoints: PluginEndpoint[];
  tools: PluginTool[];
  ui: PluginUi[];
  prompts: PluginPromptPatch[];
  pages: PluginPage[];
  guide: string;
  /** 包内文件（tools/*.js、ui/*.tsx 的源码）。 */
  files: Record<string, string>;
  /** 安装时算出来的包内容哈希（十六进制）。 */
  hash: string;
  /** 签名状态：none 没有签名 / ok 验过 / unsupported 环境验不了 / bad 验不过（不会装进来）。 */
  signature: 'none' | 'ok' | 'unsupported';
  /** 签名者公钥指纹（前 16 位十六进制），只用于显示。 */
  fingerprint?: string;
  enabled: boolean;
  installedAt: string;
  /** 从哪来的（文件名或 URL），只用于界面展示。 */
  source: string;
  /** 版本更新地址（清单里的 update.url，装的时候记下来）。 */
  update?: { url: string };
  /** 用户填的值（含密钥）。**不进 .seed、不进提示词。** */
  values: Record<string, string>;
}

export const PLUGIN_FORMAT = 'yggdrasil.plugin';
/** 打包后的扩展名。z 内部是 zip，但对外用自定义后缀 —— 否则别人右键解压就当普通压缩包处理了。 */
export const PLUGIN_EXT = '.graft';
/** 单文件形态（agent 自己产出的包走这个，便于粘贴与 diff）。 */
export const PLUGIN_JSON_EXT = '.json';
/** 包内允许出现的固定文件名。 */
export const PLUGIN_ALLOWED_FILES = ['manifest.json', 'guide.md', 'README.md'];
/** 允许的目录型文件：tools/*.js 与 ui/*.tsx。**除这些之外的文件一律拒绝。** */
export const PLUGIN_FILE_PATTERNS = [/^tools\/[a-z][a-z0-9_-]{0,30}\.js$/, /^ui\/[a-z][a-z0-9_-]{0,30}\.tsx$/];

/** 一个包内路径是否允许。 */
export function pluginFileAllowed(name: string): boolean {
  return PLUGIN_ALLOWED_FILES.includes(name) || PLUGIN_FILE_PATTERNS.some((re) => re.test(name));
}

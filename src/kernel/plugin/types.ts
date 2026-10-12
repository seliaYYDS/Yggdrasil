import type { ActCap } from '../types';

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
  /** 会不会改到外部数据（只影响反馈措辞）。 */
  mutates?: boolean;
  example?: Record<string, unknown>;
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
  /** guide.md 的内容，装载时填进来。 */
  guide?: string;
}

/** 解析出来但还没安装的包。 */
export interface PluginPackage {
  manifest: PluginManifest;
  /** 包内文件（相对路径 -> 文本内容）。 */
  files: Record<string, string>;
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
  guide: string;
  enabled: boolean;
  installedAt: string;
  /** 从哪来的（文件名或 URL），只用于界面展示。 */
  source: string;
  /** 用户填的值（含密钥）。**不进 .seed、不进提示词。** */
  values: Record<string, string>;
}

export const PLUGIN_FORMAT = 'yggdrasil.plugin';
/** 打包后的扩展名。z 内部是 zip，但对外用自定义后缀 —— 否则别人右键解压就当普通压缩包处理了。 */
export const PLUGIN_EXT = '.graft';
/** 单文件形态（agent 自己产出的包走这个，便于粘贴与 diff）。 */
export const PLUGIN_JSON_EXT = '.json';
/** 包内允许出现的文件（这一版没有代码，所以白名单只有两个 + 说明文件）。 */
export const PLUGIN_ALLOWED_FILES = ['manifest.json', 'guide.md', 'README.md'];

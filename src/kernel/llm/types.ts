import type { ResetPart } from '../types';
import type { SecurityLevel } from '../security';

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /**
   * 图片中转地址（可选）。**默认留空 = 不中转**。
   *
   * 识图本身**不经过任何第三方**：抓到字节 → base64 → 直接作为多模态消息交给当前模型。
   * 但浏览器读跨域图片的字节要求对方回 CORS 头，很多图床不给 —— 这时才会用到这个地址。
   * 填了它就意味着你认可那个中转服务（它只负责把字节递过来，不做任何识别）。
   */
  imageRelay?: string;
  /**
   * 成人模式。**默认关闭。**
   *
   * 开启后会在 Agent 的系统提示里注入一节：不要因为话题涉及性 / 性器官 / 情色就回避、说教或拒绝，
   * 把它当作正当题材处理（医学、解剖、性教育、艺术、文学、法律、心理），需要相关图片时正常抓取与查看。
   *
   * 两点边界：① 它只改变**本应用写给模型的提示词**，改变不了模型服务商自己的安全策略
   * —— 服务端该拒还是会拒；② 涉及未成年人的性内容与其它违法内容始终不在此列。
   */
  adultMode?: boolean;
  /**
   * 安全等级。**默认 normal。**
   *
   * 它决定"在 Worker 隔离之上再追加多少约束"：插件 js 工具能不能跑、
   * 一次调用能发几个请求、插件能不能读到密钥、未签名的包收不收。
   * 具体每一档的差别集中在 src/kernel/security.ts 的表里（界面说明与执行检查读同一份）。
   */
  securityLevel?: SecurityLevel;
  /**
   * 重置对话框里上次勾选的区块。**缺省 = 全选。**
   *
   * 记住它是为了"我只想清日志"这类反复操作不必每次重勾；它不是安全项，
   * 所以和别的偏好一起放在设置里（重置本身始终保留设置，因此这个选择也留得住）。
   */
  resetParts?: ResetPart[];
  /**
   * 模型的上下文窗口（token）。**0 / 未填 = 未知**。
   *
   * 它只用来做一件事：给对话历史加一道"按估算 token"的闸
   * （见 agentRuntime 的 historyMessages）—— 未知时行为与以前完全一样。
   * 从 `/models` 拿到元数据、或从常见模型表里查到时会自动填上。
   */
  contextWindow?: number;
  /**
   * 单次回复的最大输出 token。**0 / 未填 = 不发 max_tokens**（由服务商用自己的默认值）。
   *
   * 注意：有些推理模型把思维链也算进这个额度，填小了会出现"有思考、没正文"。
   */
  maxTokens?: number;
  /**
   * 该模型能不能收图片。**默认开**。
   *
   * 关掉之后：发给模型的消息里**不含图片块**（带图的记忆仍然留着，只是这一轮不送），
   * 于是纯文本模型不会再因为收到图片而整条失败。
   */
  vision?: boolean;
  /**
   * 上下文压缩阈值（%）。**默认 85。**
   *
   * 一轮请求的估算长度超过"窗口 × 这个百分比"时，先把旧历史交给模型压成一段摘要
   * （目标 / 已做 / 未做 / 关键事实），再从摘要继续跑 —— 而不是把最老的消息丢掉。
   * 见 src/kernel/agent/compact.ts。
   */
  compactAt?: number;
  /**
   * 精简模式。**默认关闭。**
   *
   * 打开后提示词按"最简可用"打包：接口目录只留一句话、去掉示例，各条纪律压到最短，
   * 快照只留当前窗口与账本。目标是在 Agent 仍然能干活的前提下把固定开销降到最低。
   * 代价是它需要自己 inspect 去补细节（提示词里会这么告诉它）。
   */
  terse?: boolean;
  /**
   * 工作区（Agent 的加工台）**总容量上限**，字节。**未填 = 默认 32 MB**。
   *
   * 它不是浏览器的真实配额，而是我们自己的软上限 —— 目的是"到点给出人能看懂的错误"，
   * 而不是让 IndexedDB 抛 QuotaExceededError 进回读。上限硬顶 1 GB
   * （见 clampWorkspaceTotal / WORKSPACE_TOTAL_MAX）。
   */
  workspaceTotalBytes?: number;
  /**
   * 工作区**单文件**上限，字节。**未填 = 默认 16 MB**。硬顶 512 MB。
   */
  workspaceFileBytes?: number;
  /**
   * 按**入口（Base 地址）**分开保存的 Key。
   *
   * 键是归一化后的 Base 地址（去尾斜杠），值是 Key。
   * `apiKey` 始终是"当前入口正在用的那个" —— 它必须留着，
   * 因为请求、seed、以及所有读 `settings.apiKey` 的地方都只看它；
   * 这份表只是"切换入口时把 Key 也换回来"的记忆。
   */
  apiKeys?: Record<string, string>;
}

export const DEFAULT_SETTINGS: LlmSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
  // 刻意留空：默认不经过任何第三方。
  imageRelay: '',
  adultMode: false,
  securityLevel: 'normal',
  // 默认模型是 gpt-4o-mini：128k 窗口 / 16k 输出 / 支持识图。
  contextWindow: 128000,
  maxTokens: 16384,
  vision: true,
  compactAt: 85,
  terse: false,
  // 工作区上限留空 = 用默认值（32 MB / 16 MB），与以前完全一致。
  apiKeys: {},
};

/** 工作区总容量上限的默认与硬顶。 */
export const WORKSPACE_TOTAL_DEFAULT = 32 * 1024 * 1024;
export const WORKSPACE_TOTAL_MAX = 1024 * 1024 * 1024; // 1 GB
/** 工作区单文件上限的默认与硬顶。 */
export const WORKSPACE_FILE_DEFAULT = 16 * 1024 * 1024;
export const WORKSPACE_FILE_MAX = 512 * 1024 * 1024; // 512 MB

/** 把一个上限夹进 [下限, 硬顶]；非法值（0 / 负数 / NaN）返回 undefined = 用默认。 */
export function clampWorkspaceTotal(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.round(n), WORKSPACE_TOTAL_MAX);
}

export function clampWorkspaceFile(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.round(n), WORKSPACE_FILE_MAX);
}

/** 多模态消息的内容块（OpenAI 兼容格式）。 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /**
   * 纯文本就是字符串；带图片时是内容块数组。
   * 原样塞进请求体，所以只支持服务端认识的块类型。
   */
  content: string | ContentPart[];
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

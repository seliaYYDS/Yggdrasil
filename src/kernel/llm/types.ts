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
}

export const DEFAULT_SETTINGS: LlmSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
  // 刻意留空：默认不经过任何第三方。
  imageRelay: '',
  adultMode: false,
};

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

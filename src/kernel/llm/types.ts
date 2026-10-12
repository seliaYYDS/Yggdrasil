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
}

export const DEFAULT_SETTINGS: LlmSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
  // 刻意留空：默认不经过任何第三方。
  imageRelay: '',
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

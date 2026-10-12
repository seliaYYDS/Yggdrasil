import { LlmError, type ChatMessage, type LlmSettings } from './types';

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

/**
 * 服务端报的用量。**不是所有服务商都给** —— 给了就用真值（`exact: true`），
 * 没给就由上层按字符估算（`exact: false`，界面上会标 ~）。
 */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** 命中缓存的输入 token。OpenAI 放 prompt_tokens_details.cached_tokens，DeepSeek 放 prompt_cache_hit_tokens。 */
  cachedTokens: number;
}

/** 一次流式调用的结果。 */
export interface StreamResult {
  text: string;
  /** 服务端报的用量；没报就是 null。 */
  usage: LlmUsage | null;
  /** 这次调用从发出到读完流的耗时（毫秒）。token/s 用它算。 */
  ms: number;
}

export interface StreamOptions {
  /** 正文增量。 */
  onDelta?: (chunk: string) => void;
  /**
   * 思考增量。
   * DeepSeek 的推理模型把思维链放在 `delta.reasoning_content`，
   * 另一些服务端放在 `delta.reasoning` —— 两个都收。
   */
  onThinking?: (chunk: string) => void;
  signal?: AbortSignal;
}

interface UsageChunk {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}

interface StreamChunk {
  choices?: Array<{ delta?: StreamDelta; message?: { content?: string | null } }>;
  error?: { message?: string };
  /** 用量通常挂在最后一个数据块上（需要 stream_options.include_usage）。 */
  usage?: UsageChunk;
}

export async function chatStream(
  settings: LlmSettings,
  messages: ChatMessage[],
  options: StreamOptions = {},
): Promise<StreamResult> {
  // 用高精度时钟：一次很短的流用 Date.now() 量出来会是 0ms，tok/s 就没法算了。
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!settings.apiKey.trim()) {
    throw new LlmError('No API key configured — fill one in on the Settings page of the Yggdrasil input box.');
  }
  const res = await fetch(endpoint(settings.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      stream: true,
      messages,
      // 请求在流末尾附带用量。OpenAI 兼容端点支持；不支持的服务商会忽略它（那就走估算）。
      stream_options: { include_usage: true },
    }),
    signal: options.signal,
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 600);
    } catch {
      detail = '';
    }
    throw new LlmError(`LLM 请求失败 ${res.status} ${res.statusText} ${detail}`.trim(), res.status);
  }

  if (!res.body) {
    throw new LlmError('The LLM response has no readable stream; make sure the endpoint supports stream.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let usage: LlmUsage | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue;
      }
      if (chunk.error?.message) throw new LlmError(chunk.error.message);
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          cachedTokens:
            chunk.usage.prompt_tokens_details?.cached_tokens ??
            chunk.usage.prompt_cache_hit_tokens ??
            0,
        };
      }
      const d = chunk.choices?.[0]?.delta;
      // 思考流单独走一条回调：它不进正文，也不参与 JSON 解析。
      const thought = d?.reasoning_content ?? d?.reasoning ?? '';
      if (thought) options.onThinking?.(thought);
      const delta = d?.content ?? chunk.choices?.[0]?.message?.content ?? '';
      if (delta) {
        full += delta;
        options.onDelta?.(delta);
      }
    }
  }

  if (!full.trim()) throw new LlmError('The LLM returned empty content.');
  const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { text: full, usage, ms: Math.max(1, Math.round(endedAt - startedAt)) };
}

/**
 * 粗略估 token 数（服务端没报用量时的兜底）。
 *
 * 中文大约 1 字 0.6 token、英文大约 1 字 0.25 token，混在一起取 0.5 是个够用的折中。
 * 它是**估算**，界面上会带 ~ 标明，不要当准确值用。
 */
export function estimateTokens(text: string): number {
  return Math.round(text.length * 0.5);
}

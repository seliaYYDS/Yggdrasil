import { LlmError, type ChatMessage, type LlmSettings } from './types';

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

export interface StreamOptions {
  onDelta?: (chunk: string) => void;
  signal?: AbortSignal;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string | null } }>;
  error?: { message?: string };
}

export async function chatStream(
  settings: LlmSettings,
  messages: ChatMessage[],
  options: StreamOptions = {},
): Promise<string> {
  if (!settings.apiKey.trim()) {
    throw new LlmError('尚未配置 API Key，请在 Yggdrasil 输入框的「设置」页填入。');
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
    throw new LlmError('LLM 响应没有可读流，请确认端点支持 stream。');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

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
      const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? '';
      if (delta) {
        full += delta;
        options.onDelta?.(delta);
      }
    }
  }

  if (!full.trim()) throw new LlmError('LLM 返回了空内容。');
  return full;
}

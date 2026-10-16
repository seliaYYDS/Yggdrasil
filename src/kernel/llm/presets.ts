import type { LlmSettings } from './types';

/**
 * 常用模型提供商的入口预设。
 *
 * 为什么要有这一层：Base 是一串必须**一字不差**的地址，记错一个 /v1 就只得到 404。
 * 预设只做一件事 —— 把地址填对。填完仍然可改，自建代理选"自建 / 其它"。
 *
 * 地址取自各家文档（2026-02 核对，见 dev.md §5.101）。聚合入口（OpenRouter / 硅基流动）
 * 一个 key 就能用别家的模型，所以 Claude / Gemini 这类不直接给 OpenAI 兼容协议的，
 * 走聚合入口或各家自己的兼容层。
 */
export interface ProviderPreset {
  id: string;
  label: string;
  /** OpenAI 兼容入口。空串 = 保持用户自己填的地址。 */
  baseUrl: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'gemini', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'xai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1' },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'ollama', label: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1' },
  { id: 'custom', label: '自建 / 其它', baseUrl: '' },
];

/**
 * 一个入口的**稳定键**：归一化后的 Base 地址。
 *
 * 为什么用地址而不是预设 id：预设只有固定的十几家，用户完全可能自己填一个中转地址；
 * 而"同一个地址 = 同一个入口"对两者都成立。尾斜杠与大小写不构成不同的入口
 * （地址本身也不区分），所以归一化掉再当键 —— 否则 `.../v1` 与 `.../v1/` 会各存一份 Key。
 */
export function providerKeyFor(baseUrl: string): string {
  return (baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
}

/** 地址去尾斜杠后找预设（用于把当前入口标出来）。 */
export function providerFor(baseUrl: string): ProviderPreset | undefined {
  const norm = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!norm) return PROVIDER_PRESETS.find((p) => p.id === 'custom');
  return PROVIDER_PRESETS.find((p) => p.baseUrl && p.baseUrl.replace(/\/+$/, '') === norm);
}

/** 一个模型的三个参数：上下文窗口 / 最大输出 / 是否识图。任何一项未知就是 undefined。 */
export interface ModelLimits {
  contextWindow?: number;
  maxTokens?: number;
  vision?: boolean;
}

/**
 * 常见模型的已知参数。
 *
 * 为什么不能只靠接口：OpenAI / DeepSeek 的 `/models` 只回一个模型名（id / owned_by），
 * 窗口与最大输出根本不在里面。所以这里补一张表；名字对得上就用，对不上就留空
 * （**不猜**）—— 用户可以在设置里手填，接口给了元数据时也会覆盖这张表（见 parseModelsPayload）。
 *
 * 数值来源：OpenAI / Anthropic / DeepSeek / Qwen / Google / Mistral 官方文档与
 * https://github.com/taylorwilsdon/llm-context-limits（2026-02 核对）。
 */
const MODEL_LIMITS: { match: RegExp; limits: ModelLimits }[] = [
  { match: /^gpt-5/i, limits: { contextWindow: 400000, maxTokens: 128000, vision: true } },
  { match: /^o[134]-?mini|^o1-preview/i, limits: { contextWindow: 200000, maxTokens: 100000, vision: false } },
  { match: /^o[134]|^o1\b/i, limits: { contextWindow: 200000, maxTokens: 100000, vision: true } },
  { match: /^gpt-4\.1/i, limits: { contextWindow: 1047576, maxTokens: 32768, vision: true } },
  { match: /^gpt-4o/i, limits: { contextWindow: 128000, maxTokens: 16384, vision: true } },
  { match: /^gpt-4-turbo|^gpt-4-0125|^gpt-4-1106/i, limits: { contextWindow: 128000, maxTokens: 4096, vision: true } },
  { match: /^gpt-3\.5/i, limits: { contextWindow: 16385, maxTokens: 4096, vision: false } },
  { match: /^gpt-4/i, limits: { contextWindow: 8192, maxTokens: 8192, vision: false } },
  { match: /claude.*(opus|sonnet)[-_]?4|claude-4/i, limits: { contextWindow: 200000, maxTokens: 64000, vision: true } },
  { match: /claude.*3[-.]7/i, limits: { contextWindow: 200000, maxTokens: 8192, vision: true } },
  { match: /claude.*3[-.]5.*haiku/i, limits: { contextWindow: 200000, maxTokens: 8192, vision: false } },
  { match: /claude.*3[-.]5/i, limits: { contextWindow: 200000, maxTokens: 8192, vision: true } },
  { match: /claude/i, limits: { contextWindow: 200000, maxTokens: 4096, vision: true } },
  { match: /deepseek-reasoner|deepseek-r1/i, limits: { contextWindow: 65536, maxTokens: 8192, vision: false } },
  { match: /deepseek/i, limits: { contextWindow: 65536, maxTokens: 8192, vision: false } },
  { match: /qwen.*vl|vl.*qwen/i, limits: { contextWindow: 32768, maxTokens: 8192, vision: true } },
  { match: /qwen|qwq/i, limits: { contextWindow: 131072, maxTokens: 8192, vision: false } },
  { match: /gemini-2\.5/i, limits: { contextWindow: 1048576, maxTokens: 65536, vision: true } },
  { match: /gemini/i, limits: { contextWindow: 1048576, maxTokens: 8192, vision: true } },
  { match: /mistral-large|mistral-medium|mistral-small/i, limits: { contextWindow: 32768, maxTokens: 4096, vision: false } },
  { match: /mistral-nemo/i, limits: { contextWindow: 128000, maxTokens: 4096, vision: false } },
  { match: /llama-?3\.3/i, limits: { contextWindow: 131072, maxTokens: 2048, vision: false } },
  { match: /llama|mixtral/i, limits: { contextWindow: 131072, maxTokens: 4096, vision: false } },
  { match: /phi-?4/i, limits: { contextWindow: 16384, maxTokens: 16384, vision: false } },
];

/** 按模型名查已知参数；查不到返回空对象（**不猜**）。 */
export function lookupModelLimits(id: string): ModelLimits {
  const name = (id || '').trim();
  if (!name) return {};
  for (const row of MODEL_LIMITS) {
    if (row.match.test(name)) return { ...row.limits };
  }
  return {};
}

/** `/models` 列表里的一项：id 一定有，三个参数能拿到就给。 */
export interface RemoteModel extends ModelLimits {
  id: string;
  /** 服务端给的可读名字（和 id 不同时才带上）。 */
  label?: string;
}

function positiveNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return undefined;
}

/** 把一行的各种厂商字段读成三个参数（键名在各家之间并不统一）。 */
function readRowLimits(raw: Record<string, unknown>): ModelLimits {
  const arch = (raw.architecture ?? {}) as Record<string, unknown>;
  const top = (raw.top_provider ?? {}) as Record<string, unknown>;
  const contextWindow = positiveNumber(
    raw.context_length, raw.context_window, raw.max_context_length, raw.max_model_len,
    raw.max_input_tokens, arch.context_length, top.context_length,
  );
  const maxTokens = positiveNumber(
    raw.max_completion_tokens, raw.max_output_tokens, raw.max_tokens,
    top.max_completion_tokens, top.max_output_tokens,
  );
  const mods = [
    ...(Array.isArray(arch.input_modalities) ? arch.input_modalities : []),
    ...(Array.isArray(raw.input_modalities) ? raw.input_modalities : []),
    ...(Array.isArray(raw.modalities) ? raw.modalities : []),
  ].map((m) => String(m));
  let vision: boolean | undefined;
  if (mods.length > 0) vision = mods.some((m) => /image|vision/i.test(m));
  else if (typeof raw.supports_vision === 'boolean') vision = raw.supports_vision;
  else if (typeof raw.supports_image_input === 'boolean') vision = raw.supports_image_input;
  else if (typeof raw.vision === 'boolean') vision = raw.vision;
  return { contextWindow, maxTokens, vision };
}

/**
 * 把 `/models` 的返回解析成列表。
 *
 * 形状各家不同：`{data:[…]}`（OpenAI 系）、`[…]`（少数）、`{models:[…]}`（Gemini 兼容层），
 * 条目可能是对象也可能就是一个字符串；Gemini 的 id 还带 `models/` 前缀。
 * 参数先读接口给的元数据，读不到再查已知表。
 */
export function parseModelsPayload(payload: unknown): RemoteModel[] {
  const box = payload as { data?: unknown; models?: unknown } | null;
  const arr: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(box?.data)
      ? (box!.data as unknown[])
      : Array.isArray(box?.models)
        ? (box!.models as unknown[])
        : [];
  const seen = new Set<string>();
  const out: RemoteModel[] = [];
  for (const item of arr) {
    const raw = (typeof item === 'string' ? { id: item } : (item ?? {})) as Record<string, unknown>;
    const rawId = typeof raw.id === 'string' && raw.id ? raw.id : typeof raw.name === 'string' ? raw.name : '';
    const id = rawId.replace(/^models\//, '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fromApi = readRowLimits(raw);
    const known = lookupModelLimits(id);
    const label = typeof raw.name === 'string' && raw.name !== id && !raw.name.startsWith('models/') ? raw.name : undefined;
    out.push({
      id,
      label,
      contextWindow: fromApi.contextWindow ?? known.contextWindow,
      maxTokens: fromApi.maxTokens ?? known.maxTokens,
      vision: fromApi.vision ?? known.vision,
    });
  }
  return out;
}

/** 名称 → 参数，给"按名字套用预设"用（选完模型顺手填三个参数）。 */
export function limitsForModel(id: string): ModelLimits {
  return lookupModelLimits(id);
}

/** 三个参数里哪些是"用户/接口明确给了"的 —— 合并时用。 */
export function mergeLimits(base: ModelLimits, patch: ModelLimits): ModelLimits {
  return {
    contextWindow: patch.contextWindow ?? base.contextWindow,
    maxTokens: patch.maxTokens ?? base.maxTokens,
    vision: patch.vision ?? base.vision,
  };
}

/**
 * 从输入框读一个 token 数：`128000` / `128,000` / `128k` 都认；
 * 空串、非法、0 一律当作"未知"（= 不设限），不塞一个假值进去。
 */
export function readTokenCount(text: string): number | undefined {
  const t = String(text).trim().toLowerCase().replace(/[,_\s]/g, '');
  if (!t) return undefined;
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'm' ? 1000000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** 设置面板里显示的 token 数（1k 以上按 k 显示）。 */
export function formatTokens(n: number | undefined): string {
  if (!n || n <= 0) return '';
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
}

export type { LlmSettings };

import type { DerivationOp, DerivationPlan } from '../types';
import { knownKinds } from '../registry/interfaceRegistry';

export interface ParseResult {
  ok: boolean;
  plan?: DerivationPlan;
  error?: string;
  raw: string;
  /**
   * 这份计划是怎么来的：正常 JSON，还是把模型的原生工具调用标记翻译过来的。
   * 调用方据此告诉模型"你刚才用的是工具调用语法"（不然它下一轮还会那样写）。
   */
  via?: 'json' | 'native';
}

/** 一次原生工具调用：名字 + 已经解析好的具名参数。 */
export interface NativeCall {
  name: string;
  args: Record<string, unknown>;
}

/*
 * 模型不写 ops、直接吐它自己的原生工具调用标记时，把它翻译成 ops。
 *
 * 为什么必须有这一段：DeepSeek 系的模型见过的工具调用语料最多 —— 一旦它把"可用操作清单"
 * 当成工具表，就会输出一个 calls 块（若干 `invoke name="…"`，每个里面若干
 * `parameter name="…"`）。它其实已经把我们要的东西说全了（kind 加具名参数），只是信封不是 JSON。
 * 以前这种回复**整轮报废**：报 "No JSON object found in the model reply."，
 * 用户看到的就是"明明知道要调 ws_read，却什么都没发生"。
 *
 * 只在**解析层**收下它，协议没变：翻译出来的 ops 照样过总线的 caps / 作用域 / 参数校验，
 * 认不出的 kind 会被总线连同可用清单一起拒掉。
 */
export function extractNativeCalls(text: string): NativeCall[] {
  // 带 g 的正则有 lastIndex 状态，所以每次调用现建 —— 模块级共用会被嵌套调用踩到。
  const invoke = /invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*invoke\s*>/g;
  const param = /parameter\s+name="([^"]+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/[^>]*parameter\s*>)/g;
  const out: NativeCall[] = [];
  let m: RegExpExecArray | null;
  while ((m = invoke.exec(text)) !== null) {
    const args: Record<string, unknown> = {};
    let p: RegExpExecArray | null;
    param.lastIndex = 0;
    while ((p = param.exec(m[2] ?? '')) !== null) {
      // string="true" 就是"这是字符串、别当 JSON 解"；否则先试 JSON（数字 / 布尔 / 数组 /
      // 对象都靠这一步还原），解不动就原样当文本。
      const attrs = p[2] ?? '';
      args[p[1]] = /string\s*=\s*"true"/.test(attrs) ? (p[3] ?? '') : coerceValue(p[3] ?? '');
    }
    if (m[1]) out.push({ name: m[1], args });
  }
  return out;
}

function coerceValue(value: string): unknown {
  const v = value.trim();
  if (!v) return '';
  try {
    return JSON.parse(v);
  } catch {
    return value;
  }
}

/**
 * 把若干净原生调用拼成一个计划。
 *
 * - 名字本身就是可用 kind → 直接 `{ kind, ...参数 }`；
 * - 名字是派生工具（提示词里 "## Available tools" 那些）→ 包成
 *   `{ kind: 'call_tool', name, args }`；
 * - `continue: true`：一次调用天然是"先调用、再看结果"。取 false 会让这一轮跑完就结束，
 *   模型永远看不到返回值；防跑飞另有"连续两轮指令与结果完全一致即判空转"那道闸。
 */
export function planFromNativeCalls(calls: NativeCall[], rawText = ''): ParseResult {
  const kinds = knownKinds();
  const ops: DerivationOp[] = [];
  for (const c of calls) {
    if (kinds.includes(c.name)) ops.push({ ...c.args, kind: c.name });
    else ops.push({ kind: 'call_tool', name: c.name, args: c.args });
  }
  if (ops.length === 0) return { ok: false, error: 'No tool call in the model reply.', raw: rawText };

  // 标签本身不算"模型说的话"：剥掉标签后剩下的才是它真正写的文字（通常为空）。
  const prose = rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    ok: true,
    via: 'native',
    raw: rawText,
    plan: {
      reasoning: prose || 'Translated native tool calls into ops: ' + ops.map((o) => o.kind).join(', '),
      continue: true,
      ops,
    },
  };
}

/**
 * 网关把调用放进 `tool_calls` 时（此时正文是空的）转成 NativeCall。
 *
 * 参数不是合法 JSON 对象的那条**直接丢掉**：宁可让这一轮照旧失败，
 * 也不要拿半个参数去调一个会改状态的接口。
 */
export function nativeCallsFromArgs(list: { name: string; arguments: string }[]): NativeCall[] {
  const out: NativeCall[] = [];
  for (const c of list) {
    if (!c.name) continue;
    let args: unknown;
    try {
      args = c.arguments.trim() ? JSON.parse(c.arguments) : {};
    } catch {
      continue;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    out.push({ name: c.name, args: args as Record<string, unknown> });
  }
  return out;
}

function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i += 1) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 把模型输出解析成派生计划。
 * kind 不做硬白名单 —— 未知 kind 交给总线报「未知接口」，错误信息里能带上可用清单与 kind 名。
 */
export function parsePlan(text: string): ParseResult {
  const raw = text.trim();
  /*
   * "没有 JSON"不等于"什么都没说"：模型可能用的是它自己的原生工具调用标记。
   * 每条失败出路前都先试一次翻译 —— 成功就照常执行，失败才把原来的 JSON 错误报出去。
   */
  const tryNative = (): ParseResult | null => {
    const calls = extractNativeCalls(raw);
    return calls.length > 0 ? planFromNativeCalls(calls, raw) : null;
  };

  const json = extractJson(raw);
  if (!json) return tryNative() ?? { ok: false, error: 'No JSON object found in the model reply.', raw };

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return tryNative() ?? { ok: false, error: 'JSON parse failed: ' + (e as Error).message, raw };
  }
  if (!data || typeof data !== 'object') {
    return tryNative() ?? { ok: false, error: 'The top level of the JSON is not an object.', raw };
  }

  const obj = data as Record<string, unknown>;
  const opsRaw = Array.isArray(obj.ops) ? obj.ops : [];
  const ops: DerivationOp[] = [];
  for (const item of opsRaw) {
    if (!item || typeof item !== 'object') continue;
    const op = item as Record<string, unknown>;
    if (typeof op.kind !== 'string' || !op.kind) continue;
    ops.push({ ...op, kind: op.kind });
  }

  if (ops.length === 0 && opsRaw.length > 0) {
    return {
      ok: false,
      error: 'No op in "ops" carries a kind. Available kinds: ' + knownKinds().join(', ') + '.',
      raw,
    };
  }

  return {
    ok: true,
    via: 'json',
    raw,
    plan: {
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
      continue: obj.continue === true,
      ops,
    },
  };
}

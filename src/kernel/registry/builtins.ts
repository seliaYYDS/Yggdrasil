import { registerTool } from './toolRegistry';

const SAFE_EXPR = /^[0-9+\-*/(). %^]+$/;

function evaluate(expr: string): number {
  const cleaned = expr.trim();
  if (!SAFE_EXPR.test(cleaned)) {
    throw new Error('表达式只允许数字与 + - * / ( ) . % 运算符。');
  }
  const js = cleaned.replace(/\^/g, '**');
  // eslint-disable-next-line no-new-func
  const value = new Function('"use strict";return (' + js + ');')() as unknown;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('表达式没有算出有限数值。');
  }
  return value;
}

export function registerBuiltinTools(): void {
  registerTool({
    id: 'builtin.calc',
    name: 'calc',
    description: '计算一个算术表达式，例：{"expr": "12*(3+4)"}',
    paramsSchema: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] },
    source: '',
    builtin: true,
    run: (args) => {
      const a = (args ?? {}) as { expr?: unknown };
      if (typeof a.expr !== 'string') throw new Error('参数 expr 必须是字符串。');
      return { expr: a.expr, value: evaluate(a.expr) };
    },
  });

  registerTool({
    id: 'builtin.now',
    name: 'now',
    description: '读取当前时间，无参数',
    paramsSchema: { type: 'object', properties: {} },
    source: '',
    builtin: true,
    run: () => {
      const d = new Date();
      return { iso: d.toISOString(), local: d.toLocaleString('zh-CN') };
    },
  });

  registerTool({
    id: 'builtin.random',
    name: 'random',
    description: '生成一个区间内的随机整数，例：{"min": 1, "max": 100}',
    paramsSchema: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } },
    source: '',
    builtin: true,
    run: (args) => {
      const a = (args ?? {}) as { min?: unknown; max?: unknown };
      const min = typeof a.min === 'number' ? a.min : 0;
      const max = typeof a.max === 'number' ? a.max : 100;
      if (max < min) throw new Error('max 不能小于 min。');
      return { min, max, value: Math.floor(Math.random() * (max - min + 1)) + min };
    },
  });
}

import { registerTool } from './toolRegistry';

const SAFE_EXPR = /^[0-9+\-*/(). %^]+$/;

function evaluate(expr: string): number {
  const cleaned = expr.trim();
  if (!SAFE_EXPR.test(cleaned)) {
    throw new Error('The expression may only contain numbers and the operators + - * / ( ) . %.');
  }
  const js = cleaned.replace(/\^/g, '**');
  // eslint-disable-next-line no-new-func
  const value = new Function('"use strict";return (' + js + ');')() as unknown;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('The expression did not evaluate to a finite number.');
  }
  return value;
}

export function registerBuiltinTools(): void {
  registerTool({
    id: 'builtin.calc',
    name: 'calc',
    description: 'Evaluate an arithmetic expression, e.g. {"expr": "12*(3+4)"}',
    paramsSchema: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] },
    source: '',
    builtin: true,
    run: (args) => {
      const a = (args ?? {}) as { expr?: unknown };
      if (typeof a.expr !== 'string') throw new Error('The expr argument must be a string.');
      return { expr: a.expr, value: evaluate(a.expr) };
    },
  });

  registerTool({
    id: 'builtin.now',
    name: 'now',
    description: 'Read the current time; takes no arguments',
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
    description: 'Generate a random integer in a range, e.g. {"min": 1, "max": 100}',
    paramsSchema: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } },
    source: '',
    builtin: true,
    run: (args) => {
      const a = (args ?? {}) as { min?: unknown; max?: unknown };
      const min = typeof a.min === 'number' ? a.min : 0;
      const max = typeof a.max === 'number' ? a.max : 100;
      if (max < min) throw new Error('max must not be smaller than min.');
      return { min, max, value: Math.floor(Math.random() * (max - min + 1)) + min };
    },
  });
}

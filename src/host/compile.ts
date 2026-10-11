import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import Babel from '@babel/standalone';

export type ModuleValue = unknown;

const externals = new Map<string, ModuleValue>();

/** 注册生成代码里允许 import 的额外模块。 */
export function registerModule(name: string, value: ModuleValue): void {
  externals.set(name, value);
}

function baseModules(): Record<string, ModuleValue> {
  const react = { ...React, default: React, __esModule: true } as ModuleValue;
  return {
    react,
    'react-dom': { ...ReactDOM, default: ReactDOM, __esModule: true } as ModuleValue,
    'react-dom/client': { ...ReactDOMClient, default: ReactDOMClient, __esModule: true } as ModuleValue,
  };
}

export function allowedModules(): string[] {
  return Object.keys({ ...baseModules(), ...Object.fromEntries(externals) });
}

export interface CompileFail {
  ok: false;
  error: string;
}

function fail(error: string): CompileFail {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* 工具：按括号深度扫描，忽略字符串与注释                                */
/* ------------------------------------------------------------------ */

type ScanMode = 'code' | 'sq' | 'dq' | 'tpl' | 'line' | 'block';

function scanStatementEnd(s: string, start: number): number {
  let depth = 0;
  let mode: ScanMode = 'code';
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    const n = s[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 1; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 1; continue; }
      if (c === "'") { mode = 'sq'; continue; }
      if (c === '"') { mode = 'dq'; continue; }
      if (c === String.fromCharCode(96)) { mode = 'tpl'; continue; }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (c === ';' && depth <= 0) return i + 1;
      continue;
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 1; } continue; }
    if (c === '\\') { i += 1; continue; }
    if (mode === 'sq' && c === "'") mode = 'code';
    else if (mode === 'dq' && c === '"') mode = 'code';
    else if (mode === 'tpl' && c === String.fromCharCode(96)) mode = 'code';
  }
  return s.length;
}

function matchBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 取一段声明里的顶层标识符名（先剥掉 const/let/var 关键字）。 */
function topLevelNames(decl: string): string[] {
  const names: string[] = [];
  const body = decl.replace(/^\s*(?:const|let|var)\b/, '');
  let depth = 0;
  let current = '';
  const parts: string[] = [];
  for (const ch of body) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  for (const part of parts) {
    const m = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
    if (m) names.push(m[1]);
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* 1. import 收集与改写                                                 */
/* ------------------------------------------------------------------ */

interface ImportBinding {
  local: string;
  kind: 'default' | 'namespace' | 'named';
  name?: string;
  source: string;
}

const FROM_IMPORT_RE = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
const BARE_IMPORT_RE = /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?/gm;

function parseClause(clause: string, source: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const rest = clause.trim();
  const namedStart = rest.indexOf('{');
  const namedEnd = rest.lastIndexOf('}');
  const namedPart = namedStart >= 0 && namedEnd > namedStart ? rest.slice(namedStart + 1, namedEnd) : '';
  const head = namedStart >= 0 ? rest.slice(0, namedStart) : rest;

  for (const raw of head.split(',')) {
    const part = raw.trim().replace(/,$/, '');
    if (!part) continue;
    if (part.startsWith('*')) {
      const local = part.replace(/^\*\s*as\s*/, '').trim();
      if (local) out.push({ local, kind: 'namespace', source });
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(part)) out.push({ local: part, kind: 'default', source });
  }

  for (const raw of namedPart.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
    if (m) out.push({ local: m[2], kind: 'named', name: m[1], source });
    else if (/^[A-Za-z_$][\w$]*$/.test(part)) out.push({ local: part, kind: 'named', name: part, source });
  }
  return out;
}

function rewriteImports(source: string): { code: string; bindings: ImportBinding[] } {
  const bindings: ImportBinding[] = [];
  let code = source.replace(FROM_IMPORT_RE, (_m, clause: string, src: string) => {
    bindings.push(...parseClause(clause, src));
    return '';
  });
  // 副作用 import（如 "./x.css"）没有绑定，编译期直接忽略。
  code = code.replace(BARE_IMPORT_RE, () => '');
  return { code, bindings };
}

function bindingLines(bindings: ImportBinding[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const b of bindings) {
    if (seen.has(b.local)) continue;
    seen.add(b.local);
    const src = JSON.stringify(b.source);
    if (b.kind === 'default') lines.push('var ' + b.local + ' = __yggDefault(' + src + ');');
    else if (b.kind === 'namespace') lines.push('var ' + b.local + ' = __yggRequire(' + src + ');');
    else lines.push('var ' + b.local + ' = __yggNamed(' + src + ', ' + JSON.stringify(b.name) + ');');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 2. export 改写                                                       */
/* ------------------------------------------------------------------ */

interface ExportPlan {
  code: string;
  named: Array<[string, string]>;
  defaultExpr: string | null;
}

const EXPORT_HEAD_RE = /^[ \t]*export\s+/gm;
const DECL_AFTER_DEFAULT_RE = /^(async\s+function|function|class)\b/;
const DECL_RE = /^(async\s+function|function|class)\b/;
const VAR_DECL_RE = /^(const|let|var)\b/;
const TYPE_DECL_RE = /^(type|interface)\b/;

function adaptExports(source: string): ExportPlan {
  const named: Array<[string, string]> = [];
  let defaultExpr: string | null = null;

  const hits: number[] = [];
  let m: RegExpExecArray | null;
  EXPORT_HEAD_RE.lastIndex = 0;
  while ((m = EXPORT_HEAD_RE.exec(source))) hits.push(m.index);

  let code = source;
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const at = hits[i];
    if (at >= code.length) continue;
    const headLen = /^[ \t]*export\s+/.exec(code.slice(at))?.[0].length ?? 0;
    if (!headLen) continue;
    const afterExport = at + headLen;
    const rest = code.slice(afterExport);

    // export { ... } / export * from '...'
    if (/^\s*\{/.test(rest) || /^\s*\*/.test(rest)) {
      const braceStart = code.indexOf('{', afterExport);
      if (braceStart >= 0) {
        const braceEnd = matchBrace(code, braceStart);
        if (braceEnd > 0) {
          const body = code.slice(braceStart + 1, braceEnd);
          for (const raw of body.split(',')) {
            const part = raw.trim();
            if (!part) continue;
            const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
            if (as) named.push([as[2], as[1]]);
            else if (/^[A-Za-z_$][\w$]*$/.test(part)) named.push([part, part]);
          }
          let end = braceEnd + 1;
          if (code[end] === ';') end += 1;
          code = code.slice(0, at) + code.slice(end);
          continue;
        }
      }
      code = code.slice(0, at) + code.slice(afterExport);
      continue;
    }

    // export default ...
    const dm = /^default\b\s*/.exec(rest);
    if (dm) {
      const afterDefault = afterExport + dm[0].length;
      const tail = code.slice(afterDefault);
      const decl = DECL_AFTER_DEFAULT_RE.exec(tail);
      if (decl) {
        const nameMatch = /^\s*([A-Za-z_$][\w$]*)/.exec(tail.slice(decl[0].length));
        if (nameMatch) {
          named.push([nameMatch[1], nameMatch[1]]);
          defaultExpr = nameMatch[1];
          code = code.slice(0, at) + code.slice(afterDefault);
        } else {
          const generated = '__yggDefaultComponent';
          defaultExpr = generated;
          code = code.slice(0, at) + 'function ' + generated + tail.slice(decl[0].length);
        }
      } else {
        const end = scanStatementEnd(code, afterDefault);
        const expr = code.slice(afterDefault, end).replace(/;\s*$/, '');
        defaultExpr = '__yggDefaultValue';
        code = code.slice(0, at) + 'var __yggDefaultValue = ' + expr + ';' + code.slice(end);
      }
      continue;
    }

    // export type / interface
    if (TYPE_DECL_RE.test(rest)) {
      code = code.slice(0, at) + code.slice(afterExport);
      continue;
    }

    // export const/let/var
    const vm = VAR_DECL_RE.exec(rest);
    if (vm) {
      const end = scanStatementEnd(code, afterExport);
      const decl2 = code.slice(afterExport, end).replace(/;\s*$/, '');
      for (const n of topLevelNames(decl2)) named.push([n, n]);
      code = code.slice(0, at) + code.slice(afterExport);
      continue;
    }

    // export function f / export class C
    const fm = DECL_RE.exec(rest);
    if (fm) {
      const nameMatch = /^\s*([A-Za-z_$][\w$]*)/.exec(rest.slice(fm[0].length));
      if (nameMatch) named.push([nameMatch[1], nameMatch[1]]);
      code = code.slice(0, at) + code.slice(afterExport);
      continue;
    }

    code = code.slice(0, at) + code.slice(afterExport);
  }

  return { code, named, defaultExpr };
}

/** 没有任何 export 时，取最后一个顶层函数声明当组件。 */
function inferComponentName(source: string): string | null {
  const re = /^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let last: string | null = null;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(source))) last = mm[1];
  return last;
}

/* ------------------------------------------------------------------ */
/* 3. 编译                                                              */
/* ------------------------------------------------------------------ */

interface CompiledModule {
  ok: true;
  mod: Record<string, unknown>;
}

function compileModule(nodeId: string, source: string): CompiledModule | CompileFail {
  const trimmed = source.trim();
  if (!trimmed) return fail('源码为空。');

  const { code: withoutImports, bindings } = rewriteImports(trimmed);
  const plan = adaptExports(withoutImports);

  let defaultExpr = plan.defaultExpr;
  if (!defaultExpr && plan.named.length === 0) {
    const inferred = inferComponentName(plan.code);
    if (inferred) defaultExpr = inferred;
  }

  const exportEntries: string[] = [];
  if (defaultExpr) exportEntries.push('default: ' + defaultExpr);
  for (const [pub, local] of plan.named) exportEntries.push(JSON.stringify(pub) + ': ' + local);

  const inner = [
    'var __yggDefault = __yggRequire;',
    'var __yggNamed = function (id, name) {',
    '  var mod = __yggRequire(id);',
    '  if (mod && typeof mod === \'object\' && name in mod) return mod[name];',
    '  throw new Error(\'模块 \' + id + \' 没有导出 \' + name);',
    '};',
    bindingLines(bindings),
    'var React = __yggReact;',
    plan.code,
    'return { ' + exportEntries.join(', ') + ' };',
  ].join('\n');

  // 包进函数体后再交给 Babel，否则顶层 return 会被当作模块语法错误。
  const body = 'var __yggModule = function () {\n' + inner + '\n};';

  let compiled: string;
  try {
    const out = Babel.transform(body, {
      filename: 'ygg-' + nodeId + '.tsx',
      presets: [
        Babel.availablePresets.typescript,
        [Babel.availablePresets.react, { runtime: 'classic' }],
      ],
      compact: false,
    });
    const code = out?.code;
    if (!code) return fail('Babel 未返回编译结果。');
    compiled = code;
  } catch (e) {
    return fail('编译失败：' + (e as Error).message);
  }

  let factory: (requireFn: (id: string) => ModuleValue, react: ModuleValue) => Record<string, unknown>;
  try {
    factory = new Function('__yggRequire', '__yggReact', compiled + '\nreturn __yggModule();') as typeof factory;
  } catch (e) {
    return fail('无法生成模块工厂：' + (e as Error).message);
  }

  const modules = { ...baseModules(), ...Object.fromEntries(externals) };
  const requireFn = (id: string): ModuleValue => {
    if (id in modules) return modules[id];
    throw new Error('模块 ' + id + ' 不在允许列表中。可用：' + Object.keys(modules).join(', '));
  };

  try {
    return { ok: true, mod: factory(requireFn, modules.react) };
  } catch (e) {
    return fail('执行模块顶层代码失败：' + (e as Error).message);
  }
}

export interface CompileOk {
  ok: true;
  Component: React.ComponentType<Record<string, unknown>>;
}

export type CompileResult = CompileOk | CompileFail;

/**
 * 编译结果缓存。
 *
 * 为什么需要：Babel 编译一次是几毫秒到几十毫秒。整页效果类的请求（一次改很多窗口、
 * 或者最小化/恢复导致窗口重新挂载）会把同一份源码反复编译。
 * 缓存住之后，**同一个 (id, source) 每次拿到的是同一个组件函数引用** ——
 * 这同时让 React 不会因为"组件类型变了"而卸载重建整棵子树（WebGL canvas 会因此被丢掉重来）。
 *
 * 有上限：源码可能很多，缓存不设限就是内存泄漏。
 */
const MAX_COMPILE_CACHE = 120;
const compileCache = new Map<string, CompileResult>();

/** 清空编译缓存（重置 / 测试用）。 */
export function clearCompileCache(): void {
  compileCache.clear();
}

export function compileComponent(nodeId: string, source: string): CompileResult {
  const key = nodeId + '\u0000' + source;
  const hit = compileCache.get(key);
  if (hit) {
    // 命中就挪到末尾，保持 LRU 顺序。
    compileCache.delete(key);
    compileCache.set(key, hit);
    return hit;
  }

  const result = compileComponentUncached(nodeId, source);
  compileCache.set(key, result);
  if (compileCache.size > MAX_COMPILE_CACHE) {
    const oldest = compileCache.keys().next().value;
    if (oldest !== undefined) compileCache.delete(oldest);
  }
  return result;
}

function compileComponentUncached(nodeId: string, source: string): CompileResult {
  const compiled = compileModule(nodeId, source);
  if (!compiled.ok) return compiled;
  const { mod } = compiled;

  let Component: unknown = mod.default ?? mod.Component ?? null;
  if (typeof Component !== 'function') {
    const funcs = Object.values(mod).filter((v) => typeof v === 'function');
    Component = funcs.length === 1 ? funcs[0] : null;
  }
  if (typeof Component !== 'function') {
    return fail('导出内容不是 React 组件：请 export default 一个函数组件。');
  }
  return { ok: true, Component: Component as React.ComponentType<Record<string, unknown>> };
}

export interface ToolCompileOk {
  ok: true;
  run: (args: unknown) => unknown;
}

/** 工具源码约定：export default 一个函数，或 export function run(args)。 */
export function compileTool(nodeId: string, source: string): ToolCompileOk | CompileFail {
  const compiled = compileModule(nodeId, source);
  if (!compiled.ok) return compiled;
  const { mod } = compiled;
  const fn = (mod.default ?? mod.run ?? null) as unknown;
  if (typeof fn !== 'function') {
    return fail('工具源码需要 export default 一个函数，或 export function run(args)。');
  }
  return { ok: true, run: (args: unknown) => (fn as (a: unknown) => unknown)(args) };
}

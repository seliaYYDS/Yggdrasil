#!/usr/bin/env node
/**
 * 在命令行里**试跑一个插件**：打包、安装、然后像 Agent 那样调用它的操作与工具。
 *
 * 用法：
 *   node scripts/try-plugin.mjs toolbox                      列出它提供什么，并各调一次
 *   node scripts/try-plugin.mjs toolbox toolbox.text_stats '{"text":"hello world"}'
 *   node scripts/try-plugin.mjs weather weather.find_city '{"name":"北京"}'
 *   node scripts/try-plugin.mjs --dir plugins/toolbox        直接跑一个目录（不必先打包）
 *
 * 为什么需要它：插件原来只能在**浏览器里点上好几下**才能试 —— 装包、看面板、
 * 跟 Agent 说话、再回来看回读。改一行 tools/*.js 要重复这一整套。
 * 这个脚本把"打包 → 校验 → 安装 → 调用 → 打印回读"串成一条命令，
 * **走的是应用里同一份代码**（parsePluginPackage / installPlugin / executeOps），
 * 所以它报的错和真机上看到的是同一个。
 *
 * 它**不是**测试替身：这里没有重新实现任何校验或执行逻辑。
 * 唯一"假"的是 Worker —— Node 里没有 Worker，所以 js 工具由一段
 * 同协议的本地执行器代跑（与自动化测试里用的是同一套思路）。
 * 要验"真的隔离"，仍然只能在浏览器里跑。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
  console.log(`用法：
  node scripts/try-plugin.mjs <插件id>                              试跑（自动各调一次）
  node scripts/try-plugin.mjs <插件id> <操作|tool:名字> [--k=v ...] 只调一个
  node scripts/try-plugin.mjs --dir <目录> [操作|tool:名字] [--k=v ...] 现场跑一个目录

例：
  node scripts/try-plugin.mjs toolbox
  node scripts/try-plugin.mjs toolbox tool:text_stats --text "the quick brown fox" --top 3\
`);
  process.exit(0);
}

const useDir = args[0] === '--dir';
const id = useDir ? null : args[0];
const rest = useDir ? args.slice(2) : args.slice(1);
const dirArg = useDir ? args[1] : null;

/** 现场打包一个目录（复用 build-plugin 的 zip writer 太绕，这里直接读文件交给解析器）。 */
async function loadFromDir(dir) {
  const { readdirSync, statSync } = await import('node:fs');
  const files = {};
  /*
   * 走目录时**只把相对路径当键**（manifest.json / tools/x.js），
   * 而不是把 plugins/xxx 前缀也带上 —— 解析器是按包内路径找文件的。
   */
  const walk = (at, prefix) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const rel = prefix ? prefix + "/" + name : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files[rel] = readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return files;
}

/*
 * 复用**应用真正的那份源码**：现场生成一个入口，把这里要用到的模块重新导出，
 * 用 esbuild 打成一个 ESM 包再 import。
 *
 * 为什么不直接 import 'src/...'：那些是 .ts，而且模块内部走 Vite 的别名与
 * JSX 管道，Node 直接跑不了。打包一次（约 100ms）换来的是
 * "这个脚本调用的是应用里同一份 parsePluginPackage / executeOps"。
 */
const CLIDIR = join(process.cwd(), '.tmp', 'plugin-cli');
const ENTRY = join(CLIDIR, 'entry.ts');
const BUNDLE = join(CLIDIR, 'bundle.mjs');

const entrySource = [
  "export { useDesktopStore } from '../../src/store/desktopStore';",
  "export { registerBuiltinTools } from '../../src/kernel/registry/builtins';",
  "export { registerAllInterfaces } from '../../src/kernel/interfaces';",
  "export { registerBuiltinSurfaces } from '../../src/host/surfaces';",
  "export { registerModule } from '../../src/host/compile';",
  "export { parsePluginPackage, describeManifest } from '../../src/kernel/plugin/package';",
  "export { pluginDiff, pluginsText, enabledPlugins } from '../../src/kernel/plugin/runtime';",
  "export { knownKinds } from '../../src/kernel/registry/interfaceRegistry';",
  "export { toolCatalog } from '../../src/kernel/registry/toolRegistry';",
  "export { pluginPages, promptPatches } from '../../src/kernel/plugin/runtime';",
  "export { PROMPT_SECTIONS, PROTECTED_PROMPT_SECTIONS } from '../../src/kernel/agent/prompts';",
  "export { bridgeFetch, setToolExecutor } from '../../src/kernel/plugin/sandbox';",
  "export { executeOps } from '../../src/kernel/bus/derivationBus';",
  "export { AgentIdContext, useAgent, isAgentId } from '../../src/host/agentRuntimeModule';",
  '',
].join('\n');

async function buildBundle() {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(CLIDIR, { recursive: true });
  writeFileSync(ENTRY, entrySource);
  /*
   * 用 **Vite 自己的构建**，而不是直接调 esbuild。
   *
   * 原因：这个仓库是 pnpm 布局、不提升依赖，esbuild 只是 vite 的传递依赖，
   * 从 scripts/ 里 import('esbuild') 解析不到。而 vite 是直接的开发依赖，
   * 而且它本来就是这个项目跑 .ts / .tsx 的那条管道 —— 用它顺带也保证了
   * 编译结果与 pnpm build 一致（同一套 target 与转换）。
   */
  let vite;
  try {
    vite = await import('vite');
  } catch {
    console.error('找不到 vite —— 先在这个仓库里装依赖再跑这个脚本。');
    process.exit(1);
  }
  await vite.build({
    configFile: false,
    logLevel: 'error',
    build: {
      ssr: ENTRY,
      outDir: CLIDIR,
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        output: { entryFileNames: 'bundle.mjs' },
        external: ['react', 'react-dom', 'react-dom/client'],
      },
    },
  });
}

/**
 * **最小的浏览器桩**：在 import bundle 之前装好。
 *
 * 应用的模块在加载期就会碰 window / document / localStorage（主题引擎读样式、
 * store 从 localStorage 恢复）。Node 里没有这些，所以必须自己补上 ——
 * 这与仓库自动化测试里做的是同一件事。
 */
function installBrowserShim() {
  const mem = new Map();
  const el = () => ({
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    appendChild() {}, removeChild() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
    focus() {}, blur() {}, click() {},
    children: [], childNodes: [], textContent: "", innerHTML: "",
  });
  const doc = {
    documentElement: el(), body: el(), head: el(),
    createElement: () => el(), createTextNode: () => el(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.document = doc;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, writable: true,
    value: { userAgent: "plugin-cli", mediaDevices: { getDisplayMedia: async () => { throw new Error("denied"); } } },
  });
  globalThis.window = {
    setTimeout, clearTimeout, setInterval, clearInterval,
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    document: doc,
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); },
      clear: () => mem.clear(),
      key: (i) => [...mem.keys()][i] ?? null,
      get length() { return mem.size; },
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    location: { href: "http://localhost/", origin: "http://localhost" },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.self = globalThis;
}

installBrowserShim();
await buildBundle();
let M;
try {
  M = await import(pathToFileURL(BUNDLE).href);
} catch (e) {
  console.error('构建出来的包 import 失败：' + String(e.message));
  process.exit(1);
}

const st = () => M.useDesktopStore.getState();
M.registerBuiltinTools();
M.registerAllInterfaces();
M.registerBuiltinSurfaces();
M.registerModule('yggdrasil', { AgentIdContext: M.AgentIdContext, useAgent: M.useAgent, isAgentId: M.isAgentId, __esModule: true });
st().resetAll();

/*
 * 与自动化测试里同一套思路的本地执行器：把工具源码当函数表达式求值，
 * ctx.fetch 走 bridgeFetch（**真会做主机白名单校验**）。
 */
M.setToolExecutor(async (job) => {
  const logs = [];
  let fetches = 0;
  const ctx = {
    args: job.args,
    fields: job.fields,
    plugin: job.plugin,
    log: (t) => logs.push(String(t).slice(0, job.logChars ?? 400)),
    fetch: async (url, init) => {
      fetches += 1;
      if (job.maxFetches !== undefined && fetches > job.maxFetches) {
        throw new Error('超过联网配额（' + job.maxFetches + '）');
      }
      const r = await M.bridgeFetch(String(url), init, job.allowHosts, fetch, job.maxResponseBytes);
      if (r.error) throw new Error(String(r.error));
      return r;
    },
  };
  try {
    // eslint-disable-next-line no-new-func
    const fn = (0, eval)('(' + job.source + ')');
    if (typeof fn !== 'function') throw new Error('工具源码必须是一个函数');
    const value = await fn(job.args, ctx);
    return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)), logs, fetches };
  } catch (e) {
    return { ok: false, error: e.message, logs, fetches };
  }
});

// ---- 装配插件 ----
let manifest;
if (useDir) {
  const files = await loadFromDir(dirArg);
  const json = files['manifest.json'];
  if (!json) { console.error(dirArg + ' 里没有 manifest.json'); process.exit(1); }
  manifest = JSON.parse(json);
  // 走真正的校验器（与安装时同一份）
  const enc = new TextEncoder().encode(JSON.stringify({ format: 'yggdrasil.plugin', manifest, files }));
  const pkg = await M.parsePluginPackage(manifest.id + '.json', enc);
  st().installPlugin(pkg, dirArg);
  console.log('已安装（来自目录 ' + dirArg + '）: ' + pkg.manifest.name + ' v' + pkg.manifest.version);
} else {
  const path = join(process.cwd(), 'public', 'plugins', id + '.graft');
  let bytes;
  try { bytes = new Uint8Array(readFileSync(path)); }
  catch { console.error('找不到 ' + path + '。先打包：node scripts/build-plugin.mjs ' + id); process.exit(1); }
  const pkg = await M.parsePluginPackage(id + '.graft', bytes);
  st().installPlugin(pkg, id + '.graft');
  console.log('已安装: ' + pkg.manifest.name + ' v' + pkg.manifest.version + (pkg.signature === 'ok' ? '（签名有效）' : '（未签名）'));
  manifest = pkg.manifest;
}

// ---- 列出它提供什么 ----
const plugin = st().plugins.find((p) => p.id === manifest.id);
const kinds = M.knownKinds().filter((k) => k.indexOf(manifest.id + '.') === 0);
const toolEntries = M.toolCatalog().filter((t) => t.pluginId === manifest.id);
console.log('');
console.log('这个插件提供：');
const patches = (plugin.prompts ?? []);
const pages = (plugin.pages ?? []);
if (kinds.length === 0 && toolEntries.length === 0 && patches.length === 0 && pages.length === 0) {
  console.log('  （什么都没有）');
}
for (const k of kinds) console.log('  操作  ' + k);
for (const t of toolEntries) console.log('  工具  ' + t.name + '（' + t.id + '）—— 用 call_tool 调用');
if ((plugin.ui ?? []).length) console.log('  界面  ' + plugin.ui.map((u) => u.name).join('、') + '（用 plugin_ui 摆出来）');
/* 下面两类是"改核心"的能力，没有可调用的入口，所以单独列 —— 否则它们看起来像没提供任何东西。 */
for (const patch of patches) {
  const where = patch.op === 'insert' ? patch.anchor || 'end' : patch.section || '?';
  console.log('  提示词改动  ' + patch.op + ' @' + where +
    (patch.label ? '（' + patch.label + '）' : '') + ' —— 每轮拼提示词时生效，关掉插件立刻失效');
}
for (const pg of pages) {
  console.log('  页面与按钮  ' + pg.label + '（' + pg.file + '）' + (pg.open ? ' —— 默认打开' : ''));
}
console.log('');

const call = async (op) => {
  const r = await M.executeOps([op], 'root', { runId: 'cli', round: 1, sessionId: 'input' });
  const o = r.outcomes[0] || {};
  /*
   * call_tool 要**把工具名打出来**：否则一轮试跑里三行都是 "✗ call_tool"，
   * 根本不知道哪个失败了 —— 而"哪个失败"正是跑这一趟要的信息。
   */
  const label = op.kind === 'call_tool' ? 'call_tool ' + op.name : op.kind;
  console.log((o.ok ? '✓ ' : '✗ ') + label + (o.ok ? '' : ' — ' + o.message));
  const text = o.observation ?? o.message ?? '';
  if (o.ok && text) console.log(text.split('\n').map((l) => '    ' + l).join('\n'));
  if (o.ok && !text) console.log('    （没有回读）');
  return o.ok;
};

// ---- 没给具体调用就"各调一次"试跑 ----
if (rest.length === 0) {
  const examples = [];
  for (const e of manifest.endpoints ?? []) {
    const filled = { kind: manifest.id + '.' + e.name };
    for (const p of e.params ?? []) if (p.default !== undefined) filled[p.name] = p.default;
    examples.push(filled);
  }
  for (const t of manifest.tools ?? []) {
    if (t.exposeAs !== 'tool') {
      const filled = { kind: manifest.id + '.' + t.name };
      for (const p of t.params ?? []) if (p.default !== undefined) filled[p.name] = p.default;
      examples.push(filled);
    } else {
      const filled = { kind: 'call_tool', name: t.name, args: {} };
      for (const p of t.params ?? []) if (p.default !== undefined) filled.args[p.name] = p.default;
      examples.push(filled);
    }
  }
  if (examples.length === 0) {
    /*
     * 没有 op/tool 的插件（比如只改提示词 + 加页面）到这一步就是正常的：
     * 它不是"没有内容"，只是内容不在"可调用"这一侧。说清楚，别让人以为插件是空的。
     */
    const notes = [];
    if ((plugin.prompts ?? []).length) notes.push('提示词改动 ' + plugin.prompts.length + ' 处');
    if ((plugin.pages ?? []).length) notes.push('页面 ' + plugin.pages.length + ' 个');
    console.log(notes.length ? '没有可调用的操作/工具；它的内容是：' + notes.join(' + ') + '。'
      : '没有可自动试跑的内容。');
    process.exit(0);
  }
  console.log('自动试跑（只填了有默认值的参数；缺必填的会被明确拒绝 —— 那本身也是有用的信息）：');
  let ok = 0;
  for (const ex of examples) if (await call(ex)) ok += 1;
  console.log('');
  console.log(ok + '/' + examples.length + ' 个调用成功。');
  process.exit(0);
}

// ---- 显式指定一次调用 ----
/*
 * 两种写法，看这个能力是什么形态：
 *   <插件id>.<名字>        → 操作（直接调）
 *   tool:<名字>            → 工具（包成 call_tool 再调）
 * 用 tool: 前缀而不是让用户自己写 call_tool 的 JSON，是因为"它是操作还是工具"
 * 恰恰是这里最容易搞混的一点，让命令行把它说清楚。
 *
 * 参数优先用 --key=value（或 --key value）给，**不要求写 JSON**：
 * 在 PowerShell 里传一段带引号的 JSON 会被 shell 自己吃掉引号，
 * 失败信息还发生在 shell 层（SyntaxError: Expected property name），跟插件毫无关系 ——
 * 那是最劝退的一种用法。真要写 JSON 也支持（整串以 { 开头就按 JSON 解析）。
 */
const target = rest[0];
const argTokens = rest.slice(1);
let rawArgs = {};
if (argTokens.length === 1 && argTokens[0].trim().startsWith("{")) {
  rawArgs = JSON.parse(argTokens[0]);
} else {
  for (let i = 0; i < argTokens.length; i += 1) {
    const tok = argTokens[i];
    if (!tok.startsWith("--")) { console.error("参数要写成 --名字=值 或 --名字 值：" + tok); process.exit(1); }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) rawArgs[body.slice(0, eq)] = body.slice(eq + 1);
    else {
      const next = argTokens[i + 1];
      if (next === undefined) { console.error("--" + body + " 后面还差一个值"); process.exit(1); }
      rawArgs[body] = next; i += 1;
    }
  }
}
const op = target.startsWith('tool:')
  ? { kind: 'call_tool', name: target.slice(5), args: rawArgs }
  : { kind: target, ...rawArgs };
await call(op);

import type { SurfaceDef, SurfaceState } from '../types';

/**
 * 界面表面注册表。
 * Agent 通过它「看到」界面上有哪些可替换的插槽，并能覆写其中任意一个。
 * 新增插槽只需调用 registerSurface + 在渲染处读 useSurfaceSource。
 */
const defs = new Map<string, SurfaceDef>();
const states = new Map<string, SurfaceState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribeSurfaces(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerSurface(def: SurfaceDef): void {
  defs.set(def.id, def);
  emit();
}

export function listSurfaces(): SurfaceDef[] {
  return [...defs.values()];
}

export function getSurfaceDef(id: string): SurfaceDef | undefined {
  return defs.get(id);
}

export function getSurfaceState(id: string): SurfaceState | undefined {
  return states.get(id);
}

export function setSurfaceSource(id: string, source: string): void {
  states.set(id, { id, source, updatedAt: Date.now() });
  emit();
}

export function clearSurfaceSource(id: string): void {
  states.delete(id);
  emit();
}

/**
 * 导出当前所有覆写，供持久化。
 * 插槽状态原先只活在内存里，刷新即丢 —— 这是"改了背景但不会被保存"的根因。
 */
export function exportSurfaceStates(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, st] of states) out[id] = st.source;
  return out;
}

/** 从持久化数据恢复覆写。未知插槽（已不在注册表里）会被忽略。 */
export function importSurfaceStates(saved: Record<string, string> | undefined | null): void {
  states.clear();
  if (saved) {
    const known = new Set(defs.keys());
    for (const [id, source] of Object.entries(saved)) {
      if (!known.has(id)) continue;
      if (typeof source !== 'string') continue;
      states.set(id, { id, source, updatedAt: Date.now() });
    }
  }
  emit();
}

/**
 * 描述界面结构，供 LLM 阅读。
 *
 * 这里**只给目录**，不给源码 —— 源码可能很长，全部塞进系统提示会把上下文占满。
 * 所以每一项都附上"怎么读它"的命令：`inspect before="surface" surface=...`。
 * 没有这条指引的话，Agent 会卡在"抓不到这个插槽的源码"上（背景换 WebGL 就是这么卡的）。
 */
/**
 * 描述界面结构，供 LLM 阅读。
 *
 * `compact` 给系统提示用：只留 id / 名称 / 状态 / props，省掉那一句 description ——
 * 插槽的语义、内置实现、注意事项在「界面插槽」那一节已经讲过了，这里重复一遍只是占地方。
 * `inspect before="surface"` 与 `list_surfaces` 用完整版。
 */
export function surfacesText(compact = false): string {
  const list = listSurfaces();
  if (list.length === 0) return '（当前没有可替换的界面插槽）';
  return list
    .map((s) => {
      const cur = states.get(s.id);
      const state = cur
        ? `已被覆写（${cur.source.length} 字符）—— 看它当前源码：inspect before="surface" surface="${s.id}"`
        : '使用内置实现（读不到源码，看它长什么样：inspect before="surface"）';
      const hint = s.propsHint ? `；可用 props：${s.propsHint}` : '';
      const warn = s.critical
        ? `\n    ⚠ 关键插槽：承载窗口基础能力（${s.capabilityHint ?? '未知'}）。替换它会破坏这些能力，**不要动它**。`
        : '';
      const desc = compact ? '' : ` — ${s.description}`;
      return `- id=${s.id} 「${s.label}」${state}${desc}${hint}${warn}`;
    })
    .join('\n');
}

/** 列出被标记为 critical 的插槽 id。 */
export function criticalSurfaceIds(): string[] {
  return [...defs.values()].filter((d) => d.critical).map((d) => d.id);
}

/** 某个插槽是否承载基础能力。 */
export function isCriticalSurface(id: string): boolean {
  return defs.get(id)?.critical === true;
}

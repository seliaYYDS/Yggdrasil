import type { ResetPart } from '../kernel/types';

/**
 * 重置可以勾选的区块。
 *
 * 划分与 `.seed` 的区块一致（界面 / 组件 / 历史），这样"重置"与"导出"对同一件事的
 * 边界是一样的 —— 少一套要记的规则。多出来的 `logs` 是运行日志：它不进场景文件，
 * 但显然可以单独清掉。
 *
 * **设置不在其中**：重置始终保留连接与模型设置（含 API Key）。
 * 那是这个应用里唯一"清掉就要重新配一遍"的东西，不该混在批量清除里。
 */
export const RESET_PART_INFO: { id: ResetPart; label: string; hint: string }[] = [
  {
    id: 'interface',
    label: '界面',
    hint: '主题样式、界面插槽（背景 / 标题栏 / 效果层）、面板与输入框的位置与层级；输入框与其中的对话保留',
  },
  {
    id: 'components',
    label: '组件',
    hint: '所有组件与挂件（含各自 agent 的职责与能力）、回收站；基底 Agent 保留',
  },
  {
    id: 'history',
    label: 'Agent 历史',
    hint: '组件的对话记忆与账本、输入框里的对话；源码、位置与 agent 配置都保留',
  },
  {
    id: 'logs',
    label: '运行日志',
    hint: '运行日志，以及各会话与各 agent 的轨迹',
  },
];

/** 全选（重置对话框的默认值）。 */
export const ALL_RESET_PARTS: ResetPart[] = RESET_PART_INFO.map((p) => p.id);

/**
 * 把设置里存的值收敛成一个合法的勾选列表。
 *
 * 两条边界要分清：
 * - **字段缺失**（老数据、从没存过）→ 全选。这才是"默认全选"。
 * - **存了空数组** → 空。那是用户真的一个都没勾，不该被悄悄改回全选。
 */
export function normalizeResetParts(value: unknown): ResetPart[] {
  if (!Array.isArray(value)) return [...ALL_RESET_PARTS];
  const known = new Set<string>(ALL_RESET_PARTS);
  const out: ResetPart[] = [];
  for (const v of value) {
    if (typeof v === 'string' && known.has(v) && !out.includes(v as ResetPart)) out.push(v as ResetPart);
  }
  return out;
}

/** 一行摘要，重置确认框用。 */
export function describeResetParts(parts: ResetPart[]): string {
  if (parts.length === 0) return '（未勾选任何区块，不会清除任何内容）';
  return parts.map((id) => RESET_PART_INFO.find((x) => x.id === id)?.label ?? id).join(' + ');
}

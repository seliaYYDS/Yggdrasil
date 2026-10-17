import { useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { describeResetParts, normalizeResetParts, RESET_PART_INFO } from '../store/reset';
import type { ResetPart } from '../kernel/types';

/**
 * 重置：**按区块选**要清什么，默认全选（选择记在设置里，下次打开还是它）。
 *
 * 与导出对话框同一个形状是有意的 —— 两者面对的是同一批东西（界面 / 组件 / 历史），
 * 用同一套划分与同一套勾选交互，用户不必为"清"和"存"各学一遍。
 *
 * 两条边界：
 * - **设置不在可勾选项里。** 连接、模型与 API Key 是这个应用里唯一"清掉就要重新配一遍"
 *   的东西，把它混进批量清除只会制造一次不可撤销的灾难。对话框里明写它始终保留。
 * - **一个都不勾就不执行。** 那等于什么都没做，不如直接说清楚，别让用户以为生效了。
 */
export function ResetDialog() {
  const open = useDesktopStore((s) => s.resetOpen);
  const setOpen = useDesktopStore((s) => s.setResetOpen);
  const resetParts = useDesktopStore((s) => s.resetParts);
  const settings = useDesktopStore((s) => s.settings);
  const setSettings = useDesktopStore((s) => s.setSettings);
  const nodes = useDesktopStore((s) => s.nodes);
  const sessions = useDesktopStore((s) => s.sessions);
  const [busy, setBusy] = useState(false);

  /*
   * 勾选状态**取自设置**（上次的选择），缺省 = 全选。
   * 每次打开都读一次，所以上次勾的这次还在。
   */
  const [parts, setParts] = useState<ResetPart[]>(() => normalizeResetParts(settings.resetParts));

  if (!open) return null;

  const toggle = (id: ResetPart) => {
    setParts((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      // 立刻记进设置：用户下次打开时希望看到的是自己上次的选择，而不是"关掉就忘"。
      setSettings({ resetParts: next });
      return next;
    });
  };

  /** 每种区块现在到底有多少东西可清 —— 空的不该让人以为清了什么。 */
  const count = (id: ResetPart): string => {
    const comps = Object.values(nodes).filter((n) => n.kind === 'component' && !n.root);
    if (id === 'components') return comps.length ? comps.length + ' 个组件' : '当前没有组件';
    if (id === 'history') {
      const msgs =
        comps.reduce((n, c) => n + (c.kind === 'component' && c.agent ? c.agent.messages.length : 0), 0) +
        sessions.reduce((n, ses) => n + ses.messages.length, 0);
      return msgs ? msgs + ' 条记忆' : '当前没有记忆';
    }
    if (id === 'logs') {
      const steps = sessions.reduce((n, ses) => n + ses.trace.length, 0);
      return steps ? steps + ' 步轨迹' : '当前没有轨迹';
    }
    return '主题 / 插槽 / 面板位置';
  };

  const confirm = async () => {
    if (parts.length === 0) return;
    setBusy(true);
    try {
      await resetParts(parts);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const all = RESET_PART_INFO.length;
  const allOn = parts.length === all;
  const none = parts.length === 0;

  return (
    <div className="ygg-overlay" onClick={() => !busy && setOpen(false)}>
      <div className="ygg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ygg-confirm-text">
          重置：勾选要清除的内容。连接与模型设置（含 API Key）始终保留，此操作不可撤销。
        </div>
        {RESET_PART_INFO.map((p) => (
          <label className="ygg-seed-row" key={p.id}>
            <input type="checkbox" checked={parts.includes(p.id)} onChange={() => toggle(p.id)} />
            <span>
              {p.label}
              <span className="desc">{p.hint}</span>
            </span>
            <span className="ygg-reset-count">{count(p.id)}</span>
          </label>
        ))}
        <div className="ygg-seed-warn" style={{ color: none ? 'var(--ygg-danger)' : 'var(--ygg-fg-muted)' }}>
          {none ? '未勾选任何区块，不会清除任何内容。' : '将清除：' + describeResetParts(parts)}
        </div>
        <div className="ygg-modal-actions">
          <button
            className="ygg-btn ghost"
            disabled={busy || allOn}
            onClick={() => {
              setParts(RESET_PART_INFO.map((p) => p.id));
              setSettings({ resetParts: RESET_PART_INFO.map((p) => p.id) });
            }}
          >
            全选
          </button>
          <span style={{ flex: 1 }} />
          <button className="ygg-btn ghost" disabled={busy} onClick={() => setOpen(false)}>
            取消
          </button>
          <button className="ygg-btn danger" disabled={busy || none} onClick={() => void confirm()}>
            {busy ? '···' : '重置'}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';

/** 重置：清除除 API 设置外的全部数据。 */
export function ResetDialog() {
  const open = useDesktopStore((s) => s.resetOpen);
  const setOpen = useDesktopStore((s) => s.setResetOpen);
  const resetAll = useDesktopStore((s) => s.resetAll);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const confirm = async () => {
    setBusy(true);
    try {
      await resetAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ygg-overlay" onClick={() => !busy && setOpen(false)}>
      <div className="ygg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ygg-confirm-text">
          清除全部节点、窗口、轨迹与样式变量。API 设置保留。此操作不可撤销。
        </div>
        <div className="ygg-modal-actions">
          <button className="ygg-btn ghost" disabled={busy} onClick={() => setOpen(false)}>
            取消
          </button>
          <button className="ygg-btn danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? '···' : '重置'}
          </button>
        </div>
      </div>
    </div>
  );
}

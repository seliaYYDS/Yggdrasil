import { useEffect, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { getSurfaceDef } from '../kernel/registry/surfaceRegistry';

/** 确认弹窗存活时间：到点自动按"保留"处理（默认不还原）。 */
export const STRUCT_CONFIRM_MS = 10000;

/**
 * Agent 改了默认界面（常驻面板 / 窗口标题栏）的**结构**之后问一句：要不要还原。
 *
 * 为什么要有：默认界面是用户天天看的东西，结构被改未必马上看得出来，改坏了也不好恢复。
 * 三条约定：
 * - **只还原结构**：清掉插槽覆写；样式（全局 --ygg- 变量、节点局部变量）一律不碰；
 * - **默认不还原**：10 秒没人操作就按"保留"处理 —— 不能因为弹窗没被看到就把改动撤掉；
 * - 只列**本次任务**里改过的插槽；处理完清空，之后再改会重新弹。
 */
export function StructChangeDialog() {
  const slots = useDesktopStore((s) => s.structChanges);
  const resolve = useDesktopStore((s) => s.resolveStructChanges);
  const open = slots.length > 0;
  const [left, setLeft] = useState(Math.round(STRUCT_CONFIRM_MS / 1000));
  // 依赖用 join 成字符串：插槽列表每次都是新数组，直接当依赖会每秒重建定时器。
  const key = slots.join('+');

  useEffect(() => {
    if (!open) return;
    setLeft(Math.round(STRUCT_CONFIRM_MS / 1000));
    const tick = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    const timer = window.setTimeout(() => resolve(false), STRUCT_CONFIRM_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
  }, [open, key, resolve]);

  if (!open) return null;
  const names = slots.map((id) => getSurfaceDef(id)?.label ?? id);

  return (
    <div className="ygg-overlay" onClick={() => resolve(false)}>
      <div className="ygg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ygg-confirm-text">
          Agent 改动了默认界面结构：{names.join('、')}。还原仅恢复结构；样式改动保留。{left} 秒后自动保留。
        </div>
        <div className="ygg-modal-actions">
          <button className="ygg-btn ghost" onClick={() => resolve(true)}>
            还原结构
          </button>
          <button className="ygg-btn" onClick={() => resolve(false)}>
            保留
          </button>
        </div>
      </div>
    </div>
  );
}

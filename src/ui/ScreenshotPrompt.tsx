import { useEffect, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { submitInput } from '../kernel/agent/scheduler';
import { captureScreen, SCREENSHOT_TAG } from '../host/screen';

/**
 * 截图确认弹窗。
 *
 * 浏览器只在**用户手势**里允许 getDisplayMedia，所以 Agent 提出请求后必须由用户点一下。
 * 以前那个按钮嵌在输入框里，有三个问题（§5.149）：
 *
 * 1. **藏在角落里**：它只占输入框底下一小行，用户很容易没看见，
 *    而 Agent 正在那一头等着（它已经结束这一轮了）；
 * 2. **看不出是新的请求**：它只是个"存在/不存在"的按钮，第二次请求与第一次长得一样；
 * 3. **点了之后按钮先消失**：`clearPendingShot()` 排在 `await captureScreen()` 之前，
 *    用户取消权限弹窗时按钮已经没了 —— 看起来就是"点了没反应"。
 *
 * 现在做成弹窗：它在屏幕正中、写明是谁要的、并且**只有真的拿到图或用户取消之后才关**。
 */

/** 多等一会儿就自动关掉：Agent 可能已经跑完了，窗口不该一直挂着。 */
export const SHOT_PROMPT_MS = 30000;

export function ScreenshotPrompt() {
  const pending = useDesktopStore((s) => s.pendingShot);
  const clear = useDesktopStore((s) => s.clearPendingShot);
  const rootId = useDesktopStore((s) => s.rootId);
  /** 正在抓取（浏览器权限弹窗期间）—— 此时不能再点第二次。 */
  const [busy, setBusy] = useState(false);
  /** 上一次抓取失败的原因（用户取消等）。留着弹窗让他能再点一次。 */
  const [error, setError] = useState('');
  const [left, setLeft] = useState(Math.round(SHOT_PROMPT_MS / 1000));

  const id = pending?.id ?? null;
  const sessionId = pending?.sessionId ?? null;

  /*
   * 计时与"超时自动关"。依赖用请求 id 而不是整个对象：
   * 对象每次 render 都可能变，直接当依赖会把倒计时每秒重置。
   */
  useEffect(() => {
    if (!id) return;
    // 新的请求：把上一次的错误清掉，否则新弹窗一出来就带着旧报错。
    setError('');
    setLeft(Math.round(SHOT_PROMPT_MS / 1000));
    const tick = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    const timer = window.setTimeout(() => clear(), SHOT_PROMPT_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
  }, [id, clear]);

  if (!pending || !sessionId) return null;

  /**
   * 抓一张图并交给 Agent。
   *
   * 顺序是刻意的：**先在弹窗里抓、抓到了才关弹窗、才把图写进记忆**。
   * 失败（用户取消）时弹窗留着，用户可以直接再点一次 —— 不用等 Agent 重新请求。
   */
  const shoot = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await captureScreen();
      const store = useDesktopStore.getState();
      if (!r.ok) {
        store.log('warn', '截图 ✕ ' + r.error);
        // 留在弹窗里，让用户能重试（画面上给一行字，见下面的 state）。
        setError(r.error);
        return;
      }
      /*
       * **先丢掉上一张截图**，再把新的写进记忆。
       *
       * 不丢的话历史里会攒下多张快照：模型看到"已经有一张截图了"，下一次就会
       * 跳过新请求、拿旧图当这次的画面（用户报的"第二次略过且发的是第一张图"）。
       */
      store.dropScreenshotMessages(sessionId);
      store.appendSessionMessage(sessionId, {
        role: 'user',
        content: SCREENSHOT_TAG + ' 这是当前页面的真实截图。',
        images: [r.dataUrl],
      });
      store.log('op', '截图已进入上下文', sessionId);
      clear();
      // 自动追问一句，否则 Agent 要等用户下次说话才看得到这张图。
      submitInput(SCREENSHOT_TAG + ' 当前页面的截图已经附上，请查看并据此判断是否符合预期。', {
        sessionId,
        originId: rootId,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ygg-overlay" onClick={busy ? undefined : clear}>
      <div className="ygg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ygg-confirm-text">
          Agent 要看当前页面的真实截图。
          <br />
          截图需要你点一下（浏览器只允许在用户操作里抓屏）。
          {left > 0 ? ' ' + left + ' 秒后自动关闭。' : ''}
        </div>
        {error ? <div className="ygg-hint ygg-shot-error">{error}（可以再点一次）</div> : null}
        <div className="ygg-modal-actions">
          <button className="ygg-btn ghost" disabled={busy} onClick={clear}>
            忽略
          </button>
          <button className="ygg-btn" disabled={busy} onClick={() => void shoot()}>
            {busy ? '截图中…' : '截图并发送'}
          </button>
        </div>
      </div>
    </div>
  );
}

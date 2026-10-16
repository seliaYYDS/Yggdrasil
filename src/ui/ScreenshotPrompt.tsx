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

/**
 * 等浏览器**真的画过一帧**。
 *
 * 抓图之前必须让弹窗"已经从画面上消失"，而不能只是"React 状态改了" ——
 * 状态到像素之间还隔着一次提交与一次合成。两次 rAF 正好覆盖这两个阶段：
 * 第一次 rAF 回调时上一次提交已经上屏了，第二次再等一帧最稳妥。
 *
 * **但不能只靠 rAF**：后台标签页里 rAF 会被节流、甚至完全不触发，
 * 那样这个 Promise 永远不 resolve，截图就卡死了。所以再挂一个定时器兜底
 * （谁先到用谁）—— 正常情况下 rAF 快得多（约两帧），定时器只是保险。
 *
 * **导出是为了能被断言**：这条"有界的等待"是防卡死的关键（rAF 在后台标签页里不触发），
 * 而这种边界单靠读代码看不出来。
 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // 没有 rAF 的环境（很老的浏览器 / 某些测试宿主）直接用定时器。
    if (typeof window.requestAnimationFrame !== 'function') {
      window.setTimeout(finish, 32);
      return;
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
    window.setTimeout(finish, 120);
  });
}

export function ScreenshotPrompt() {
  const pending = useDesktopStore((s) => s.pendingShot);
  const clear = useDesktopStore((s) => s.clearPendingShot);
  const rootId = useDesktopStore((s) => s.rootId);
  /** 正在抓取（浏览器权限弹窗期间）—— 此时不能再点第二次。 */
  const [busy, setBusy] = useState(false);
  /**
   * 抓取期间**把自己整个从画面上撤掉**。
   *
   * 不撤的话弹窗会被截进去：浏览器抓的是"用户选中的那个画面"，而这个弹窗正好盖在最上面、
   * 还在屏幕正中 —— 截出来就是一张"弹窗照自己"（用户报的正是这个）。
   *
   * 用**整个卸载**而不是透明度动画：淡出一半的时候照样会被截到，
   * 瞬时消失才干净。卸载的只是这一层（position:fixed），桌面不会因此重排。
   */
  const [hiding, setHiding] = useState(false);
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
    /*
     * **抓取期间不倒数、也不自动关**：用户此刻可能正在浏览器那个选择器里挑画面，
     * 挑多久都不该被我们这边的倒计时打断。
     */
    if (hiding) return;
    // 新的请求：把上一次的错误清掉，否则新弹窗一出来就带着旧报错。
    setError('');
    setLeft(Math.round(SHOT_PROMPT_MS / 1000));
    const tick = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    const timer = window.setTimeout(() => clear(), SHOT_PROMPT_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
  }, [id, clear, hiding]);

  // hiding 时不渲染 —— 这就是"从画面上撤掉"。
  if (!pending || !sessionId || hiding) return null;

  /**
   * 抓一张图并交给 Agent。
   *
   * 顺序是刻意的，**两步都不能省**：
   * 1. 先把自己从画面上撤掉（setHiding → 等真的画过一帧）；
   * 2. 再抓。
   *
   * 只做第 1 步不等，抓到的很可能仍是"包含弹窗"的那一帧：状态改了、画面上还没变。
   * 失败（用户取消）时把弹窗放回来，用户可以直接再点一次 —— 不用等 Agent 重新请求。
   */
  const shoot = async () => {
    if (busy) return;
    setBusy(true);
    setHiding(true);
    try {
      // 等浏览器把"弹窗没了"这件事真的画出来，再去抓。
      await nextPaint();
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
      // 成功时 pending 已经清了（上面那句 clear），这里只是把失败的情况放回来。
      setBusy(false);
      setHiding(false);
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

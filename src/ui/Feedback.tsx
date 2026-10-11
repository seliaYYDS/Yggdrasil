import { useEffect, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';

/** 运行结束后在输入窗口上方弹一条成败反馈，4 秒后自动淡出。 */
export function Feedback() {
  const feedback = useDesktopStore((s) => s.feedback);
  const setFeedback = useDesktopStore((s) => s.setFeedback);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!feedback) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = window.setTimeout(() => {
      setVisible(false);
      window.setTimeout(() => setFeedback(null), 260);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [feedback, setFeedback]);

  if (!feedback) return null;

  return (
    <div
      className={'ygg-toast is-' + feedback.level + (visible ? ' is-in' : '')}
      onClick={() => setFeedback(null)}
      role="status"
    >
      <div className="t">{feedback.title}</div>
      {feedback.detail ? <div className="d">{feedback.detail}</div> : null}
    </div>
  );
}

import { useDesktopStore } from '../store/desktopStore';
import { submitInput } from '../kernel/agent/scheduler';
import { numberOfSessionId } from '../store/desktopStore';

/**
 * 控制台报错 → 问用户要不要让 Agent 来修。
 *
 * 两个细节：
 * - **发给序号最小的输入框**（用户指定）。多开输入框时如果没有这条规则，
 *   同一个错误可能被发进「最后打开的那个」，而那是用户正在用的框。
 * - 请求里带上「怎么修」的要求，避免它又整段重写（见提示词里那一节）。
 */
function smallestSessionId(): string | null {
  const sessions = useDesktopStore.getState().sessions;
  if (sessions.length === 0) return null;
  return [...sessions].sort((a, b) => numberOfSessionId(a.id) - numberOfSessionId(b.id))[0].id;
}

export function ConsoleErrorPrompt() {
  const prompt = useDesktopStore((s) => s.consolePrompt);
  const dismiss = useDesktopStore((s) => s.dismissConsolePrompt);
  if (!prompt) return null;

  const ask = () => {
    const id = smallestSessionId();
    dismiss();
    if (!id) return;
    submitInput(
      [
        '控制台报错了，请处理：',
        '',
        prompt.text,
        '',
        '怎么处理：',
        '1. 先 `inspect before="logs"` 看最近日志，再 `inspect before="component" id=...` 看相关组件的**当前源码**，判断这个错是哪个组件（或哪一步）造成的；',
        '2. 如果是某个组件的源码问题，用 `patch_source` **定点修** —— 不要整段重写、不要删掉重建；',
        '3. 如果判断问题出在 Yggdrasil 宿主自身（不是任何组件的源码），**不要乱改别人的组件**：用一个普通组件把结论写给用户看（哪一条报错、你为什么认为改不了）。',
      ].join('\n'),
      { sessionId: id },
    );
  };

  return (
    <div className="ygg-overlay" onClick={dismiss}>
      <div className="ygg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ygg-confirm-text">控制台出现报错，要让 Agent 尝试修复吗？</div>
        <pre className="ygg-log ygg-code ygg-error-text">{prompt.text}</pre>
        <div className="ygg-modal-actions">
          <button className="ygg-btn ghost" onClick={dismiss}>
            忽略
          </button>
          <button className="ygg-btn" onClick={ask}>
            让 Agent 修复
          </button>
        </div>
      </div>
    </div>
  );
}

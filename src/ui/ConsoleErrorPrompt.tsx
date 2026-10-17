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
        '',
        /*
         * 顺序是刻意的：**先读控制台，再考虑改东西**。
         *
         * 这里以前写的是「先 inspect before=logs」—— 而 logs 是**运行时账本**（谁调了什么操作、
         * 失败在哪儿），它的内容往往是「某个操作成功了」。真正写着异常原文的是**浏览器控制台**
         * （未捕获异常、console.error/warn、组件自己打的字）。用 logs 打头的结果是：
         * Agent 看不到具体错误，于是开始猜着改组件 —— 用户报的正是这个。
         */
        '1. `inspect before="console" level="error"` —— **先读异常原文**（浏览器控制台：未捕获异常、',
        '   console.error / warn、组件自己打印的内容）。看不清就放宽到 `before="console"`；',
        '2. `inspect before="logs"` 看运行时账本（哪个操作执行过、失败在哪一步），与上一条互相印证；',
        '3. `inspect before="component" id=...` 看相关组件的**当前源码**，确定这个错是哪个组件造成的；',
        '4. 是某个组件的源码问题 → 用 `patch_source` **定点修**，不要整段重写、不要删掉重建；',
        '5. **没有读到具体的报错原文之前，不要改任何组件** —— 盲改会把一个坏组件变成好几个；',
        '6. 如果判断问题出在 Yggdrasil 宿主自身（不是任何组件的源码），**不要乱改别人的组件**：',
        '   用一个普通组件把结论写给用户看（哪一条报错、你为什么认为改不了）。',
      ].join('\n'),
      { sessionId: id },
    );
  };

  return (
    <div className="ygg-overlay" onClick={dismiss}>
      <div className="ygg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ygg-confirm-text">控制台出现报错。是否让 Agent 尝试修复？</div>
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

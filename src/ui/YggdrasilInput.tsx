import { useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore } from '../store/desktopStore';
import { submitInput } from '../kernel/agent/scheduler';
import { PanelWindow } from './PanelWindow';

/** 队列每一项占的高度，以及最多撑高几项（再多就在队列框里滚动）。 */
const QUEUE_ROW_H = 22;
const QUEUE_MAX_ROWS = 2;

/** 输入行高与最多长到几行（内容多时输入框自己变高，窗口跟着长）。 */
const LINE_H = 26;
const MAX_LINES = 6;

export function YggdrasilInput() {
  const [text, setText] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** 输入法正在拼字。拼字期间的回车是"确认候选词"，不是"发送"。 */
  const composing = useRef(false);
  const [areaH, setAreaH] = useState(LINE_H);
  const running = useDesktopStore((s) => s.status.running);
  const phase = useDesktopStore((s) => s.status.phase);
  const detail = useDesktopStore((s) => s.status.detail);
  const queue = useDesktopStore((s) => s.queue);
  const removeQueued = useDesktopStore((s) => s.removeQueued);
  // 只订阅"每条队列项的目标名字"，不订阅整棵节点树 ——
  // 否则拖动窗口时每个 pointermove 都会把输入窗口一起重渲染。
  const queueTargets = useDesktopStore(
    useShallow((s) =>
      s.queue.map((q) => (q.originId !== s.rootId ? s.nodes[q.originId]?.name ?? '已删除' : '')),
    ),
  );

  // 正在跑、或者还有排队项没消化完，都算"忙"：此时提交进入队列而不是被拒。
  const busy = running || queue.length > 0;

  /**
   * 提交。
   *
   * 两点是"内容被吞掉 / 读回上一条"的根治：
   * 1. **直接读 textarea 的当前值**，不读 React state —— 中文输入法确认候选词的瞬间，
   *    state 可能还停在上一帧，读 state 就会把上一条内容再发一次。
   * 2. **确认真的收下了才清空**。先清空再提交，一旦提交没被接受，用户的话就没了。
   */
  const submit = () => {
    const el = areaRef.current;
    const value = (el ? el.value : text).trim();
    if (!value) return;
    // 空闲就立刻开跑，忙碌就排队 —— 由调度器判断，界面不需要知道。
    if (submitInput(value)) setText('');
  };

  /**
   * 输入框内容自适应：先把高度清成 auto 量一次 scrollHeight，再夹到 [1 行, 6 行]。
   * Shift+Enter 换行、粘贴长文本都会自动长高，清空后缩回一行。
   */
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, LINE_H), LINE_H * MAX_LINES);
    el.style.height = next + 'px';
    setAreaH(next);
  }, [text]);

  // 有排队项时窗口临时长高一点（最多两项），队列清空后自动缩回。
  const growth = Math.min(queue.length, QUEUE_MAX_ROWS) * QUEUE_ROW_H;
  // 输入框长高了，窗口也得跟着长，否则会被窗口的 min-height 卡住。
  const areaExtra = Math.max(0, areaH - LINE_H);

  return (
    <PanelWindow
      panel="input"
      title="Yggdrasil"
      minW={300}
      minH={70}
      minHeightCss={70 + growth + areaExtra}
    >
      <div className="ygg-compose">
        {queue.length > 0 ? (
          <div className="ygg-queue">
            {queue.map((q, i) => (
              <div className="ygg-queue-item" key={q.id}>
                <span className="ygg-queue-idx">{i + 1}</span>
                <span className="ygg-queue-text">{q.text}</span>
                {queueTargets[i] ? <span className="ygg-queue-to">{queueTargets[i]}</span> : null}
                <button
                  className="ygg-queue-del"
                  title="移出队列"
                  onClick={() => removeQueued(q.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="ygg-compose-row">
          <textarea
            ref={areaRef}
            className="ygg-compose-area"
            value={text}
            placeholder={busy ? '排队发送…' : '描述你想让 Yggdrasil 做什么…'}
            rows={1}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              /*
               * 中文输入法用回车**确认候选词**，那不是"发送"。
               * 不拦住的话：发出去的是还没提交的拼音、或者上一帧的旧内容 ——
               * 这正是"排队系统把内容吞掉/读回上一条"的根因。
               */
              if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            className={'ygg-compose-send' + (busy ? ' is-queue' : '')}
            disabled={!text.trim()}
            title={busy ? '加入队列' : '发送'}
            onClick={submit}
          >
            {busy ? '⇥' : '↑'}
          </button>
        </div>

        <div className={'ygg-compose-state' + (busy ? ' is-busy' : '')}>
          {busy ? (
            <>
              <span className="ygg-spin" />
              <span className="ygg-compose-text">{phase || '处理中'}</span>
              {queue.length > 0 ? (
                <span className="ygg-compose-queued">{queue.length} 条排队</span>
              ) : null}
              {detail ? <span className="ygg-compose-detail">{detail}</span> : null}
            </>
          ) : (
            <span className="ygg-compose-hint">Enter 发送 · Shift+Enter 换行</span>
          )}
        </div>
      </div>
    </PanelWindow>
  );
}

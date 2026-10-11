import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore } from '../store/desktopStore';
import { submitInput } from '../kernel/agent/scheduler';
import { PanelWindow } from './PanelWindow';

/** 队列每一项占的高度，以及最多撑高几项（再多就在队列框里滚动）。 */
const QUEUE_ROW_H = 22;
const QUEUE_MAX_ROWS = 2;

export function YggdrasilInput() {
  const [text, setText] = useState('');
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

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    // 空闲就立刻开跑，忙碌就排队 —— 由调度器判断，界面不需要知道。
    submitInput(value);
  };

  // 有排队项时窗口临时长高一点（最多两项），队列清空后自动缩回。
  const growth = Math.min(queue.length, QUEUE_MAX_ROWS) * QUEUE_ROW_H;

  return (
    <PanelWindow panel="input" title="Yggdrasil" minW={300} minH={70} minHeightCss={70 + growth}>
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
            className="ygg-compose-area"
            value={text}
            placeholder={busy ? '排队发送…' : '描述你想让 Yggdrasil 做什么…'}
            rows={1}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
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

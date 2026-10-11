import { useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore } from '../store/desktopStore';
import { submitInput } from '../kernel/agent/scheduler';
import { PanelWindow } from './PanelWindow';

/*
 * 下面这些常量必须与 global.css 里的实际值一致 ——
 * 输入窗口的"最小高度"是算出来的，算错就会出现内容被裁、或者上方留一块死白。
 */
const TITLEBAR_H = 28; // .ygg-titlebar height
const COMPOSE_PAD_V = 16; // .ygg-compose padding 8px 上下
const GAP = 5; // .ygg-compose gap
const STATE_H = 15; // .ygg-compose-state min-height

const QUEUE_ITEM_H = 18; // .ygg-queue-item height
const QUEUE_GAP = 2; // .ygg-queue gap
const QUEUE_PAD_V = 6; // .ygg-queue padding 3px 上下
const QUEUE_MAX_ROWS = 2; // 再多就在队列框里滚动

/** 输入行高与最多长到几行（内容多时输入框自己变高，窗口跟着长）。 */
const LINE_H = 26;
const MAX_LINES = 6;

/**
 * 输入窗口需要的最小高度。
 *
 * 这是修过的：之前的写法是 `70 + 队列高度 + 输入框增量`，那个 70 没算标题栏与状态行，
 * 比实际需要少 20px 左右 —— 于是窗口总是不够高，输入区被窗口 body 的滚动条裁掉一截，
 * 看起来就是"输入区域大小固定、只是贴在底部"。
 */
export function inputMinHeight(areaH: number, queueCount: number): number {
  const rows = Math.min(Math.max(queueCount, 0), QUEUE_MAX_ROWS);
  const queueH = rows > 0 ? rows * QUEUE_ITEM_H + (rows - 1) * QUEUE_GAP + QUEUE_PAD_V : 0;
  return (
    TITLEBAR_H +
    COMPOSE_PAD_V +
    queueH +
    (queueH > 0 ? GAP : 0) +
    areaH +
    GAP +
    STATE_H
  );
}

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
   * 输入框按内容自适应：量出"内容自然高度"（1~6 行），并写成 **min-height**。
   *
   * 关键两点：
   * - 量之前先把"拉伸"与旧的 min-height 摘掉 —— 否则量到的是被拉伸后的高度，
   *   只会越量越高，再也缩不回去。
   * - 写回的是 min-height 而不是 height：窗口被手动拉高时，输入区会**填满**那块空间，
   *   而不是缩成一行贴在底部（这正是"输入区域固定、只是贴在底部"的成因）。
   */
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.minHeight = '0px';
    el.style.alignSelf = 'flex-start';
    const natural = el.scrollHeight;
    el.style.height = '';
    el.style.alignSelf = '';
    const next = Math.min(Math.max(natural, LINE_H), LINE_H * MAX_LINES);
    el.style.minHeight = next + 'px';
    setAreaH(next);
  }, [text]);

  const needed = inputMinHeight(areaH, queue.length);

  /**
   * 把"内容需要多高"同步回面板矩形。
   *
   * 只靠 CSS 的 min-height 会让窗口**向下**长高 —— 输入框本来就贴底，
   * 一长高就顶出屏幕底部。所以这里以**底边为锚**：变高时 y 一起上移。
   * 用户手动拉高过（当前高度不等于上次自动值）就不缩回去，尊重用户。
   */
  const autoH = useRef(0);
  useLayoutEffect(() => {
    const s = useDesktopStore.getState();
    const r = s.inputRect;
    if (needed === r.h) return;
    const userResized = r.h !== autoH.current;
    if (needed < r.h && userResized) return;
    autoH.current = needed;
    s.setPanelRect('input', { ...r, y: Math.max(0, r.y + r.h - needed), h: needed });
  }, [needed]);

  return (
    <PanelWindow
      panel="input"
      title="Yggdrasil"
      minW={300}
      minH={70}
      // 内容需要的最小高度；矩形由上面的 effect 同步，两者始终一致。
      minHeightCss={needed}
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

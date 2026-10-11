import { useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore, type InputSession } from '../store/desktopStore';
import { submitInput } from '../kernel/agent/scheduler';
import { WindowFrame } from '../host/WindowFrame';
import { imageFilesFromClipboard, MAX_IMAGES, prepareImage, type PreparedImage } from '../host/image';
import { NewInputIcon } from './icons';

/*
 * 下面这些常量必须与 global.css 里的实际值一致 ——
 * 输入窗口的"最小高度"是算出来的，算错就会出现内容被裁、或者上方留一块死白。
 */
const TITLEBAR_H = 28; // .ygg-titlebar height
const COMPOSE_PAD_V = 16; // .ygg-compose padding 8px 上下
const GAP = 5; // .ygg-compose gap
const STATE_H = 15; // .ygg-compose-state min-height

const IMAGE_STRIP_H = 46; // .ygg-images 一行缩略图的高度
const PENDING_H = 20; // .ygg-pending 行高
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
export function inputMinHeight(
  areaH: number,
  queueCount: number,
  pendingCount = 0,
  imageCount = 0,
): number {
  const rows = Math.min(Math.max(queueCount, 0), QUEUE_MAX_ROWS);
  const queueH = rows > 0 ? rows * QUEUE_ITEM_H + (rows - 1) * QUEUE_GAP + QUEUE_PAD_V : 0;
  const pendingH = pendingCount > 0 ? PENDING_H + GAP : 0;
  const imageH = imageCount > 0 ? IMAGE_STRIP_H + GAP : 0;
  return (
    TITLEBAR_H +
    COMPOSE_PAD_V +
    pendingH +
    imageH +
    queueH +
    (queueH > 0 ? GAP : 0) +
    areaH +
    GAP +
    STATE_H
  );
}

/**
 * 一个输入框 = 一个独立的 Agent 会话。
 *
 * 多个输入框共享底层记忆（桌面、基底的对话历史与账本），
 * 但**不共享工作状态** —— 各自有各自的队列、进度与轨迹，可以同时跑。
 */
export function YggdrasilInput({ session }: { session: InputSession }) {
  const [text, setText] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** 输入法正在拼字。拼字期间的回车是"确认候选词"，不是"发送"。 */
  const composing = useRef(false);
  const [areaH, setAreaH] = useState(LINE_H);
  /** 粘贴 / 拖进来的图片。提交时随请求一起发给模型。 */
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [imageError, setImageError] = useState('');

  /*
   * 订阅**这一个会话**：`find` 在没变化时返回同一个对象引用，
   * 所以两个输入框同时在跑时，各自只在自己的状态变了才重渲染。
   */
  const live = useDesktopStore((s) => s.sessions.find((x) => x.id === session.id)) ?? session;
  const { status, queue, rect, z, title, minimized } = live;
  const running = status.running;
  const phase = status.phase;
  const detail = status.detail;
  const removeQueued = useDesktopStore((s) => s.removeQueued);
  const pendingOpen = useDesktopStore((s) => s.pendingOpen);
  const clearPendingOpen = useDesktopStore((s) => s.clearPendingOpen);
  const setSessionRect = useDesktopStore((s) => s.setSessionRect);
  const removeSession = useDesktopStore((s) => s.removeSession);
  const focusedId = useDesktopStore((s) => s.focusedId);
  const bringToFront = useDesktopStore((s) => s.bringToFront);
  const requestMinimize = useDesktopStore((s) => s.requestMinimize);
  const sessionCount = useDesktopStore((s) => s.sessions.length);

  // 只订阅"每条队列项的目标名字"，不订阅整棵节点树 ——
  // 否则拖动窗口时每个 pointermove 都会把输入窗口一起重渲染。
  const queueTargets = useDesktopStore(
    useShallow((s) => {
      const ses = s.sessions.find((x) => x.id === session.id);
      return (ses ? ses.queue : []).map((q) =>
        q.originId !== s.rootId ? s.nodes[q.originId]?.name ?? '已删除' : '',
      );
    }),
  );

  // 正在跑、或者还有排队项没消化完，都算"忙"：此时提交进入队列而不是被拒。
  const busy = running || queue.length > 0;

  /** 提交。读 DOM 当前值（输入法状态可能滞后），确认收下才清空。 */
  const submit = () => {
    const el = areaRef.current;
    const value = (el ? el.value : text).trim();
    // 只有图片没有文字也应该能发（"看看这张图"）。
    if (!value && images.length === 0) return;
    const accepted = submitInput(value, {
      sessionId: session.id,
      images: images.map((im) => im.dataUrl),
    });
    if (accepted) {
      setText('');
      setImages([]);
      setImageError('');
    }
  };

  /** 粘贴 / 拖进来的图片：压缩后挂到待发送列表上。 */
  const addImages = async (files: File[]) => {
    if (files.length === 0) return;
    setImageError('');
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setImageError('最多 ' + MAX_IMAGES + ' 张图片');
      return;
    }
    const prepared = await Promise.all(files.slice(0, room).map((f) => prepareImage(f)));
    const okList = prepared.filter((x): x is PreparedImage => !!x);
    if (okList.length === 0) {
      setImageError('这张图片读不出来（格式不支持？）');
      return;
    }
    setImages((prev) => [...prev, ...okList].slice(0, MAX_IMAGES));
    if (files.length > room) setImageError('最多 ' + MAX_IMAGES + ' 张图片，多余的已忽略');
  };

  /** 输入框按内容自适应：量出内容自然高度（1~6 行），写成 min-height。 */
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

  const needed = inputMinHeight(areaH, queue.length, pendingOpen.length, images.length);

  /**
   * 把"内容需要多高"同步回会话矩形。
   * 以**底边为锚**：变高时 y 一起上移，否则贴底的输入框会顶出屏幕底部。
   * 用户手动拉高过（当前高度不等于上次自动值）就不缩回去。
   */
  const autoH = useRef(0);
  useLayoutEffect(() => {
    if (needed === rect.h) return;
    const userResized = rect.h !== autoH.current;
    if (needed < rect.h && userResized) return;
    autoH.current = needed;
    setSessionRect(session.id, { ...rect, y: Math.max(0, rect.y + rect.h - needed), h: needed });
  }, [needed, session.id, rect, setSessionRect]);

  // 最小化后交给任务栏渲染，这里什么都不画。
  if (minimized) return null;

  return (
    <WindowFrame
      id={session.id}
      title={title}
      rect={rect}
      zIndex={z}
      focused={focusedId === session.id}
      onRect={(r) => setSessionRect(session.id, r)}
      onFocus={() => bringToFront(session.id)}
      onMinimize={() => requestMinimize(session.id)}
      // 只剩一个时不给关：全关掉就没有入口了。
      onDelete={sessionCount > 1 ? () => removeSession(session.id) : undefined}
      minW={300}
      minH={70}
      minHeightCss={needed}
    >
      <div className="ygg-compose">
        {/*
          被弹窗拦截的页面：网页只能在"用户手势"里开新窗口，所以这里由用户点一下。
          点这个按钮就是真正的手势，window.open 不会被拦。
        */}
        {pendingOpen.length > 0 ? (
          <button
            className="ygg-pending"
            title={pendingOpen.map((p) => p.url).join('\n')}
            onClick={() => {
              for (const p of pendingOpen) {
                try {
                  window.open(p.url, '_blank');
                } catch {
                  /* 用户禁用了弹窗就只能作罢 */
                }
              }
              clearPendingOpen();
            }}
          >
            <span className="ygg-pending-dot" />
            打开 {pendingOpen.length} 个被拦截的页面
          </button>
        ) : null}

        {/* 粘贴 / 拖进来的图片：先在这里确认一眼，再随请求发出去 */}
        {images.length > 0 ? (
          <div className="ygg-images">
            {images.map((im, i) => (
              <div className="ygg-image" key={i}>
                <img src={im.dataUrl} alt={'图片 ' + (i + 1)} title={im.note} />
                <button
                  className="ygg-image-del"
                  title="移除这张图片"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {queue.length > 0 ? (
          <div className="ygg-queue">
            {queue.map((q, i) => (
              <div className="ygg-queue-item" key={q.id}>
                <span className="ygg-queue-idx">{i + 1}</span>
                {q.images?.length ? <span className="ygg-queue-img">图 {q.images.length}</span> : null}
                <span className="ygg-queue-text">{q.text || '（图片）'}</span>
                {queueTargets[i] ? <span className="ygg-queue-to">{queueTargets[i]}</span> : null}
                <button
                  className="ygg-queue-del"
                  title="移出队列"
                  onClick={() => removeQueued(session.id, q.id)}
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
            placeholder={
              busy ? '排队发送…' : images.length > 0 ? '说说这张图要做什么…' : '描述你想让 Yggdrasil 做什么…'
            }
            rows={1}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // 截图直接 Ctrl+V 粘进来。有图片时不要让它变成文字。
              const files = imageFilesFromClipboard(e.clipboardData);
              if (files.length > 0) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
            }}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
                f.type.startsWith('image/'),
              );
              if (files.length > 0) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => {
              /*
               * 中文输入法用回车**确认候选词**，那不是"发送"。
               * 不拦住的话：发出去的是还没提交的拼音、或者上一帧的旧内容。
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
            disabled={!text.trim() && images.length === 0}
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
            <span className="ygg-compose-hint">
              <NewInputIcon width={11} height={11} />
              {imageError
                ? imageError
                : images.length > 0
                  ? images.length + ' 张图片将随请求发出'
                  : 'Enter 发送 · Shift+Enter 换行 · 可粘贴图片'}
            </span>
          )}
        </div>
      </div>
    </WindowFrame>
  );
}

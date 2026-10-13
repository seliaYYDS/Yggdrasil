import { useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  avgTps,
  hitRate,
  stepHitRate,
  useDesktopStore,
  type InputSession,
  type SessionMetrics,
} from '../store/desktopStore';
import { stopRun, submitInput } from '../kernel/agent/scheduler';
import { QueueIcon, SendIcon, StopIcon } from './icons';
import { captureScreen } from '../host/screen';
import { WindowFrame } from '../host/WindowFrame';
import { formatBytes } from '../kernel/workspace/store';
import {
  MAX_UPLOAD_FILES,
  checkFileLocally,
  filesFromClipboard,
  uploadedFilesNote,
  uploadFiles,
  type UploadedFile,
} from '../kernel/workspace/upload';

/*
 * 下面这些常量必须与 global.css 里的实际值一致 ——
 * 输入窗口的"最小高度"是算出来的，算错就会出现内容被裁、或者上方留一块死白。
 */
const TITLEBAR_H = 28; // .ygg-titlebar height
const COMPOSE_PAD_V = 16; // .ygg-compose padding 8px 上下
const GAP = 5; // .ygg-compose gap
const STATE_H = 15; // .ygg-compose-state min-height

const FILE_STRIP_H = 24; // .ygg-files 一行文件条的高度
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
/** 12,345 → 12.3k；小于 1000 原样。指标要在一行里放下，所以必须紧凑。 */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

/**
 * 右下角那三个数，**都是这个会话的整体值**：
 * 整体命中率 · 整体 tok/s · token 总和。
 *
 * 没跑过就返回空串 —— 调用方据此**整块不渲染**（不留占位、不显示"—"）。
 */
function metricsText(m?: SessionMetrics): string {
  if (!m || m.runs === 0) return '';
  const total = compactCount(m.tokensIn + m.tokensOut);
  /*
   * 主显示是**最近一次请求**的命中率，不是累计值。
   *
   * 累计值被冷启动拖着：每个会话的第一次请求必然 0%，压缩改写历史之后那一次也一样 ——
   * 短会话里它根本反映不出缓存有没有起作用（用户看到的"命中率太低"有一半是这个口径造成的）。
   */
  const rate = stepHitRate(m);
  const rateText = rate === null ? '—' : Math.round(rate * 100) + '%';
  const speed = avgTps(m).toFixed(1);
  // 有一位是估算的就在整串前面加 ~：三个数里最可能被当成精确值的就是它们。
  return (m.exact ? '' : '~') + '命中 ' + rateText + ' · ' + speed + ' tok/s · ' + total;
}

export function inputMinHeight(
  areaH: number,
  queueCount: number,
  pendingCount = 0,
  fileCount = 0,
): number {
  const rows = Math.min(Math.max(queueCount, 0), QUEUE_MAX_ROWS);
  const queueH = rows > 0 ? rows * QUEUE_ITEM_H + (rows - 1) * QUEUE_GAP + QUEUE_PAD_V : 0;
  const pendingH = pendingCount > 0 ? PENDING_H + GAP : 0;
  // 上传的文件条比图片缩略图矮（没有缩略图），所以单独一个高度常量。
  const fileH = fileCount > 0 ? FILE_STRIP_H + GAP : 0;
  return (
    TITLEBAR_H +
    COMPOSE_PAD_V +
    pendingH +
    fileH +
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
  /**
   * **待发送**的文件（还没入库）。
   *
   * 关键点：粘贴/拖入时**只把它们拿在手里**，不进工作区、也不进任何存储 ——
   * 因为用户可能只是想看看、或者根本没打算发（"我粘错了"）。
   * 真正的写入发生在**点发送**那一刻（见 submit）。
   *
   * 这样也避免了：随手粘一张图就在工作区里留一个文件、还得去面板里删掉。
   */
  const [pending, setPending] = useState<File[]>([]);
  /** 本地就能判定的问题（空文件 / 太大），在还没发送时就显示出来。 */
  const [uploadError, setUploadError] = useState('');

  /*
   * 订阅**这一个会话**：`find` 在没变化时返回同一个对象引用，
   * 所以两个输入框同时在跑时，各自只在自己的状态变了才重渲染。
   */
  const live = useDesktopStore((s) => s.sessions.find((x) => x.id === session.id)) ?? session;
  // metrics 跟着会话走：每个输入框显示自己的用量。
  const { status, queue, rect, z, title, minimized, metrics } = live;
  const running = status.running;
  const phase = status.phase;
  const detail = status.detail;
  const removeQueued = useDesktopStore((s) => s.removeQueued);
  const pendingOpen = useDesktopStore((s) => s.pendingOpen);
  const pendingShot = useDesktopStore((s) => s.pendingShot);
  const clearPendingShot = useDesktopStore((s) => s.clearPendingShot);
  const shotMine = pendingShot?.sessionId === session.id;
  const clearPendingOpen = useDesktopStore((s) => s.clearPendingOpen);
  const setSessionRect = useDesktopStore((s) => s.setSessionRect);
  const requestCloseSession = useDesktopStore((s) => s.requestClose);
  const resizing = useDesktopStore((s) => s.resizing);
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

  /**
   * 提交。**文件是在这里才真正写进工作区的**。
   *
   * 顺序很重要：先把文件上传成功，再把这条消息交给调度器 ——
   * 否则 Agent 收到的"有哪些文件"和实际在工作区里的东西可能对不上。
   * 失败的文件**留在输入框里**（连同原因），让用户可以重试，而不是悄悄消失。
   */
  const submit = () => {
    const el = areaRef.current;
    const raw = (el ? el.value : text).trim();
    // 只有文件没有文字也应该能发（"看看这个"）。
    if (!raw && pending.length === 0) return;
    void (async () => {
      let uploaded: UploadedFile[] = [];
      if (pending.length > 0) {
        const res = await uploadFiles(pending);
        uploaded = res.ok;
        // 失败的留在框里：用户看得见原因，也能再点一次发送重试。
        setPending(res.failed.map((f) => f.file));
        setUploadError(res.errors.join('\n'));
        if (uploaded.length === 0) {
          // 一个都没成功：这次不发了，让用户先解决文件的问题。
          return;
        }
      } else {
        setUploadError('');
      }
      /*
       * 文件只是名字进请求（内容由 Agent 主动 ws_read）——
       * 这样上下文不会被上传物撑满，也不会出现"每轮都重发一张图"。
       */
      const value = uploaded.length > 0 ? uploadedFilesNote(uploaded) + '\n\n' + raw : raw;
      const accepted = submitInput(value, { sessionId: session.id });
      if (accepted) {
        setText('');
        if (uploaded.length > 0) setPending([]);
      }
    })();
  };

  /**
   * 粘贴 / 拖入的文件：**只拿在手里，不写任何存储**。
   *
   * 写入发生在点发送那一刻（submit）。这里能做的只有本地检查（空/太大），
   * 但那些检查已经足够挡住最常见的错误，而且是**立刻**给出反馈的。
   */
  const holdFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const notes: string[] = [];
    const accepted: File[] = [];
    let room = MAX_UPLOAD_FILES - pending.length;
    for (const file of incoming) {
      if (room <= 0) {
        notes.push('最多 ' + MAX_UPLOAD_FILES + ' 个文件，超出的已忽略。');
        break;
      }
      const bad = checkFileLocally(file);
      if (bad) {
        notes.push((file.name || 'file') + '：' + bad);
        continue;
      }
      accepted.push(file);
      room -= 1;
    }
    if (accepted.length > 0) {
      setPending((prev) => [...prev, ...accepted]);
      setUploadError(notes.join('\n'));
    } else if (notes.length > 0) {
      setUploadError(notes.join('\n'));
    } else {
      setUploadError('');
    }
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

  const needed = inputMinHeight(areaH, queue.length, pendingOpen.length, pending.length);
  /** 生成中且输入框为空 → 发送按钮变成停止。 */
  const canStop = busy && !text.trim() && pending.length === 0;

  /*
   * 右下角那三个数的**实际宽度**要告诉状态行，让它留出对应的右边距。
   *
   * 之前这里写死 132px：指标串一变长（比如 ~命中 100% · 123.4 tok/s · 1.2M）就压到
   * 状态行的文字上 —— 生成过程中 detail 很长时最明显，用户看到的就是"输出和指标重叠"。
   */
  const metricsRef = useRef<HTMLSpanElement | null>(null);
  const [metricsW, setMetricsW] = useState(0);
  useLayoutEffect(() => {
    const w = metricsRef.current ? Math.ceil(metricsRef.current.getBoundingClientRect().width) : 0;
    setMetricsW((prev) => (prev === w ? prev : w));
  });

  /**
   * 把"内容需要多高"同步回会话矩形。
   * 以**底边为锚**：变高时 y 一起上移，否则贴底的输入框会顶出屏幕底部。
   * 用户手动拉高过（当前高度不等于上次自动值）就不缩回去。
   */
  /*
   * 用户一旦手动调过尺寸（宽**或**高），这个会话就不再自动跟随内容改高度。
   *
   * 为什么必须这样：缩窄时文字会换行 → 内容需要更高 → 自动高度立刻把 h 撑回去、
   * 并以底边为锚把 y 一起上移；用户继续拖，它继续抢 —— 表现就是
   * "**拉到最小之后继续拉，输入框自己会跑**"（用户反馈的正是这个）。
   * 自动高度是"帮忙"，不能压过用户的手。
   */
  const userSized = useRef(false);
  useLayoutEffect(() => {
    // 正在拖手柄时绝对不动：否则每一帧都跟用户抢尺寸和位置。
    if (resizing) return;
    if (userSized.current) return;
    if (needed === rect.h) return;
    setSessionRect(session.id, { ...rect, y: Math.max(0, rect.y + rect.h - needed), h: needed });
  }, [needed, session.id, rect, setSessionRect, resizing]);

  // 最小化后交给任务栏渲染，这里什么都不画。
  if (minimized) return null;

  return (
    <WindowFrame
      id={session.id}
      title={title}
      rect={rect}
      zIndex={z}
      focused={focusedId === session.id}
      onRect={(r) => {
        // 尺寸变了（宽或高）就记住"这是用户自己定的"，此后不再自动改高度。
        if (r.w !== rect.w || r.h !== rect.h) userSized.current = true;
        setSessionRect(session.id, r);
      }}
      onFocus={() => bringToFront(session.id)}
      onMinimize={() => requestMinimize(session.id)}
      // 只剩一个时不给关：全关掉就没有入口了。
      // 先播淡出再真正移除（store 里收尾）；只剩一个时不给关。
      onDelete={sessionCount > 1 ? () => requestCloseSession(session.id) : undefined}
      minW={300}
      minH={70}
      minHeightCss={needed}
      // 整个窗口都是落点：拖文件过来不用瞄准那一行文字。
      onDropFiles={holdFiles}
    >
      <div className="ygg-compose">
        {/*
          用量指标：**固定在右下角**（绝对定位，不占流），而且**没数据时整块不渲染**。
          值都是这个会话的整体值：命中率 / 整体 tok/s / token 总和。
        */}
        {metricsText(metrics) ? (
          <span
            ref={metricsRef}
            className="ygg-metrics"
            title={
              (metrics.exact ? '' : '（含本地估算，数字前带 ~）') +
              '最近一次请求：命中 ' + metrics.lastCachedIn.toLocaleString() + ' / 输入 ' +
              metrics.lastTokensIn.toLocaleString() + ' = ' +
              Math.round((stepHitRate(metrics) ?? 0) * 100) + '%；' +
              '本会话累计：命中 ' + metrics.cachedIn.toLocaleString() + ' / 输入 ' +
              metrics.tokensIn.toLocaleString() + ' = ' +
              Math.round((hitRate(metrics) ?? 0) * 100) + '%（含会话第一次与每次压缩后的冷启动）；输出 ' +
              metrics.tokensOut.toLocaleString() + '；累计生成 ' +
              (metrics.msTotal / 1000).toFixed(1) + ' 秒'
            }
          >
            {metricsText(metrics)}
          </span>
        ) : null}
        {/*
          被弹窗拦截的页面：网页只能在"用户手势"里开新窗口，所以这里由用户点一下。
          点这个按钮就是真正的手势，window.open 不会被拦。
        */}
        {/*
          截图请求：浏览器只允许在"用户手势"里抓屏，所以 Agent 只能登记请求，
          由用户点这一下 —— 点了才有手势，才抓得到真实的当前画面。
        */}
        {shotMine ? (
          <button
            className="ygg-pending"
            title="点击后截取当前画面"
            onClick={() => {
              clearPendingShot();
              void (async () => {
                const r = await captureScreen();
                const store = useDesktopStore.getState();
                if (!r.ok) {
                  store.log('warn', '截图 ✕ ' + r.error);
                  return;
                }
                // 图进"要它的那个会话"的上下文：下一轮它就看得见。
                store.appendSessionMessage(session.id, {
                  role: 'user',
                  content: '[截图] 这是当前页面的真实截图。',
                  images: [r.dataUrl],
                });
                store.log('op', '截图已进入上下文', session.id);
                // 自动追问一句，否则 Agent 要等用户下次说话才看得到这张图。
                submitInput('[截图] 当前页面的截图已经附上，请查看并据此判断是否符合预期。', {
                  sessionId: session.id,
                });
              })();
            }}
          >
            <span className="ygg-pending-dot" />
            截图给 Agent
          </button>
        ) : null}

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

        {/*
          上传过的文件。它们已经进了工作区 —— 这里只是让用户确认"带了什么"，
          以及提供一个"从这次发送里去掉"的入口（注意：去掉只是不告诉 Agent，
          文件仍在工作区里，可以在工作区面板里删）。
        */}
        {pending.length > 0 ? (
          <div className="ygg-files">
            {pending.map((f, i) => (
              <div className="ygg-file" key={f.name + i} title={f.name + '（' + formatBytes(f.size) + '，发送时才上传）'}>
                <span className="ygg-file-kind">待上传</span>
                <span className="ygg-file-name">{f.name}</span>
                <button
                  className="ygg-file-del"
                  title="移除"
                  onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
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
                {q.files?.length ? <span className="ygg-queue-img">{q.files.length} 个文件</span> : null}
                <span className="ygg-queue-text">{q.text || '（文件）'}</span>
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
              busy
                ? '排队发送…'
                : pending.length > 0
                  ? '这些文件要做什么…（发送时才上传）'
                  : '描述任务…（可粘贴或拖入文件）'
            }
            rows={1}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              /*
               * 粘贴：**任何文件都接**，不再只挑图片。
               * 截图走的是剪贴板里的图片项，和以前一样；但复制一个 PDF / 文本片段
               * 现在也能直接进来（以前会被当纯文字插进输入框）。
               */
              const picked = filesFromClipboard(e.clipboardData);
              if (picked.length > 0) {
                e.preventDefault();
                holdFiles(picked);
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
            /*
             * 生成中 + 输入框是空的 → 这个按钮变成**停止**。
             * 输入框里有内容时才保持"加入队列"（那时用户显然是想再发一条）。
             */
            className={'ygg-compose-send' + (busy ? ' is-queue' : '') + (canStop ? ' is-stop' : '')}
            disabled={!canStop && !text.trim() && pending.length === 0}
            title={canStop ? '停止本轮（会清空排队）' : busy ? '加入队列' : '发送'}
            onClick={canStop ? () => stopRun(session.id) : submit}
          >
            {canStop ? (
              <StopIcon width={13} height={13} />
            ) : busy ? (
              <QueueIcon width={13} height={13} />
            ) : (
              <SendIcon width={13} height={13} />
            )}
          </button>
        </div>

        {/*
          状态行：左边是运行状态（或图片/报错提示），右边固定是三个用量指标。
          **指标不单独占一行** —— 它跟状态共用这一行，靠 margin-left:auto 贴到右端。
        */}
        <div
          className={'ygg-compose-state' + (busy ? ' is-busy' : '')}
          // 按指标实测宽度避让（没数据时指标不渲染，宽度回 0）。
          style={metricsW > 0 ? { paddingRight: metricsW + 10 } : undefined}
        >
          {busy ? (
            <>
              <span className="ygg-spin" />
              <span className="ygg-compose-text">{phase || '处理中'}</span>
              {queue.length > 0 ? (
                <span className="ygg-compose-queued">{queue.length} 条排队</span>
              ) : null}
              {detail ? <span className="ygg-compose-detail">{detail}</span> : null}
            </>
          ) : null}
          {!busy && (uploadError || pending.length > 0) ? (
            <span className="ygg-compose-hint">
              {uploadError
            ? uploadError
            : pending.length + ' 个文件将在发送时存入工作区'}
            </span>
          ) : null}
          {/*
            空闲提示。
            这一行原来在没跑任务时是**空的** —— 一块占着高度却什么都不显示的区域，
            用户看不出这里是什么、也不知道能做什么。
            现在没在跑、也没有文件要发的时候，就在这里显示"能用什么"：
            左边是用法提示，右边（由 .ygg-metrics 占位）是用量指标。
          */}
          {!busy && !uploadError && pending.length === 0 ? (
            /*
             * 提示要**短**：这一行右边还有用量指标，太长就会被截断，
             * 而且"读一半"的提示比不显示更糟。所以只保留最有用的一句。
             */
            <span className="ygg-compose-idle" title="可直接粘贴或拖入文件">
              Enter 发送 · Shift + Enter 换行
            </span>
          ) : null}
        </div>
      </div>
    </WindowFrame>
  );
}

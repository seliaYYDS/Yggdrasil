import { useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { PanelWindow } from './PanelWindow';
import type { TraceStep, TraceStatus } from '../kernel/types';
import { ClearIcon } from './icons';

const STATUS_MARK: Record<TraceStep['status'], string> = {
  running: '◌',
  ok: '✓',
  fail: '✕',
  skipped: '–',
};

function duration(step: TraceStep): string {
  const end = step.endedAt ?? Date.now();
  const ms = end - step.startedAt;
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

/** 筛选维度：全部 / 只看成功 / 只看失败。 */
type Filter = 'all' | TraceStatus;

/**
 * 面板的两个视图。
 * 「运行日志」原先挂在 Nodes 面板的第二页，和节点树没有关系，
 * 现在归到 Trace 里 —— 轨迹与日志都是"这次/历次运行发生了什么"。
 */
type View = 'steps' | 'log';

export function TracePanel() {
  const open = useDesktopStore((s) => s.traceOpen);
  const setOpen = useDesktopStore((s) => s.setTraceOpen);
  const sessions = useDesktopStore((s) => s.sessions);
  const nodes = useDesktopStore((s) => s.nodes);
  const agentRuns = useDesktopStore((s) => s.agentRuns);
  const logs = useDesktopStore((s) => s.logs);
  const clearTraces = useDesktopStore((s) => s.clearTraces);

  const [view, setView] = useState<View>('steps');
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!open) return null;

  /*
   * 每个输入框、每个组件 agent 都有自己的轨迹（工作状态不共享）。
   * 面板把它们**按时间合并**展示，来源多于一个时在行首标出是谁。
   *
   * `agent.progress === 'none'` 的 agent 不并进来 —— 那是创建者在说
   * "进度我已经画在它自己的界面里了，别重复显示"。
   */
  const agentRows = Object.entries(agentRuns)
    .filter(([id]) => {
      const n = nodes[id];
      return !!n && n.kind === 'component' && n.agent?.progress !== 'none';
    })
    .flatMap(([id, run]) => {
      const n = nodes[id];
      const whose = n && n.kind === 'component' ? n.name : id;
      return run.trace.map((step) => ({ step, whose, owner: id }));
    });
  const merged = [
    ...sessions.flatMap((ses) =>
      ses.trace.map((step) => ({ step, whose: ses.title, owner: ses.id })),
    ),
    ...agentRows,
  ];
  const many = new Set(merged.map((m) => m.owner)).size > 1;
  const anyRunning =
    sessions.some((ses) => ses.status.running) ||
    Object.values(agentRuns).some((r) => r.status.running);

  const okCount = merged.filter((m) => m.step.status === 'ok').length;
  const failCount = merged.filter((m) => m.step.status === 'fail').length;
  const shown = filter === 'all' ? merged : merged.filter((m) => m.step.status === filter);

  /** 点当前筛选项就退回"全部"，和以前一致的开关手感。 */
  const pickFilter = (next: Filter) => {
    setView('steps');
    setFilter(filter === next ? 'all' : next);
  };

  return (
    <PanelWindow
      panel="trace"
      title="Trace"
      kindLabel={anyRunning ? 'running' : undefined}
      minW={320}
      minH={240}
      onClose={() => setOpen(false)}
    >
      <div className="ygg-panel-body">
        {/*
          一行两段：左边是带**描述前缀**的计数（光看数字不知道哪个是日志、哪个是失败），
          右边是清除按钮 —— 用 margin-left:auto 钉在最右，不随左侧按钮增减而移动。
          清除会连 agent 记忆一起清（见 store.clearTraces 的说明）。
        */}
        <div className="ygg-section ygg-trace-bar">
          <div className="ygg-seg">
            <button
              className={view === 'steps' && filter === 'all' ? 'on' : ''}
              title="全部步骤"
              onClick={() => pickFilter('all')}
            >
              步骤 {merged.length}
            </button>
            <button
              className={view === 'steps' && filter === 'ok' ? 'on' : ''}
              title="只看成功的步骤"
              onClick={() => pickFilter('ok')}
            >
              成功 {okCount}
            </button>
            <button
              className={view === 'steps' && filter === 'fail' ? 'on' : ''}
              title="只看失败的步骤"
              onClick={() => pickFilter('fail')}
            >
              失败 {failCount}
            </button>
            <button
              className={view === 'log' ? 'on' : ''}
              title="运行日志"
              onClick={() => setView(view === 'log' ? 'steps' : 'log')}
            >
              日志 {logs.length}
            </button>
          </div>
          <button
            className="ygg-trace-clear"
            title="清空轨迹、日志与 Agent 记忆"
            disabled={merged.length === 0 && logs.length === 0}
            onClick={clearTraces}
          >
            <ClearIcon />
          </button>
        </div>

        {view === 'steps' && merged.length > 0 ? (
          <div className="ygg-panel-hint">点一行展开：思考 / 模型原始输出 / 返回内容</div>
        ) : null}

        {view === 'log' ? (
          <div className="ygg-section">
            <div className="ygg-log">
              {logs.length === 0 ? <div className="ygg-empty">—</div> : null}
              {logs.slice().reverse().map((l) => (
                <div key={l.id} className="ygg-log-line">
                  <span className={'lv ' + l.level}>{l.level}</span>
                  <span>{l.text}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            {merged.length === 0 ? <div className="ygg-empty">—</div> : null}
            {merged.length > 0 && shown.length === 0 ? (
              <div className="ygg-empty">没有符合筛选的步骤</div>
            ) : null}

            <div className="ygg-trace">
              {shown.map(({ step, whose }) => {
                const isOpen = expanded === step.id;
                return (
                  <div
                    key={step.id}
                    className={'ygg-step is-' + step.status + (isOpen ? ' is-open' : '')}
                    // 整行可点：展开/收起该步的细节。这是轨迹面板自己的交互，
                    // 与窗口拖动无关（标题栏才是拖动区）。
                    onClick={() => setExpanded(isOpen ? null : step.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpanded(isOpen ? null : step.id);
                      }
                    }}
                  >
                    <div className="ygg-step-head">
                      <span className="mark">{STATUS_MARK[step.status]}</span>
                      {many ? <span className="kind whose">{whose}</span> : null}
                      <span className="kind">{step.round > 0 ? 'R' + step.round : '·'}</span>
                      <span className="label">{step.label}</span>
                      <span className="spacer" />
                      <span className="dur">{step.status === 'running' ? '…' : duration(step)}</span>
                    </div>
                    <div className="ygg-step-sum">{step.summary}</div>

                    {/*
                      展开后能看到模型的**思考过程**与原始输出。
                      思考来自服务端的 reasoning_content（推理模型）或流式拼接的正文；
                      折叠时只显示一句话结论，并提示"可以点开看"。
                    */}
                    {isOpen && step.thinking ? (
                      <div className="ygg-step-block">
                        <div className="ygg-step-block-label">思考</div>
                        <pre className="ygg-step-pre">{step.thinking}</pre>
                      </div>
                    ) : null}
                    {isOpen && step.raw && step.raw !== step.thinking ? (
                      <div className="ygg-step-block">
                        <div className="ygg-step-block-label">模型原始输出</div>
                        <pre className="ygg-step-pre">{step.raw}</pre>
                      </div>
                    ) : null}
                    {isOpen && step.observation ? (
                      <div className="ygg-step-block">
                        <div className="ygg-step-block-label">返回内容</div>
                        <pre className="ygg-step-pre">{step.observation}</pre>
                      </div>
                    ) : null}

                    {!isOpen && step.message ? <div className="ygg-step-msg">{step.message}</div> : null}
                    {isOpen && step.message ? <div className="ygg-step-msg">{step.message}</div> : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </PanelWindow>
  );
}

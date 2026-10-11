import { useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { PanelWindow } from './PanelWindow';
import type { TraceStep, TraceStatus } from '../kernel/types';

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

export function TracePanel() {
  const open = useDesktopStore((s) => s.traceOpen);
  const setOpen = useDesktopStore((s) => s.setTraceOpen);
  const trace = useDesktopStore((s) => s.trace);
  const status = useDesktopStore((s) => s.status);

  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!open) return null;

  const okCount = trace.filter((s) => s.status === 'ok').length;
  const failCount = trace.filter((s) => s.status === 'fail').length;
  const shown = filter === 'all' ? trace : trace.filter((s) => s.status === filter);

  return (
    <PanelWindow
      panel="trace"
      title="Trace"
      kindLabel={status.running ? 'running' : undefined}
      minW={320}
      minH={240}
      onClose={() => setOpen(false)}
    >
      <div className="ygg-panel-body">
        <div className="ygg-section">
          <div className="ygg-seg">
            <button
              className={filter === 'all' ? 'on' : ''}
              title="全部"
              onClick={() => setFilter('all')}
            >
              {trace.length}
            </button>
            <button
              className={filter === 'ok' ? 'on' : ''}
              title="只看成功"
              onClick={() => setFilter(filter === 'ok' ? 'all' : 'ok')}
            >
              {okCount}
            </button>
            <button
              className={filter === 'fail' ? 'on' : ''}
              title="只看失败"
              onClick={() => setFilter(filter === 'fail' ? 'all' : 'fail')}
            >
              {failCount}
            </button>
          </div>
        </div>

        {trace.length === 0 ? <div className="ygg-empty">—</div> : null}
        {trace.length > 0 && shown.length === 0 ? (
          <div className="ygg-empty">没有符合筛选的步骤</div>
        ) : null}

        <div className="ygg-trace">
          {shown.map((step) => {
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
                  <span className="kind">{step.round > 0 ? 'R' + step.round : '·'}</span>
                  <span className="label">{step.label}</span>
                  <span className="spacer" />
                  <span className="dur">{step.status === 'running' ? '…' : duration(step)}</span>
                </div>
                <div className="ygg-step-sum">{step.summary}</div>
                {isOpen && step.observation ? (
                  <div className="ygg-step-obs">{step.observation}</div>
                ) : null}
                {!isOpen && step.message ? <div className="ygg-step-msg">{step.message}</div> : null}
                {isOpen && step.message ? <div className="ygg-step-msg">{step.message}</div> : null}
              </div>
            );
          })}
        </div>
      </div>
    </PanelWindow>
  );
}

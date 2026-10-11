import { useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { runDerivation } from '../kernel/agent/agentRuntime';
import { PanelWindow } from './PanelWindow';

export function YggdrasilInput() {
  const [text, setText] = useState('');
  const running = useDesktopStore((s) => s.status.running);
  const phase = useDesktopStore((s) => s.status.phase);
  const detail = useDesktopStore((s) => s.status.detail);

  const submit = async () => {
    const value = text.trim();
    if (!value || running) return;
    setText('');
    await runDerivation(value);
  };

  return (
    <PanelWindow panel="input" title="Yggdrasil" minW={300} minH={70} minHeightCss={70}>
      <div className="ygg-compose">
        <div className="ygg-compose-row">
          <textarea
            className="ygg-compose-area"
            value={text}
            placeholder="描述你想让 Yggdrasil 做什么…"
            rows={1}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button
            className="ygg-compose-send"
            disabled={running || !text.trim()}
            title="发送"
            onClick={() => void submit()}
          >
            {running ? <span className="ygg-spin is-light" /> : '↑'}
          </button>
        </div>

        <div className={'ygg-compose-state' + (running ? ' is-busy' : '')}>
          {running ? (
            <>
              <span className="ygg-spin" />
              <span className="ygg-compose-text">{phase || '处理中'}</span>
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
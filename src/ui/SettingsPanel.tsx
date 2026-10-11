import { useDesktopStore } from '../store/desktopStore';
import { PanelWindow } from './PanelWindow';

export function SettingsPanel() {
  const open = useDesktopStore((s) => s.settingsOpen);
  const setOpen = useDesktopStore((s) => s.setSettingsOpen);
  const settings = useDesktopStore((s) => s.settings);
  const setSettings = useDesktopStore((s) => s.setSettings);

  if (!open) return null;

  return (
    <PanelWindow
      panel="settings"
      title="LLM"
      minW={300}
      minH={280}
      onClose={() => setOpen(false)}
    >
      <div className="ygg-form">
        <div className="ygg-field">
          <label className="ygg-label">Base</label>
          <input
            className="ygg-input"
            value={settings.baseUrl}
            onChange={(e) => setSettings({ baseUrl: e.target.value })}
            spellCheck={false}
          />
        </div>
        <div className="ygg-field">
          <label className="ygg-label">Key</label>
          <input
            className="ygg-input"
            type="password"
            value={settings.apiKey}
            onChange={(e) => setSettings({ apiKey: e.target.value })}
            spellCheck={false}
          />
        </div>
        <div className="ygg-field">
          <label className="ygg-label">Model</label>
          <input
            className="ygg-input"
            value={settings.model}
            onChange={(e) => setSettings({ model: e.target.value })}
            spellCheck={false}
          />
          <div className="ygg-hint">
            识图需要支持视觉的模型（如 gpt-4o / claude-3.5 / qwen-vl）。
            纯文本模型收到图片整条请求会失败，输入框会提示。
          </div>
        </div>
        <div className="ygg-field">
          <label className="ygg-label">Temperature {settings.temperature.toFixed(2)}</label>
          <input
            className="ygg-range"
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={settings.temperature}
            onChange={(e) => setSettings({ temperature: Number(e.target.value) })}
          />
        </div>
      </div>
    </PanelWindow>
  );
}
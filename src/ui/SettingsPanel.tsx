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
          <label className="ygg-label">图片中转（可选）</label>
          <input
            className="ygg-input"
            value={settings.imageRelay ?? ''}
            placeholder="留空 = 不中转，只直连读取"
            onChange={(e) => setSettings({ imageRelay: e.target.value })}
            spellCheck={false}
          />
          <div className="ygg-hint">
            Agent 读图片时：抓到字节 → base64 → **直接用当前模型看图**，识别不经过任何第三方。
            但浏览器读跨域图片要求对方允许，很多图床不允许 —— 只有在直连失败时才会用到这个地址。
            地址里可以写 {'{url}'}，它会被替换成编码后的图片地址；不写就拼在末尾。
          </div>
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
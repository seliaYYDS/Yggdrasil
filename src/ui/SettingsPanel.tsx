import { useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { PanelWindow } from './PanelWindow';

type Section = 'general' | 'llm';

/**
 * 设置面板。
 *
 * 分两个区：**常规**（跟模型无关的应用行为）与 **LLM**（连接与模型参数）。
 * 用顶部分段切换，而不是把两段摞在一起 —— 面板本身不高，摞起来会让常用的 LLM 字段要滚动才看得到。
 */
export function SettingsPanel() {
  const open = useDesktopStore((s) => s.settingsOpen);
  const setOpen = useDesktopStore((s) => s.setSettingsOpen);
  const settings = useDesktopStore((s) => s.settings);
  const setSettings = useDesktopStore((s) => s.setSettings);
  const [section, setSection] = useState<Section>('llm');

  if (!open) return null;

  const adultOn = settings.adultMode === true;

  return (
    <PanelWindow panel="settings" title="设置" minW={300} minH={280} onClose={() => setOpen(false)}>
      <div className="ygg-panel-body">
        <div className="ygg-seg" style={{ padding: '0 2px 9px' }}>
          <button className={section === 'general' ? 'on' : ''} onClick={() => setSection('general')}>
            常规
          </button>
          <button className={section === 'llm' ? 'on' : ''} onClick={() => setSection('llm')}>
            LLM
          </button>
        </div>

        {section === 'general' ? (
          <div className="ygg-form">
            <div className="ygg-field">
              <button
                className={'ygg-toggle' + (adultOn ? ' on' : '')}
                title={adultOn ? '成人模式：开（点击关闭）' : '成人模式：关（点击开启）'}
                onClick={() => setSettings({ adultMode: !adultOn })}
              >
                <span className="dot" />
                成人模式：{adultOn ? '开' : '关'}
              </button>
            </div>
          </div>
        ) : (
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
                识图本身不经过任何第三方：抓到字节 → base64 → 直接用当前模型看图。
                但浏览器读跨域图片要求对方允许，很多图床不允许 —— 只有在直连失败时才会用到这个地址，
                它只负责把字节递过来。地址里可以写 {'{url}'}，会被替换成编码后的图片地址；不写就拼在末尾。
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
        )}
      </div>
    </PanelWindow>
  );
}

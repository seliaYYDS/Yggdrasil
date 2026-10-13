import { useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { PanelWindow } from './PanelWindow';
import { SECURITY_LEVELS, describePolicy, policyFor, type SecurityLevel } from '../kernel/security';
import { Switch } from './Switch';

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
  const level: SecurityLevel = (settings.securityLevel ?? 'normal') as SecurityLevel;
  const policy = policyFor(level);

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
              <label className="ygg-label">安全等级</label>
              <div className="ygg-seg">
                {SECURITY_LEVELS.map((lv) => (
                  <button
                    key={lv}
                    className={level === lv ? 'on' : ''}
                    title={policyFor(lv).summary}
                    onClick={() => setSettings({ securityLevel: lv })}
                  >
                    {policyFor(lv).label}
                  </button>
                ))}
              </div>
              {/* 说明逐条来自 policy 表 —— 等级改了这里自动跟着改，不会和实际行为对不上 */}
              <div className="ygg-hint">
                {describePolicy(policy).map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            </div>
            {/* 开关一律用滑块：状态由滑块位置表达，不用读文字 */}
            <div className="ygg-field">
              <Switch
                on={adultOn}
                onChange={(v) => setSettings({ adultMode: v })}
                label="成人模式"
                title="涉及性 / 情色时按正当题材处理，不回避、不说教（服务商自己的策略仍绕不过）"
              />
            </div>
            {/*
              图片中转以前放在 LLM 区 —— 那是错的：它跟模型无关，
              是"浏览器读不了跨域图时怎么办"的应用行为，所以归到常规。
            */}
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
                直连失败时才用；地址里用 {'{url}'} 占位。第三方代理能看到你取的图；
                自建见 <code>tools/image-relay-worker.js</code>。
              </div>
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
              <label className="ygg-label">Model</label>
              <input
                className="ygg-input"
                value={settings.model}
                onChange={(e) => setSettings({ model: e.target.value })}
                spellCheck={false}
              />
              <div className="ygg-hint">
                识图需要视觉模型（gpt-4o / claude-3.5 / qwen-vl 等）；纯文本模型收到图片会整条失败。
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

import { useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { PanelWindow } from './PanelWindow';
import { SECURITY_LEVELS, describePolicy, policyFor, type SecurityLevel } from '../kernel/security';
import { Switch } from './Switch';
import { readPercent } from '../kernel/agent/compact';
import { listModels } from '../kernel/llm/client';
import { PROVIDER_PRESETS, formatTokens, providerFor, readTokenCount, type RemoteModel } from '../kernel/llm/presets';

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
  /** 从 `/models` 拉回来的列表；null = 还没拉过。 */
  const [models, setModels] = useState<RemoteModel[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');

  if (!open) return null;

  const adultOn = settings.adultMode === true;
  const visionOn = settings.vision !== false;
  const level: SecurityLevel = (settings.securityLevel ?? 'normal') as SecurityLevel;
  const policy = policyFor(level);

  /**
   * 选中一个模型：写进 Model，并把它的三个参数一起填上。
   *
   * 拿不到的项**不动**（可能是用户自己填的），不要用空值覆盖 —— 猜错比留空糟得多。
   */
  const applyModel = (m: RemoteModel): void => {
    setSettings({
      model: m.id,
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      ...(typeof m.vision === 'boolean' ? { vision: m.vision } : {}),
    });
  };

  const pullModels = (): void => {
    setFetching(true);
    setFetchError('');
    void (async () => {
      try {
        const list = await listModels(settings);
        setModels(list);
        // 当前模型就在列表里：顺手把它缺的参数补上（补不到就保持原样）。
        const hit = list.find((m) => m.id === settings.model);
        if (hit) applyModel(hit);
      } catch (e) {
        setModels(null);
        setFetchError((e as Error).message);
      } finally {
        setFetching(false);
      }
    })();
  };

  /** 当前地址落在哪个预设上（认不出就是"自定义"）。 */
  const currentProvider = providerFor(settings.baseUrl);
  const providerValue = currentProvider && currentProvider.baseUrl ? currentProvider.id : '';

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
                title="成人内容按正当题材处理；服务商策略仍可能拒绝"
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
                placeholder="留空 = 直连读取"
                onChange={(e) => setSettings({ imageRelay: e.target.value })}
                spellCheck={false}
              />
              <div className="ygg-hint">
                直连失败时才用；地址里用 {'{url}'} 占位。第三方代理能看到经过的图片；
                自建见 <code>tools/image-relay-worker.js</code>。
              </div>
            </div>
          </div>
        ) : (
          <div className="ygg-form">
            {/* 预设只做一件事：把必须一字不差的 Base 地址填对。填完仍然可改。 */}
            <div className="ygg-field">
              <label className="ygg-label">入口</label>
              <select
                className="ygg-select"
                value={providerValue}
                onChange={(e) => {
                  const p = PROVIDER_PRESETS.find((x) => x.id === e.target.value);
                  if (p && p.baseUrl) setSettings({ baseUrl: p.baseUrl });
                }}
              >
                <option value="">自定义</option>
                {PROVIDER_PRESETS.filter((p) => p.baseUrl).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
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
            {/* 模型：始终可以手填，也可以从 /models 拉一份列表挑 */}
            <div className="ygg-field">
              <label className="ygg-label">Model</label>
              <div className="ygg-row-gap">
                <input
                  className="ygg-input"
                  style={{ flex: 1, minWidth: 0 }}
                  value={settings.model}
                  onChange={(e) => setSettings({ model: e.target.value })}
                  spellCheck={false}
                />
                <button className="ygg-btn ghost tiny" disabled={fetching} onClick={pullModels}>
                  {fetching ? '获取中…' : '获取列表'}
                </button>
              </div>
              {models ? (
                <select
                  className="ygg-select"
                  style={{ marginTop: 5 }}
                  value={models.some((m) => m.id === settings.model) ? settings.model : ''}
                  onChange={(e) => {
                    const m = models.find((x) => x.id === e.target.value);
                    if (m) applyModel(m);
                  }}
                >
                  <option value="">{models.length} 个模型</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id + (m.contextWindow ? ' · ' + formatTokens(m.contextWindow) : '')}
                    </option>
                  ))}
                </select>
              ) : null}
              {fetchError ? (
                <div className="ygg-hint" style={{ color: 'var(--ygg-danger)' }}>
                  {fetchError}
                </div>
              ) : null}
            </div>
            {/*
              三个模型参数：拉列表或从预设挑中模型时自动填；接口没给、表里也没有的留空
              （留空 = 未知 / 由服务商决定，不猜）。
            */}
            <div className="ygg-field">
              <label className="ygg-label">上下文窗口</label>
              <input
                className="ygg-input"
                inputMode="numeric"
                placeholder="未知"
                value={settings.contextWindow ? String(settings.contextWindow) : ''}
                onChange={(e) => setSettings({ contextWindow: readTokenCount(e.target.value) })}
                spellCheck={false}
              />
            </div>
            <div className="ygg-field">
              <label className="ygg-label">压缩阈值 %</label>
              <input
                className="ygg-input"
                inputMode="numeric"
                placeholder="85"
                value={settings.compactAt ? String(settings.compactAt) : ''}
                onChange={(e) => setSettings({ compactAt: readPercent(e.target.value) })}
                spellCheck={false}
              />
            </div>
            <div className="ygg-field">
              <label className="ygg-label">最大输出</label>
              <input
                className="ygg-input"
                inputMode="numeric"
                placeholder="服务商默认"
                value={settings.maxTokens ? String(settings.maxTokens) : ''}
                onChange={(e) => setSettings({ maxTokens: readTokenCount(e.target.value) })}
                spellCheck={false}
              />
            </div>
            <div className="ygg-field">
              <Switch
                on={visionOn}
                onChange={(v) => setSettings({ vision: v })}
                label="视觉（可收图片）"
                title="关掉后消息里不带图片块；纯文本模型不会再因为收到图片而整条失败"
              />
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
            <div className="ygg-hint">
              窗口 / 最大输出 / 视觉：获取或选中模型时自动填；留空即未知，由服务商决定。
            </div>
          </div>
        )}
      </div>
    </PanelWindow>
  );
}

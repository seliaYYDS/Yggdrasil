import { useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { Surface } from '../host/Surface';
import { PanelWindow } from './PanelWindow';
import { SECURITY_LEVELS, describePolicy, policyFor, type SecurityLevel } from '../kernel/security';
import { Switch } from './Switch';
import { readPercent } from '../kernel/agent/compact';
import {
  clampWorkspaceFile,
  clampWorkspaceTotal,
  WORKSPACE_FILE_DEFAULT,
  WORKSPACE_FILE_MAX,
  WORKSPACE_TOTAL_DEFAULT,
  WORKSPACE_TOTAL_MAX,
} from '../kernel/llm/types';
import { listModels } from '../kernel/llm/client';
import {
  PROVIDER_PRESETS,
  formatTokens,
  providerFor,
  providerKeyFor,
  readTokenCount,
  type RemoteModel,
} from '../kernel/llm/presets';

type Section = 'general' | 'llm';

/**
 * MB 文本框 → 字节。
 *
 * **空串 = 清掉这个设置**（返回 undefined，回落到默认值）—— 与"最大输出"那一栏同一套规矩：
 * 留空不是"设成 0"，而是"不设"。
 *
 * 输入非法（非数字、负数）时也返回 undefined，而不是悄悄写成 NaN：
 * 那样存进设置里会变成一个谁都不认识的数。
 */
function mbToBytes(text: string, hardMax: number): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const mb = Number(t);
  if (!Number.isFinite(mb) || mb <= 0) return undefined;
  const bytes = Math.round(mb * 1024 * 1024);
  return Math.min(bytes, hardMax);
}

/** 字节 → 文本框里显示的 MB（只用于回填，不参与校验）。留空表示"用默认值"。 */
function bytesToMb(bytes: number | undefined): string {
  const b = bytes && bytes > 0 ? bytes : 0;
  if (!b) return '';
  return String(Math.round((b / 1024 / 1024) * 100) / 100);
}

/**
 * 设置面板。
 *
 * 分两个区：**常规**（跟模型无关的应用行为）与 **LLM**（连接与模型参数）。
 * 用顶部分段切换，而不是把两段摞在一起 —— 面板本身不高，摞起来会让常用的 LLM 字段要滚动才看得到。
 */
export function SettingsPanel() {
  const open = useDesktopStore((s) => s.settingsOpen);
  const setOpen = useDesktopStore((s) => s.setSettingsOpen);
  // 重放引导：先关掉设置面板，否则引导会盖在它上面、看不到被指的那些控件。
  const setSettingsOpen = useDesktopStore((s) => s.setSettingsOpen);
  const startIntro = useDesktopStore((s) => s.startIntro);
  const settings = useDesktopStore((s) => s.settings);
  const setSettings = useDesktopStore((s) => s.setSettings);
  const [section, setSection] = useState<Section>('llm');
  /** 从 `/models` 拉回来的列表；null = 还没拉过。 */
  const [models, setModels] = useState<RemoteModel[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');

  if (!open) return null;

  const adultOn = settings.adultMode === true;
  const terseOn = settings.terse === true;
  // 工作区上限：空白 = 用默认值，所以 placeholder 里写的是默认值。
  const totalMb = bytesToMb(clampWorkspaceTotal(settings.workspaceTotalBytes));
  const fileMb = bytesToMb(clampWorkspaceFile(settings.workspaceFileBytes));
  const visionOn = settings.vision !== false;
  const level: SecurityLevel = (settings.securityLevel ?? 'normal') as SecurityLevel;
  const policy = policyFor(level);

  /**
   * 换入口：地址与 Key **必须一起写**，否则 Key 会留成上一个入口的。
   *
   * 两种入口的差别是 clearIfMissing：
   * - **从下拉里选**（明确的"我换一家"）→ 没存过就清空。留着上一个入口的 Key 发出去
   *   只会得到 401，而用户会以为是新入口的问题；空着至少一眼看出"这个入口还没配"。
   * - **手打地址**（clearIfMissing: false）→ 没存过就**不动 Key**。因为那是逐字符输入，
   *   每敲一下都清空的话，用户改一个字符就把 Key 弄没了。
   *   顺手把"存过的地址"回填仍然是好的：手打一个用过的地址，Key 自动回来。
   */
  const applyEndpoint = (nextUrl: string, clearIfMissing: boolean): void => {
    const saved = (settings.apiKeys ?? {})[providerKeyFor(nextUrl)];
    if (saved === undefined && !clearIfMissing) {
      setSettings({ baseUrl: nextUrl });
      return;
    }
    setSettings({ baseUrl: nextUrl, apiKey: saved ?? '' });
  };

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

  /*
   * 面板的**结构插槽**：Agent 可以用 replace_surface 覆写它（改完会弹一次确认，可还原结构）。
   * 内置内容作为 children 传下去 —— 想只改结构、不丢功能，就把 children 放进自己的布局里。
   */
  const builtin = (
    <>
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
                on={terseOn}
                onChange={(v) => setSettings({ terse: v })}
                label="精简模式"
                title="提示词按最小可用集发送：接口只保留一句摘要、不含示例；细节由 Agent 用 inspect 读取，可减少固定开销"
              />
            </div>
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
            {/*
              重放引导放在常规区：引导本身最后一步会告诉用户"入口在这儿"，
              所以它必须真的在这儿，不然那句话就是假的。
            */}
            <div className="ygg-field">
              <label className="ygg-label">初始引导</label>
              <div className="ygg-row-gap">
                <button
                  className="ygg-btn ghost"
                  onClick={() => {
                    setSettingsOpen(false);
                    startIntro();
                  }}
                >
                  重放引导
                </button>
              </div>
              <div className="ygg-hint">重新显示界面与模型配置引导。</div>
            </div>
            {/*
              工作区上限：给的是"字节"，但填起来太费劲，所以界面上用 MB 输入。
              留空 = 用默认值（32 MB / 16 MB），与以前的行为完全一致。
            */}
            <div className="ygg-field">
              <label className="ygg-label">工作区容量上限</label>
              <div className="ygg-row-gap">
                <input
                  className="ygg-input"
                  inputMode="numeric"
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder={'默认 ' + WORKSPACE_TOTAL_DEFAULT / 1024 / 1024 + ' MB'}
                  value={totalMb}
                  onChange={(e) =>
                    setSettings({ workspaceTotalBytes: mbToBytes(e.target.value, WORKSPACE_TOTAL_MAX) })
                  }
                  spellCheck={false}
                />
                <span className="ygg-hint" style={{ marginTop: 0 }}>MB</span>
              </div>
              <div className="ygg-row-gap" style={{ marginTop: 6 }}>
                <input
                  className="ygg-input"
                  inputMode="numeric"
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder={'默认 ' + WORKSPACE_FILE_DEFAULT / 1024 / 1024 + ' MB'}
                  value={fileMb}
                  onChange={(e) =>
                    setSettings({ workspaceFileBytes: mbToBytes(e.target.value, WORKSPACE_FILE_MAX) })
                  }
                  spellCheck={false}
                />
                <span className="ygg-hint" style={{ marginTop: 0 }}>MB（单文件）</span>
              </div>
              <div className="ygg-hint">
                上限 {WORKSPACE_TOTAL_MAX / 1024 / 1024} MB，单文件 {WORKSPACE_FILE_MAX / 1024 / 1024} MB。
                留空使用默认值。此上限由本应用执行，浏览器存储配额不受影响。
              </div>
            </div>
            <div className="ygg-field">
              <label className="ygg-label">图片中转（可选）</label>
              <input
                className="ygg-input"
                value={settings.imageRelay ?? ''}
                placeholder="留空则直连读取"
                onChange={(e) => setSettings({ imageRelay: e.target.value })}
                spellCheck={false}
              />
              <div className="ygg-hint">
                直连失败时使用；地址中使用 {'{url}'} 占位。第三方代理可以读到经过的图片；
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
                  if (p && p.baseUrl) applyEndpoint(p.baseUrl, true);
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
                /*
                 * 手改地址：**只回填、不清空** —— 逐字符输入时不该把 Key 弄没
                 * （见 applyBase 的注释）。
                 */
                onChange={(e) => applyEndpoint(e.target.value, false)}
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
              {/*
                告诉用户这里面的 Key 是"跟着入口走的" —— 否则"换了个入口，Key 变了"
                看起来像 bug。只在确实存过别的入口时提示，避免常驻噪声。
              */}
              {Object.keys(settings.apiKeys ?? {}).length > 1 ? (
                <div className="ygg-hint">每个入口的 Key 分开保存；切回该入口时自动填入。</div>
              ) : null}
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
                title="关闭后请求中不含图片块；纯文本模型不会因收到图片而整条失败"
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
              窗口 / 最大输出 / 视觉：获取或选中模型时自动填入；留空表示未知，由服务商决定。
            </div>
          </div>
        )}
      </div>
    </>
  );
  return (
    <PanelWindow panel="settings" title="设置" minW={300} minH={280} onClose={() => setOpen(false)}>
      <Surface
        id="panel.settings"
        props={{ panel: 'settings', title: '设置', close: () => setOpen(false), children: builtin }}
        fallback={builtin}
      />
    </PanelWindow>
  );
}

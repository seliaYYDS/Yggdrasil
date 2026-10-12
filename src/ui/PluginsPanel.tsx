import { useRef, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { PanelWindow } from './PanelWindow';
import { describeManifest, parsePluginPackage } from '../kernel/plugin/package';
import { checkPluginUpdate, pluginDiff } from '../kernel/plugin/runtime';
import { PLUGIN_EXT, type PluginPackage } from '../kernel/plugin/types';

/**
 * 插件面板（一个普通的可拖拽窗口）。
 *
 * 流程有意做成"两段"：
 * 1. **先看再装** —— 选文件/取示例之后，先把清单摊开给人看（要访问哪些主机、要填什么密钥），
 *    确认之后才装。解析阶段不执行包里任何东西，所以这一步是真的"看完再决定"。
 * 2. **装了之后可关可卸** —— 开关只管"模型能不能调它"，卸载才是删掉。
 *    用户填的值（比如 API Key）在升级时保留，卸载时才丢。
 */
export function PluginsPanel() {
  const open = useDesktopStore((s) => s.pluginsOpen);
  const setOpen = useDesktopStore((s) => s.setPluginsOpen);
  const plugins = useDesktopStore((s) => s.plugins);
  const install = useDesktopStore((s) => s.installPlugin);
  const setEnabled = useDesktopStore((s) => s.setPluginEnabled);
  const uninstall = useDesktopStore((s) => s.uninstallPlugin);
  const setValue = useDesktopStore((s) => s.setPluginValue);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<PluginPackage | null>(null);
  const [pendingSource, setPendingSource] = useState('');
  const [error, setError] = useState('');
  const [guideOf, setGuideOf] = useState('');
  /** 每个插件一条"检查更新"的结果（按 id 存）。 */
  const [updateNote, setUpdateNote] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState('');

  if (!open) return null;

  /** 解析一个包：失败就只显示错误，成功就进入"确认安装"。 */
  const read = async (name: string, bytes: Uint8Array) => {
    setError('');
    setPending(null);
    try {
      const pkg = await parsePluginPackage(name, bytes);
      setPending(pkg);
      setPendingSource(name);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    await read(file.name, new Uint8Array(await file.arrayBuffer()));
  };

  /** 示例插件随构建产出，直接按 URL 取 —— 一键就能试，不用先找文件。 */
  const onDemo = async () => {
    setError('');
    try {
      const res = await fetch('/plugins/music-search.graft');
      if (!res.ok) throw new Error('取示例插件失败：HTTP ' + res.status);
      await read('music-search.graft', new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const confirm = () => {
    if (!pending) return;
    install(pending, pendingSource);
    setPending(null);
  };

  /** 待装包与"同 id 的已装版本"之间的权限差异（首次安装为空）。 */
  const pendingDiff = (() => {
    if (!pending) return [] as string[];
    const prev = plugins.find((x) => x.id === pending.manifest.id);
    if (!prev) return [] as string[];
    const m = pending.manifest;
    const next: typeof prev = {
      id: m.id,
      name: m.name,
      version: m.version,
      author: m.author,
      description: m.description,
      hosts: m.hosts,
      fields: m.fields ?? [],
      endpoints: m.endpoints,
      tools: m.tools ?? [],
      ui: m.ui ?? [],
      update: m.update,
      guide: m.guide ?? '',
      files: pending.files,
      hash: pending.hash,
      signature: pending.signature,
      fingerprint: pending.fingerprint,
      enabled: prev.enabled,
      installedAt: prev.installedAt,
      source: pendingSource,
      values: prev.values,
    };
    return pluginDiff(prev, next);
  })();

  /**
   * 检查更新：读清单里的 update.url。
   * 有新版就**把它取回来走正常的安装确认**（含权限差异），而不是偷偷替换。
   */
  const checkUpdate = async (id: string) => {
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) return;
    setChecking(id);
    setUpdateNote((m) => ({ ...m, [id]: '' }));
    try {
      const info = await checkPluginUpdate(plugin);
      if (!info.ok) {
        setUpdateNote((m) => ({ ...m, [id]: info.error ?? '检查失败' }));
        return;
      }
      if (!info.newer) {
        setUpdateNote((m) => ({ ...m, [id]: '已是最新（' + plugin.version + '）' }));
        return;
      }
      setUpdateNote((m) => ({ ...m, [id]: '发现新版本 ' + info.latest + '，正在取回…' }));
      if (!info.url) {
        setUpdateNote((m) => ({ ...m, [id]: '新版本 ' + info.latest + '，但更新信息里没给下载地址。' }));
        return;
      }
      const res = await fetch(info.url);
      if (!res.ok) throw new Error('下载新版本失败：HTTP ' + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await read(info.url.split('/').pop() || plugin.id + PLUGIN_EXT, bytes);
      setUpdateNote((m) => ({ ...m, [id]: '新版本 ' + info.latest + ' 已取回，请在下面确认安装。' }));
    } catch (e) {
      setUpdateNote((m) => ({ ...m, [id]: (e as Error).message }));
    } finally {
      setChecking('');
    }
  };

  return (
    <PanelWindow panel="plugins" title="插件" minW={340} minH={300} onClose={() => setOpen(false)}>
      <div className="ygg-panel-body">
        <input
          ref={fileRef}
          type="file"
          accept={PLUGIN_EXT + ',application/json'}
          style={{ display: 'none' }}
          onChange={(e) => void onPick(e.target.files?.[0])}
        />

        <div className="ygg-row-gap">
          <button className="ygg-btn ghost" onClick={() => fileRef.current?.click()}>安装插件…</button>
          <button className="ygg-btn ghost" onClick={() => void onDemo()}>装示例</button>
        </div>
        <div className="ygg-hint">
          支持 {PLUGIN_EXT}（zip 包）与单文件 json。装之前先把清单摊开给你看 —— 解析阶段不执行包里的任何东西。
        </div>

        {error ? <div className="ygg-plugin-error">{error}</div> : null}

        {pending ? (
          <div className="ygg-plugin-review">
            <div className="ygg-plugin-review-title">确认安装</div>
            <ul className="ygg-plugin-lines">
              {describeManifest(pending.manifest).map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            {pendingDiff.length > 0 ? (
              <div className="ygg-plugin-error" style={{ color: 'var(--ygg-accent-hi)' }}>
                <strong>这是一次升级，和上一版比它多要了这些：</strong>
                <ul className="ygg-plugin-lines" style={{ marginTop: 4 }}>
                  {pendingDiff.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="ygg-hint">
              装上之后，上面这些操作会变成 Agent 可以调的接口；它只能访问白名单里的主机。
              关闭开关可以随时让 Agent 看不到它。
            </div>
            <div className="ygg-row-gap" style={{ marginTop: 8 }}>
              <button className="ygg-btn primary" onClick={confirm}>安装</button>
              <button className="ygg-btn ghost" onClick={() => setPending(null)}>取消</button>
            </div>
          </div>
        ) : null}

        {plugins.length === 0 ? (
          <div className="ygg-empty" style={{ marginTop: 10 }}>还没有装任何插件。</div>
        ) : null}

        {plugins.map((p) => (
          <div className="ygg-plugin-card" key={p.id}>
            <div className="ygg-plugin-head">
              <label className="ygg-plugin-toggle" title={p.enabled ? '对 Agent 可见' : '对 Agent 隐藏'}>
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => setEnabled(p.id, e.target.checked)}
                />
                <span className={'ygg-toggle' + (p.enabled ? ' on' : '')}><i className="dot" /></span>
              </label>
              <span className="ygg-plugin-name">{p.name}</span>
              <span className="ygg-plugin-ver">v{p.version}</span>
            </div>
            <div className="ygg-plugin-id">{p.id}{p.author ? ' · ' + p.author : ''}</div>
            <div className="ygg-hint" style={{ marginTop: 2 }}>{p.description}</div>

            <div className="ygg-plugin-meta">
              主机：{p.hosts.join('、')}
              <br />
              操作：{p.endpoints.map((e) => e.name).join('、')}
              {p.tools.length ? (
                <>
                  <br />
                  js 工具：{p.tools.map((t) => t.name).join('、')}（在 Worker 里隔离执行）
                </>
              ) : null}
              {p.ui.length ? (
                <>
                  <br />
                  自带界面：{p.ui.map((u) => u.name).join('、')}
                </>
              ) : null}
              <br />
              来源：{p.source || '本地文件'}
            </div>
            <div className="ygg-plugin-sig">
              {p.signature === 'ok'
                ? '签名有效 · ' + (p.fingerprint ?? '')
                : p.signature === 'unsupported'
                  ? '有签名，但这个环境验不了'
                  : '未签名'}
              {p.hash ? ' · 哈希 ' + p.hash.slice(0, 10) : ''}
            </div>

            {p.fields.length > 0 ? (
              <div className="ygg-form" style={{ marginTop: 6 }}>
                {p.fields.map((f) => (
                  <div className="ygg-field" key={f.key} style={{ marginBottom: 6 }}>
                    <label className="ygg-label">{f.label}</label>
                    <input
                      className="ygg-input"
                      type={f.secret ? 'password' : f.type === 'url' ? 'url' : 'text'}
                      value={p.values[f.key] ?? ''}
                      placeholder={f.placeholder ?? (f.secret ? '只存在本地，不会进提示词' : '')}
                      spellCheck={false}
                      onChange={(e) => setValue(p.id, f.key, e.target.value)}
                    />
                    {f.hint ? <div className="ygg-hint">{f.hint}</div> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {updateNote[p.id] ? <div className="ygg-hint" style={{ marginTop: 4 }}>{updateNote[p.id]}</div> : null}
            <div className="ygg-row-gap" style={{ marginTop: 6 }}>
              <button
                className="ygg-btn tiny ghost"
                disabled={checking === p.id}
                onClick={() => void checkUpdate(p.id)}
              >
                {checking === p.id ? '检查中…' : '检查更新'}
              </button>
              <button
                className="ygg-btn tiny ghost"
                onClick={() => setGuideOf(guideOf === p.id ? '' : p.id)}
              >
                {guideOf === p.id ? '收起指南' : '看指南'}
              </button>
              <button className="ygg-btn tiny danger" onClick={() => uninstall(p.id)}>卸载</button>
            </div>
            {guideOf === p.id ? (
              <pre className="ygg-plugin-guide">{p.guide || '（这个插件没有 guide.md）'}</pre>
            ) : null}
          </div>
        ))}
      </div>
    </PanelWindow>
  );
}

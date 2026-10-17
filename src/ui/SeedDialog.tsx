import { useMemo, useRef, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import {
  describeSeed,
  parseSeed,
  seedFileName,
  seedPartOptions,
  seedToText,
  SEED_PART_INFO,
  SEED_EXT,
  type SeedFile,
  type SeedPart,
} from '../store/seed';

/**
 * 场景的导出 / 导入。
 *
 * 两个刻意的设计：
 * - **导出要勾选内容**，默认全勾（含历史），但 API Key 单独一个勾——默认不勾。
 *   场景文件很容易被随手发出去，key 不该默认躺在里面。
 * - **导入只覆盖文件里带的区块**，其余保持原样；确认框里如实列出文件装了什么，
 *   并明确写出"这些区块会被覆盖"——覆盖用户界面前必须让他看清。
 */
export function SeedDialog() {
  const mode = useDesktopStore((s) => s.seedDialog);
  if (!mode) return null;
  return mode === 'export' ? <ExportSeed /> : <ImportSeed />;
}

function ExportSeed() {
  const setMode = useDesktopStore((s) => s.setSeedDialog);
  const exportSeed = useDesktopStore((s) => s.exportSeed);
  const sessions = useDesktopStore((s) => s.sessions);
  const nodes = useDesktopStore((s) => s.nodes);
  /*
   * 导出侧也按**实际有没有内容**来给勾选框（与导入侧同一个规矩）：
   * 桌面上一个组件都没有时不显示"组件"的勾，没有对话时不显示"Agent 历史"的勾。
   */
  const available = useMemo(() => {
    const hasComp = Object.values(nodes).some((n) => n.kind === 'component' && !n.root);
    const hasHistory =
      Object.values(nodes).some((n) => n.kind === 'component' && !!n.agent && (n.agent.messages.length > 0 || n.agent.ledger.length > 0)) ||
      sessions.some((ses) => ses.messages.length > 0);
    return { interface: true, components: hasComp, history: hasHistory, settings: true } as Record<SeedPart, boolean>;
  }, [nodes, sessions]);
  /*
   * 默认只勾**界面 + 组件**（待办 2）。
   *
   * 场景文件最常见的用途是"把这套界面和组件发给别人/存一份"，而对话记忆与设置
   * （连接、模型、可能含密钥）既敏感、又是私人的 —— 默认不勾，要用就自己勾上。
   */
  const [parts, setParts] = useState<SeedPart[]>(['interface', 'components']);
  const [withKey, setWithKey] = useState(false);
  const [done, setDone] = useState('');

  /*
   * 历史与组件**互不绑定**（待办 1）：记忆只是消息与账本，组件带着自己的 agent 配置。
   * 勾历史不再顺手把组件一起勾上 —— 用户想只导出记忆就只导出记忆。
   */
  const toggle = (id: SeedPart) => {
    setParts((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const run = () => {
    if (parts.length === 0) { setDone('至少勾选一项。'); return; }
    const seed = exportSeed(parts, withKey);
    const text = seedToText(seed);
    const name = seedFileName();
    // 下载：临时 a 标签 + objectURL，用完立刻回收，避免把整份场景一直挂在内存里。
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setDone('已导出 ' + name + '（' + Math.round(text.length / 1024) + ' KB）');
  };

  return (
    <div className="ygg-overlay" onClick={() => setMode(null)}>
      <div className="ygg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ygg-confirm-text">导出场景（{SEED_EXT}）</div>
        {SEED_PART_INFO.filter((p) => available[p.id]).map((p) => (
          <label className="ygg-seed-row" key={p.id}>
            <input type="checkbox" checked={parts.includes(p.id)} onChange={() => toggle(p.id)} />
            <span>
              {p.label}
              <span className="desc">{p.hint}</span>
            </span>
          </label>
        ))}
        <label className="ygg-seed-row">
          <input type="checkbox" checked={withKey} onChange={(e) => setWithKey(e.target.checked)} />
          <span>
            包含 API Key（敏感）
            <span className="desc">默认不含；勾选后文件中包含密钥。</span>
          </span>
        </label>
        {done ? <div className="ygg-seed-warn" style={{ color: 'var(--ygg-ok)' }}>{done}</div> : null}
        <div className="ygg-modal-actions">
          <button className="ygg-btn ghost" onClick={() => setMode(null)}>关闭</button>
          <button className="ygg-btn" onClick={run}>导出</button>
        </div>
      </div>
    </div>
  );
}

function ImportSeed() {
  const setMode = useDesktopStore((s) => s.setSeedDialog);
  const importSeed = useDesktopStore((s) => s.importSeed);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [seed, setSeed] = useState<SeedFile | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * 要导入哪些区块。默认**全选文件里有的** ——
   * 用户点"导入"时的心智是"把这个场景导进来"，不该还要先勾一遍。
   */
  const [parts, setParts] = useState<SeedPart[]>([]);

  const pick = async (file: File | undefined) => {
    setError('');
    setSeed(null);
    if (!file) return;
    const text = await file.text();
    const parsed = parseSeed(text);
    if (!parsed.ok) { setError(parsed.error); return; }
    setSeed(parsed.seed);
    /*
     * 换文件就重置勾选：默认勾**界面 + 组件**（与导出侧同一个默认），
     * 历史与设置要用户自己勾 —— 导入别人的记忆 / 设置是更重的事，不该默认发生。
     * 文件里没有的区块当然也不勾（上面 available 已经过滤过）。
     */
    setParts(
      seedPartOptions(parsed.seed)
        .filter((o) => o.available && (o.id === 'interface' || o.id === 'components'))
        .map((o) => o.id),
    );
  };

  const run = async () => {
    if (!seed) return;
    setBusy(true);
    try {
      await importSeed(seed, parts);
      setMode(null);
    } catch (e) {
      setError('导入失败：' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const lines = seed ? describeSeed(seed) : [];
  const options = seed ? seedPartOptions(seed).filter((o) => o.available) : [];
  /** 勾选状态跟着选中的文件走（换文件时重置成"文件里有的全选"）。 */
  const toggle = (id: SeedPart) => {
    setParts((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  return (
    <div className="ygg-overlay" onClick={() => !busy && setMode(null)}>
      <div className="ygg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ygg-confirm-text">导入场景（{SEED_EXT}）</div>
        <input
          ref={fileRef}
          type="file"
          accept={SEED_EXT + ',application/json'}
          style={{ display: 'none' }}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <div className="ygg-modal-actions" style={{ justifyContent: 'flex-start', marginTop: 0, marginBottom: 11 }}>
          <button className="ygg-btn ghost" onClick={() => fileRef.current?.click()}>选择文件…</button>
        </div>
        {error ? <div className="ygg-seed-warn">{error}</div> : null}
        {seed ? (
          <>
            <ul className="ygg-seed-parts">
              {lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            {/* 选择导入内容：只列文件里真的有的区块，不列点了也没用的项。 */}
            <div className="ygg-seed-row" style={{ marginBottom: 4, cursor: 'default' }}>
              <span style={{ color: 'var(--ygg-accent-hi)' }}>导入这些内容：</span>
            </div>
            {options.map((o) => (
              <label className="ygg-seed-row" key={o.id}>
                <input type="checkbox" checked={parts.includes(o.id)} onChange={() => toggle(o.id)} />
                <span>{o.label}</span>
              </label>
            ))}
            <div className="ygg-seed-warn">
              <strong>导入会覆盖勾选的区块</strong>（其余保持不动）。
              {parts.length === 0
                ? ' 未勾选任何区块。'
                : parts.includes('components') || parts.includes('history')
                  ? ' 导入会覆盖原有组件与对话记忆。'
                  : ' 本次导入不涉及组件与对话记忆。'}
            </div>
          </>
        ) : null}
        <div className="ygg-modal-actions">
          <button className="ygg-btn ghost" disabled={busy} onClick={() => setMode(null)}>取消</button>
          <button className="ygg-btn" disabled={!seed || busy || parts.length === 0} onClick={() => void run()}>
            {busy ? '···' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}

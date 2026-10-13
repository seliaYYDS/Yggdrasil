import { useEffect, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { PanelWindow } from './PanelWindow';
import {
  clearWorkspace,
  deleteEntry,
  formatBytes,
  listWorkspace,
  WORKSPACE_SOFT_LIMIT,
  type WorkspaceMeta,
} from '../kernel/workspace/store';

/**
 * 工作区面板（用户的视角）。
 *
 * **刻意只给"看"和"删"**：工作区是 Agent 的加工台，写入口只属于它。
 * 用户需要的是"知道它在用什么、能清掉"—— 给用户一个写入口反而会制造
 * "谁改的"这种分不清的问题（Agent 那边也可能正在用同一个名字）。
 *
 * 刷新时机：这个面板在打开时读一次，并提供手动刷新 —— 不做实时订阅，
 * 因为 Agent 写文件是低频动作，为它挂一个订阅不值得。
 * 但**删除后立刻重读**，这样用户能看到自己操作的结果。
 */
export function WorkspacePanel() {
  const open = useDesktopStore((s) => s.workspaceOpen);
  const setOpen = useDesktopStore((s) => s.setWorkspaceOpen);
  const [files, setFiles] = useState<WorkspaceMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const reload = async () => {
    setBusy(true);
    try {
      setFiles(await listWorkspace());
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 打开时读一次；关闭后再打开会重新读（因为 open 变了，依赖对了）。
  useEffect(() => {
    if (open) void reload();
  }, [open]);

  if (!open) return null;

  const used = files.reduce((n, f) => n + f.size, 0);

  const remove = async (name: string) => {
    await deleteEntry(name);
    setNote('已删除 ' + name + '（已嵌进组件的内容不受影响）。');
    await reload();
  };

  const clearAll = async () => {
    const n = await clearWorkspace();
    setNote('已清空 ' + n + ' 个文件。已嵌进组件的内容不受影响。');
    await reload();
  };

  return (
    <PanelWindow panel="workspace" title="工作区" minW={340} minH={300} onClose={() => setOpen(false)}>
      <div className="ygg-panel-body">
        <div className="ygg-hint" style={{ marginTop: 0 }}>
          Agent 的**临时**加工台：它把文本/图片先放这里处理，再嵌进组件。
          嵌进去的内容是**复制**的，所以这里删掉不会弄坏已经做好的界面。
          你只能看和删 —— 写入口只给 Agent。
        </div>

        <div className="ygg-row-gap" style={{ marginTop: 8 }}>
          <button className="ygg-btn ghost tiny" disabled={busy} onClick={() => void reload()}>
            {busy ? '读取中…' : '刷新'}
          </button>
          <button className="ygg-btn tiny danger" disabled={files.length === 0} onClick={() => void clearAll()}>
            清空
          </button>
          <span className="ygg-ws-usage">
            {files.length} 个文件 · {formatBytes(used)} / {formatBytes(WORKSPACE_SOFT_LIMIT)}
          </span>
        </div>

        {note ? <div className="ygg-hint" style={{ marginTop: 6 }}>{note}</div> : null}

        {files.length === 0 ? (
          <div className="ygg-empty" style={{ marginTop: 10 }}>工作区是空的。</div>
        ) : (
          files.map((f) => (
            <div className="ygg-ws-row" key={f.name}>
              <span className="ygg-ws-name" title={f.mime}>{f.name}</span>
              <span className="ygg-ws-kind">{f.kind}</span>
              <span className="ygg-ws-size">{formatBytes(f.size)}</span>
              <button className="ygg-btn tiny ghost" onClick={() => void remove(f.name)}>删除</button>
            </div>
          ))
        )}
      </div>
    </PanelWindow>
  );
}

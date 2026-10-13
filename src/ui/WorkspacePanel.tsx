import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';
import { PanelWindow } from './PanelWindow';
import {
  clearWorkspace,
  deleteEntry,
  formatBytes,
  getEntry,
  listWorkspace,
  onWorkspaceChange,
  textOf,
  WORKSPACE_SOFT_LIMIT,
  type WorkspaceEntry,
  type WorkspaceMeta,
} from '../kernel/workspace/store';

/** 预览时文本最多显示多少字符（面板是给人看的，不需要全文）。 */
const PREVIEW_CHARS = 20000;

/**
 * 工作区面板（用户的视角）。
 *
 * **只给"看"和"删"**：工作区是 Agent 的加工台，写入口只属于它。
 *
 * **实时**：订阅工作区的变更信号（Agent 每写/删一次都会打一下），
 * 所以 Agent 刚放进去的东西立刻出现在这里 —— 不需要用户点刷新。
 * 手动"刷新"按钮保留着：它花的是一次 list 的代价，作为"我怀疑界面不对"的兜底总是值得的。
 *
 * **能看内容**：点一行展开预览。文本直接显示；图片用 objectURL 真的画出来，
 * 并且**在展开时才创建、收起或换一个时立刻 revoke** —— 否则浏览器的
 * blob URL 会一直占着内存不放（这类泄漏在"预览一堆图"时最容易攒出来）。
 */
export function WorkspacePanel() {
  const open = useDesktopStore((s) => s.workspaceOpen);
  const setOpen = useDesktopStore((s) => s.setWorkspaceOpen);
  const [files, setFiles] = useState<WorkspaceMeta[]>([]);
  const [note, setNote] = useState('');
  /** 当前展开预览的文件名（同一时刻只展开一个 —— 预览图会占内存）。 */
  const [previewName, setPreviewName] = useState('');
  const [preview, setPreview] = useState<WorkspaceEntry | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewErr, setPreviewErr] = useState('');

  const reload = useCallback(async () => {
    try {
      setFiles(await listWorkspace());
    } catch (e) {
      setNote((e as Error).message);
    }
  }, []);

  // 打开时读一次，并且**订阅变更**：Agent 写入立刻可见。
  useEffect(() => {
    if (!open) return;
    void reload();
    const off = onWorkspaceChange(() => {
      void reload();
      // 正在预览的文件被改了/删了，预览也要跟着更新。
      setPreview((cur) => {
        if (!cur) return cur;
        void getEntry(cur.name).then((fresh) => {
          if (!fresh) {
            setPreview(null);
            setPreviewErr('这个文件已经不在了。');
          } else {
            setPreview(fresh);
          }
        });
        return cur;
      });
    });
    return off;
  }, [open, reload]);

  /*
   * 图片预览的 objectURL 生命周期：**只在展开图片时创建**，
   * 收起、换文件、面板关闭、组件卸载时都要 revoke。
   * 不 revoke 的话那个 Blob 会一直被 URL 表钉住 —— 预览几张图就是几十 MB。
   */
  const prevUrlRef = useRef('');
  useEffect(() => {
    if (prevUrlRef.current && prevUrlRef.current !== previewUrl) {
      URL.revokeObjectURL(prevUrlRef.current);
    }
    prevUrlRef.current = previewUrl;
  }, [previewUrl]);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setPreviewUrl('');
      setPreviewName('');
    }
    return () => {
      if (prevUrlRef.current) {
        URL.revokeObjectURL(prevUrlRef.current);
        prevUrlRef.current = '';
      }
    };
  }, [open]);

  const togglePreview = async (name: string) => {
    if (previewName === name) {
      setPreviewName('');
      setPreview(null);
      setPreviewUrl('');
      setPreviewErr('');
      return;
    }
    setPreviewName(name);
    setPreviewErr('');
    try {
      const entry = await getEntry(name);
      if (!entry) {
        setPreview(null);
        setPreviewErr('这个文件已经不在了。');
        return;
      }
      setPreview(entry);
      // 图片才有 blob，也才需要 objectURL。
      setPreviewUrl(entry.blob && entry.kind === 'image' ? URL.createObjectURL(entry.blob) : '');
    } catch (e) {
      setPreview(null);
      setPreviewErr((e as Error).message);
    }
  };

  if (!open) return null;

  const used = files.reduce((n, f) => n + f.size, 0);

  const remove = async (name: string) => {
    await deleteEntry(name);
    setNote('已删除 ' + name);
    if (previewName === name) {
      setPreviewName('');
      setPreview(null);
      setPreviewUrl('');
    }
  };

  const clearAll = async () => {
    const n = await clearWorkspace();
    setNote('已清空 ' + n + ' 个文件');
    setPreviewName('');
    setPreview(null);
    setPreviewUrl('');
  };

  const previewText = preview ? textOf(preview) : undefined;

  return (
    <PanelWindow panel="workspace" title="工作区" minW={340} minH={300} onClose={() => setOpen(false)}>
      <div className="ygg-panel-body">
        <div className="ygg-hint" style={{ marginTop: 0 }}>
          Agent 的临时加工台。内容嵌进组件时是复制，删除这里的文件不影响界面。
        </div>

        <div className="ygg-row-gap" style={{ marginTop: 8 }}>
          <button className="ygg-btn ghost tiny" onClick={() => void reload()}>刷新</button>
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
            <div key={f.name}>
              <div className="ygg-ws-row">
                <button
                  className={'ygg-ws-name' + (previewName === f.name ? ' on' : '')}
                  title="点击查看内容"
                  onClick={() => void togglePreview(f.name)}
                >
                  {f.name}
                </button>
                <span className="ygg-ws-kind">{f.kind}</span>
                <span className="ygg-ws-size">{formatBytes(f.size)}</span>
                <button className="ygg-btn tiny ghost" onClick={() => void remove(f.name)}>删除</button>
              </div>

              {previewName === f.name ? (
                // 用局部常量拿住 preview：JSX 里的闭包会让 TS 失去对 state 的窄化。
                (() => {
                  const pv = preview;
                  if (previewErr) return <div className="ygg-plugin-error">{previewErr}</div>;
                  if (!pv) return <div className="ygg-hint">读取中…</div>;
                  return (
                    <div className="ygg-ws-preview">
                      {pv.kind === 'image' && previewUrl ? (
                        // 图片：真的画出来。objectURL 在收起/换文件时回收（见上面的 effect）。
                        <img className="ygg-ws-image" src={previewUrl} alt={pv.name} />
                      ) : previewText !== undefined ? (
                        // 文本：原样显示。空白不折叠、自动换行，长文本可滚动。
                        <pre className="ygg-ws-text">
                          {previewText.slice(0, PREVIEW_CHARS)}
                          {previewText.length > PREVIEW_CHARS
                            ? '\n… 还有 ' + (previewText.length - PREVIEW_CHARS) + ' 字符'
                            : ''}
                        </pre>
                      ) : (
                        // 其他二进制：如实说不能看，并给一个能落地的下一步。
                        <div className="ygg-hint">
                          {pv.mime || pv.kind}，无法在这里预览。
                        </div>
                      )}
                      <div className="ygg-ws-meta">
                        {pv.mime || '未知类型'} · {formatBytes(pv.size)} · 改动于 {new Date(pv.updatedAt).toLocaleString()}
                      </div>
                    </div>
                  );
                })()
              ) : null}
            </div>
          ))
        )}
      </div>
    </PanelWindow>
  );
}

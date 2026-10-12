import * as React from "react";

/**
 * 插件自带的界面。
 *
 * 组件**没有 props**（主页面就是 <C />），所以数据由 Agent 调 plugin_ui 时传进来，
 * 被注入成模块顶层的常量 data。没有传就是 null。
 */
export default function Board() {
  const d = (typeof data === "object" && data) || {};
  const rows = Array.isArray(d.rows) ? d.rows : [];
  return (
    <div style={{ width: "100%", height: "100%", padding: 12, background: "var(--ygg-surface)", color: "var(--ygg-fg)", overflow: "auto" }}>
      <div style={{ fontSize: 13, color: "var(--ygg-accent-hi)", marginBottom: 8 }}>
        {d.title || "状态看板"}
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--ygg-fg-muted)" }}>没有数据 —— 让 Agent 用 plugin_ui 传 data 进来。</div>
      ) : (
        rows.map((r, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", borderBottom: "1px solid var(--ygg-accent-dim)" }}>
            <span style={{ color: "var(--ygg-fg-muted)" }}>{String(r.label)}</span>
            <span>{String(r.value)}</span>
          </div>
        ))
      )}
    </div>
  );
}

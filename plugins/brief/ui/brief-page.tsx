import * as React from "react";

/**
 * 插件自带的**默认页面**（清单里的 pages，不是 ui + plugin_ui）。
 *
 * 它要做的事只有一件：让用户**随时能看见这个插件改了什么**。
 * 安装确认里已经说过一次，但那是一次性的；插件长期装着，改的东西却是长期的 ——
 * 所以这里再给一个随时可查的地方，而且不用记在哪。
 *
 * 数据来自清单里的 pages[].data（静态注入成模块顶层的 data 常量），
 * 因为运行时没有人会给它传参。
 */
export default function BriefPage() {
  const d = (typeof data === "object" && data) || {};
  const patches = Array.isArray(d.patches) ? d.patches : [];
  const [openAt, setOpenAt] = React.useState(-1);

  const rowStyle = {
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
    padding: "6px 0",
  };

  return (
    <div style={{ padding: 12, height: "100%", overflow: "auto", color: "var(--ygg-fg)" }}>
      <div style={{ fontFamily: "var(--ygg-font-display)", fontSize: 13, color: "var(--ygg-accent-hi)", marginBottom: 6 }}>
        {d.title || "这个插件改了什么"}
      </div>
      <div style={{ fontSize: 11, color: "var(--ygg-fg-muted)", lineHeight: 1.7, marginBottom: 10 }}>
        {d.note || "它会在 Agent 的系统提示里插一段要求。点标题展开原文。"}
      </div>

      {patches.map((p, i) => (
        <div key={i} style={{ borderBottom: "1px solid var(--ygg-accent-dim)" }}>
          <button
            // 页面里的按钮就是普通按钮：给它加 useAgent() 之类的能力都不是必需的。
            className="ygg-btn ghost tiny"
            style={{ ...rowStyle, width: "100%", textAlign: "left", cursor: "pointer" }}
            onClick={() => setOpenAt(openAt === i ? -1 : i)}
            title="展开 / 收起原文"
          >
            <span style={{ color: "var(--ygg-accent)", flex: "none" }}>{openAt === i ? "−" : "+"}</span>
            <span>
              <span style={{ fontSize: 11 }}>{p.label || p.op}</span>
              <span style={{ display: "block", fontSize: 10, color: "var(--ygg-fg-muted)" }}>
                {p.op} @ {p.where}
              </span>
            </span>
          </button>
          {openAt === i ? (
            <pre
              style={{
                margin: "0 0 8px 22px",
                padding: 8,
                fontSize: 10,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                color: "var(--ygg-fg-muted)",
                border: "1px solid var(--ygg-accent-dim)",
                borderRadius: "var(--ygg-radius)",
                fontFamily: "var(--ygg-font-mono)",
              }}
            >
              {String(p.text || "")}
            </pre>
          ) : null}
        </div>
      ))}

      {patches.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--ygg-fg-muted)" }}>这个插件没有声明任何提示词改动。</div>
      ) : null}
    </div>
  );
}

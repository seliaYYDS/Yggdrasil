import * as React from "react";

/**
 * 插件自带的**默认页面**：一个走着的时钟。
 *
 * 它刻意只用 React 自己的状态（setInterval + useState），不碰任何宿主能力 ——
 * 用来证明插件页面是**真的在跑的组件**，不是一段静态标记：
 * 页面能自己计时、自己重渲染、自己放按钮。
 */
export default function ClockPage() {
  const [now, setNow] = React.useState(() => new Date());
  const [lap, setLap] = React.useState(null);

  React.useEffect(() => {
    // 一秒一跳。清理函数必须返回 —— 页面关掉后定时器不能还留着。
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const pad = (n) => String(n).padStart(2, "0");
  const hhmmss = pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];

  return (
    <div style={{ padding: 14, height: "100%", display: "flex", flexDirection: "column", color: "var(--ygg-fg)" }}>
      <div
        style={{
          fontFamily: "var(--ygg-font-mono)",
          fontSize: 30,
          letterSpacing: ".04em",
          color: "var(--ygg-accent-hi)",
          lineHeight: 1.2,
        }}
      >
        {hhmmss}
      </div>
      <div style={{ fontSize: 11, color: "var(--ygg-fg-muted)", marginTop: 4 }}>
        {now.getFullYear()}-{pad(now.getMonth() + 1)}-{pad(now.getDate())} {weekday}
      </div>

      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <button className="ygg-btn ghost tiny" onClick={() => setLap(hhmmss)}>
          记下此刻
        </button>
        <span style={{ fontSize: 11, color: "var(--ygg-fg-muted)" }}>
          {lap ? "上一个标记：" + lap : "还没标记过"}
        </span>
      </div>
      {lap ? (
        <button className="ygg-btn ghost tiny" style={{ marginTop: 8, alignSelf: "flex-start" }} onClick={() => setLap(null)}>
          清除标记
        </button>
      ) : null}
    </div>
  );
}

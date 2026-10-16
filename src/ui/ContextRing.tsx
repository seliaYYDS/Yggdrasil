import { useState } from 'react';

/**
 * 上下文占用圆环。
 *
 * 位置由调用方决定（输入框右下角、用量指标右边），这里只管三件事：
 * **按百分比画一圈**、**悬浮给出准确数字**、**点一下要求压缩**。
 *
 * 为什么是圆环而不是又一个数字：状态行那一排已经有三个数字了，再加一个只会更难扫。
 * 圆环把"还剩多少"变成一眼可判的形状，数字留到悬浮里 —— 那里本来就没有长度限制。
 */

/** 直径。要与 CSS 里的 .ygg-ctx 尺寸一致（两处都改才对齐）。 */
const SIZE = 15;
const STROKE = 2;

/**
 * 阈值未知时的兜底分档（按窗口的百分比算）：
 * 到 75% 提醒、到 100% 算满。设置里默认的压缩阈值是 85%，所以这两个数只是后备。
 */
const WARN_AT = 0.75;

export interface ContextRingProps {
  /** 估算的当前输入 token。undefined = 还没跑过。 */
  tokens?: number;
  /** 上下文窗口。0 / undefined = 未知。 */
  limit?: number;
  /** 压缩阈值（窗口 × 压缩百分比）。用来给颜色分档。 */
  threshold?: number;
  /** 正在压缩时转起来、并且不可重复点。 */
  busy?: boolean;
  /** 点圆环：请求手动压缩。 */
  onCompact: () => void;
}

export function ContextRing({ tokens, limit, threshold, busy, onCompact }: ContextRingProps) {
  const [hover, setHover] = useState(false);
  const known = typeof tokens === 'number' && typeof limit === 'number' && limit > 0;
  /*
   * 占用比例。**未知窗口时按 0 画**（只有轨道），而不是按 100% ——
   * 那会让人以为"满了"，而实际只是没填窗口。
   */
  const ratio = known ? Math.max(0, Math.min(1, (tokens as number) / (limit as number))) : 0;
  /*
   * 颜色分档按**阈值**而不是 100%：压缩发生在阈值处，所以"到阈值"才是该提醒的时刻。
   * 阈值未知时退回按窗口百分比（WARN_AT）。
   */
  const mark = known && threshold && threshold > 0 ? Math.min(1, threshold / (limit as number)) : WARN_AT;
  const level = !known ? 'unknown' : ratio >= mark ? 'full' : ratio >= mark * 0.8 ? 'warn' : 'ok';

  const r = (SIZE - STROKE) / 2;
  const c = 2 * Math.PI * r;
  const percent = known ? Math.round(ratio * 100) : 0;

  const tip = !known
    ? '上下文占用：还不知道（先在设置里填上下文窗口）'
    : '上下文 ' + tokens + ' / ' + limit + ' token（' + percent + '%）' +
      (threshold ? '；压缩阈值 ' + threshold : '') +
      '。点一下立即压缩历史。';

  return (
    <span
      className={'ygg-ctx' + (busy ? ' is-busy' : '')}
      role="button"
      tabIndex={0}
      title={tip}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={busy ? undefined : onCompact}
      onKeyDown={(e) => {
        if (busy) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCompact();
        }
      }}
    >
      <svg width={SIZE} height={SIZE} viewBox={'0 0 ' + SIZE + ' ' + SIZE}>
        {/* 轨道：永远画满一圈，这样"没有数据"和"0%"能区分开（前者没有进度弧）。 */}
        <circle
          className="ygg-ctx-track"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          strokeWidth={STROKE}
        />
        {known && ratio > 0 ? (
          <circle
            className={'ygg-ctx-arc is-' + level}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={r}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            /*
             * 用 dasharray 画一段弧：周长 c，画 c*ratio、留 c*(1-ratio)。
             * 不用 path 里的 arc 命令是因为它要给起止角度算坐标，而 dasharray 只给比例。
             */
            strokeDasharray={c}
            strokeDashoffset={c * (1 - ratio)}
            // 从 12 点开始顺时针：默认起点在 3 点，转 -90° 挪到顶部。
            transform={'rotate(-90 ' + SIZE / 2 + ' ' + SIZE / 2 + ')'}
          />
        ) : null}
      </svg>
      {/*
        悬浮时把百分比**写在圆环旁边**而不是再用一个 title ——
        用户要求的就是"hover 显示当前使用百分比"，而那是个必须立刻看到的数字。
      */}
      {hover && known ? <span className="ygg-ctx-num">{percent}%</span> : null}
    </span>
  );
}

import type { ReactNode, SVGProps } from 'react';

/**
 * 右上角的图标。
 *
 * 全部改成**内联 SVG**：之前用的是 `≡` / `☰` 这类字符，两枚几乎一样，分不出哪个是
 * 轨迹、哪个是节点。现在每个图标形态完全不同，并且统一 currentColor + 1.5px 描边。
 */

const base: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
};

function Svg({ children, ...rest }: { children: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...rest}>
      {children}
    </svg>
  );
}

/**
 * 轨迹：一条主干 + 三段分支（就是这个应用轨迹面板的样子）。
 * 和"节点"最大的区别：它是**自上而下的一条线**，没有分叉出的子树。
 */
export function TraceIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 2.5v11" />
      <path d="M4 4.5h7" />
      <path d="M4 8h5" />
      <path d="M4 11.5h7" />
      <circle cx="4" cy="4.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/**
 * 节点：一棵向下分叉的树（一个根 + 两个子节点）。
 * 和"轨迹"最大的区别：它有**分叉**，是横向铺开的层级，不是一条线。
 */
export function NodesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="5.5" y="1.6" width="5" height="3.4" rx="1" />
      <rect x="1.6" y="11" width="5" height="3.4" rx="1" />
      <rect x="9.4" y="11" width="5" height="3.4" rx="1" />
      <path d="M8 5v2.4" />
      <path d="M4.1 11V8.9h7.8V11" />
      <path d="M4.1 8.9V7.4" />
      <path d="M11.9 8.9V7.4" />
      <path d="M4.1 7.4h7.8" />
    </Svg>
  );
}

/** 新输入框：一个窗口 + 一个加号。 */
export function NewInputIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.4" />
      <path d="M1.8 6h12.4" />
      <path d="M8 8.2v3.2" />
      <path d="M6.4 9.8h3.2" />
    </Svg>
  );
}

/** 设置：齿轮。 */
export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.4v1.9M8 12.7v1.9M1.4 8h1.9M12.7 8h1.9" />
      <path d="M3.34 3.34l1.34 1.34M11.32 11.32l1.34 1.34M12.66 3.34l-1.34 1.34M4.68 11.32l-1.34 1.34" />
    </Svg>
  );
}

/** 重置：一圈回转箭头。 */
export function ResetIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75" />
      <path d="M13.4 1.9v3.1h-3.1" />
    </Svg>
  );
}

/* ------------------------------------------------------------------ */
/* Nodes 面板与挂件操控用的小图标                                       */
/* ------------------------------------------------------------------ */

/** 源码：尖括号。 */
export function CodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M6 4.5 2.5 8 6 11.5" />
      <path d="M10 4.5 13.5 8 10 11.5" />
    </Svg>
  );
}

/** 改版：铅笔。 */
export function EditIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M11.2 2.4 13.6 4.8 5.9 12.5 2.6 13.4 3.5 10.1z" />
    </Svg>
  );
}

/** 显示中：实心点。 */
export function ActiveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 最小化：圆 + 底下的横线。 */
export function MinimizedIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="4" />
      <path d="M2.6 13.4h10.8" />
    </Svg>
  );
}

/** 已关闭：空心圆。 */
export function ClosedIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="4" />
    </Svg>
  );
}

/** 锁定：闭合的锁。 */
export function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3.4" y="7" width="9.2" height="7" rx="1.2" />
      <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" />
    </Svg>
  );
}

/** 未锁定：锁梁翘起来。 */
export function UnlockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3.4" y="7" width="9.2" height="7" rx="1.2" />
      <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0" />
    </Svg>
  );
}

/** 固定：图钉。 */
export function PinIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M9.6 1.9 14.1 6.4l-2.2.6-2.3 2.3.3 2.8-1.2 1.2-3.3-3.3-3.2 3.2" />
      <path d="M4.2 9.4 6.5 7.1l.6-2.2 4.5 4.5-2.2.6-2.3 2.3z" />
    </Svg>
  );
}

/** 移动：四向箭头。 */
export function MoveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M8 2v12M2 8h12" />
      <path d="M8 2 6.3 3.9M8 2l1.7 1.9M8 14l-1.7-1.9M8 14l1.7-1.9" />
      <path d="M2 8l1.9-1.7M2 8l1.9 1.7M14 8l-1.9-1.7M14 8l-1.9 1.7" />
    </Svg>
  );
}

/** 缩放：右下角拉伸。 */
export function ScaleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3 13 13 3" />
      <path d="M9.4 3H13v3.6" />
      <path d="M3 9.4V13h3.6" />
    </Svg>
  );
}

/** 关闭：叉。 */
export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </Svg>
  );
}

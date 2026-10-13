import type { ReactNode } from 'react';

/**
 * 开关滑块。
 *
 * 之前那个"开关灯"（一个会亮的小圆点 + 一行文字）有两个问题：
 * ① "开"与"关"只靠一个小圆点的填充色区分，扫一眼看不出来；
 * ② 不像开关 —— 用户得读文字才知道点了会怎样。
 * 现在是一个**滑块**：轨道 + 会滑过去的圆钮，位移本身就在表达状态；
 * 过渡用 transform（不是 left），所以动画走合成层，不会掉帧。
 */
export function Switch({
  on,
  onChange,
  label,
  title,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  /** 右侧文字。 */
  label?: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      /*
       * role="switch" + aria-checked：屏幕阅读器会念成"开关，已打开"，而不是"按钮"。
       * 纯视觉的滑块必须补这一层，否则对读屏用户来说状态是丢失的。
       */
      role="switch"
      aria-checked={on}
      className="ygg-switch"
      title={title}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className={'ygg-switch-track' + (on ? ' on' : '')}>
        <span className="ygg-switch-knob" />
      </span>
      {label ? <span className="ygg-switch-label">{label}</span> : null}
    </button>
  );
}

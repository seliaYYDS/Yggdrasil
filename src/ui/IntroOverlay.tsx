import { useEffect, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';

/**
 * 初始引导。
 *
 * 每步要么指向一个真控件（设置、输入框、面板按钮、场景按钮），要么说清一个概念。
 * 文案只写**事实与操作**：不含主观评价，也不写"它会记住"这类与操作无关的补充。
 *
 * 三处刻意的设计：
 * 1. **跳过放在左上角**，且第一帧就在 —— 想跳过的人不需要先走完；
 * 2. 指向某一步的目标时会**把那个控件从模糊里挖出来**（其余地方压暗并模糊），
 *    所以"说的"和"看到的"是同一个东西，不需要用户自己找；
 * 3. 看过就记进本地存储；重放入口在设置 → 常规（最后一步会指出来）。
 */
interface IntroStep {
  title: string;
  body: string[];
  /** 要"挖出来"的控件。找不到就退化成整页压暗（不挖洞）。 */
  target?: string;
  /**
   * 这一步要额外摆出来的**占位示例**。
   *
   * 有些东西光说没用：「窗口与组件」与「任务栏」两步，界面上本来是空的
   * （没有窗口、没有最小化的窗口），只靠文字讲"窗口可以拖"是空口白话。
   * 所以临时摆一个**不可交互的占位**，指给它看 —— 引导结束（组件卸载）时一起消失，
   * 不进节点树、不落盘、不参与任何交互。
   */
  demo?: 'window' | 'taskbar';
}

/**
 * 步骤表。**导出是为了能被断言**：哪一步指向哪个控件、哪一步摆占位示例，
 * 都是"说好的行为"，不该只存在于源码里靠人眼看。
 */
export const INTRO_STEPS: IntroStep[] = [
  {
    title: '配置模型',
    body: ['点右上角的 ⚙ 打开设置，在「入口」里填 Base / Key / Model。', '配置只存在本地。'],
    target: '[data-ygg-intro="settings"]',
  },
  {
    title: '输入框',
    body: ['输入任务后回车提交，Shift + Enter 换行。', '拖动标题栏移动窗口。'],
    target: '[data-ygg-intro="input"]',
  },
  {
    title: '窗口与组件',
    body: ['模型按输入生成窗口与组件。', '所有窗口都可以拖动、缩放、最小化。'],
    demo: 'window',
    target: '[data-ygg-intro="demo-window"]',
  },
  {
    title: '面板',
    body: ['节点树显示生成的内容，轨迹显示每一轮的过程，工作区存放文件。', '插件面板安装 .graft，设置面板放模型参数与安全等级。'],
    target: '[data-ygg-intro="panels"]',
  },
  {
    title: '场景',
    body: ['导出：把当前桌面存成 .seed 文件。导入：把它读回来。', '场景不含密钥，也不含插件。'],
    target: '[data-ygg-intro="scene"]',
  },
  {
    title: '任务栏',
    body: ['最小化的窗口收在左下角，点击恢复。'],
    demo: 'taskbar',
    target: '[data-ygg-intro="demo-taskbar"]',
  },
  {
    title: '结束',
    body: ['重看这段引导：设置 → 常规 → 重放引导。', '示例输入：做个时钟。'],
  },
];

export function IntroOverlay() {
  const step = useDesktopStore((s) => s.introStep);
  const setIntroStep = useDesktopStore((s) => s.setIntroStep);
  const endIntro = useDesktopStore((s) => s.endIntro);
  /** 目标控件的屏幕矩形；量不到就不挖洞（退化成整页压暗）。 */
  const [hole, setHole] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const current = step >= 1 && step <= INTRO_STEPS.length ? INTRO_STEPS[step - 1] : null;
  const target = current?.target;

  useEffect(() => {
    if (!target) {
      setHole(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(target);
      if (!el) {
        setHole(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const pad = 6;
      setHole({ x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
    };
    measure();
    // 目标可能因为面板开关或窗口移动而变位置 —— 跟着重量，别让洞和控件错开。
    const timer = window.setInterval(measure, 300);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', measure);
    };
  }, [target, step]);

  if (!current) return null;
  const last = step === INTRO_STEPS.length;

  /*
   * 压暗 + 模糊层，并在有目标时把目标"挖"出来。
   *
   * 挖洞用 clip-path 的 evenodd 填充规则：一条 polygon 就能表达"整块减去一个矩形"，
   * 不必算四块遮罩的坐标。挖出来的那块**既不压暗也不模糊** —— 否则被指的控件自己也是
   * 糊的，等于没指。
   */
  const vw = '100%';
  const vh = '100%';
  const clip = hole
    ? 'polygon(evenodd, 0 0, ' + vw + ' 0, ' + vw + ' ' + vh + ', 0 ' + vh + ', 0 0, ' +
      hole.x + 'px ' + hole.y + 'px, ' + (hole.x + hole.w) + 'px ' + hole.y + 'px, ' +
      (hole.x + hole.w) + 'px ' + (hole.y + hole.h) + 'px, ' + hole.x + 'px ' + (hole.y + hole.h) + 'px, ' +
      hole.x + 'px ' + hole.y + 'px)'
    : undefined;

  return (
    <div className="ygg-intro">
      <div className="ygg-intro-blur" style={clip ? { clipPath: clip } : undefined} />

      {/*
        占位示例：只在声明了 demo 的那两步出现，画在模糊层**之上**（所以它是清楚的），
        并且随引导一起卸载 —— 不进节点树、不落盘、不可交互。
      */}
      {current.demo === 'window' ? (
        <div className="ygg-intro-demo-window" data-ygg-intro="demo-window">
          <div className="ygg-intro-demo-title">示例组件</div>
          <div className="ygg-intro-demo-body">窗口内容</div>
        </div>
      ) : null}
      {current.demo === 'taskbar' ? (
        <div className="ygg-intro-demo-task" data-ygg-intro="demo-taskbar">
          示例窗口
        </div>
      ) : null}
      {hole ? (
        <div
          className="ygg-intro-hole"
          style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }}
        />
      ) : null}

      {/*
        跳过放在左上角，并且**第一帧就在**：想跳过的人不该先走完七步。
        它在模糊层之上，随时可点。
      */}
      <button className="ygg-intro-skip" onClick={endIntro} title="不再显示这段引导">
        跳过引导
      </button>

      {/* key 跟着步骤走：每翻一步都重播一次入场动画，节奏比"整块只播一次"更容易跟上。 */}
      <div className="ygg-intro-card" key={step} role="dialog" aria-label="初始引导">
        <div className="ygg-intro-count">
          {step} / {INTRO_STEPS.length}
        </div>
        <div className="ygg-intro-title">{current.title}</div>
        {current.body.map((line, i) => (
          <div className="ygg-intro-line" key={i}>
            {line}
          </div>
        ))}
        <div className="ygg-intro-actions">
          {step > 1 ? (
            <button className="ygg-btn ghost" onClick={() => setIntroStep(step - 1)}>
              上一步
            </button>
          ) : null}
          <span className="ygg-intro-spacer" />
          <button className="ygg-btn primary" onClick={() => (last ? endIntro() : setIntroStep(step + 1))}>
            {last ? '完成' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}

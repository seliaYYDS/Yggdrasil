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
 * 引导此刻处在哪一段。**导出是为了能被断言**：这三段的先后关系（树 → 卡片 → 都不显示）
 * 是"说好的行为"，不该只存在于 JSX 的条件里靠人眼看。
 */
export function introPhase(step: number, tree: boolean, outro = false): 'hidden' | 'tree' | 'card' | 'outro' {
  // 收尾优先于步数：走完之后 step 已经归 0，但这一层还要留着播完动画。
  if (outro) return 'outro';
  if (step < 1 || step > INTRO_STEPS.length) return 'hidden';
  return tree ? 'tree' : 'card';
}

/**
 * 步骤表。**导出是为了能被断言**：哪一步指向哪个控件、哪一步摆占位示例，
 * 都是"说好的行为"，不该只存在于源码里靠人眼看。
 */
export const INTRO_STEPS: IntroStep[] = [
  {
    title: '欢迎来到 Yggdrasil',
    body: ['用一句话生成界面。', '接下来按顺序说明配置与界面。'],
  },
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

/**
 * 开场动画的时长。与 CSS 里 `ygg-intro-tree-in` 的时长**必须是同一个数** ——
 * 动画结束时组件才把卡片放出来，对不上就会出现"树还没长完卡片就压上来"或"树走完了空等"。
 */
const TREE_MS = 1700;

/**
 * 开场：一棵金色的树展开。
 *
 * 用 SVG 的 `stroke-dashoffset` 逐条"画出来"（配合 `pathLength=1` 让每条路径的
 * 归一化长度一致，不必为每根枝算 dash 长度），而不是放一张图做缩放 ——
 * 缩放看起来是"图片变大"，画出来才是"树展开"。
 * 只有描边、没有填充与阴影，与界面本身的画法一致。
 */
function IntroTree() {
  return (
    <div className="ygg-intro-tree" aria-hidden="true">
      <svg viewBox="0 0 200 210" width="240" height="252">
        <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path pathLength={1} d="M100 200 L100 96" />
          <path pathLength={1} d="M100 150 L62 116" />
          <path pathLength={1} d="M100 132 L140 96" />
          <path pathLength={1} d="M100 110 L70 76" />
          <path pathLength={1} d="M100 96 L132 62" />
          <path pathLength={1} d="M100 84 L100 40" />
          <path pathLength={1} d="M74 80 L56 58" />
          <path pathLength={1} d="M128 66 L146 42" />
        </g>
      </svg>
    </div>
  );
}


/**
 * 收尾动画的时长。与 CSS 里各段动画的时间轴**必须一致**（见 global.css 的注释）：
 *   0–300ms 卡片渐隐 → 300–760ms 「Yggdrasil」浮现 → 1100–1600ms 文字与暗化一起淡出
 */
const OUTRO_MS = 1600;

export function IntroOverlay() {
  const step = useDesktopStore((s) => s.introStep);
  const setIntroStep = useDesktopStore((s) => s.setIntroStep);
  const endIntro = useDesktopStore((s) => s.endIntro);
  const finishIntro = useDesktopStore((s) => s.finishIntro);
  const tree = useDesktopStore((s) => s.introTree);
  const setIntroTree = useDesktopStore((s) => s.setIntroTree);
  const outro = useDesktopStore((s) => s.introOutro);
  const setIntroOutro = useDesktopStore((s) => s.setIntroOutro);
  /** 目标控件的屏幕矩形；量不到就不挖洞（退化成整页压暗）。 */
  const [hole, setHole] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  /* 开场动画：时间到了就交给卡片。定时器与 CSS 动画用同一个常量。 */
  useEffect(() => {
    if (!tree) return;
    const timer = window.setTimeout(() => setIntroTree(false), TREE_MS);
    return () => window.clearTimeout(timer);
  }, [tree, setIntroTree]);

  /* 收尾动画：时间到了就把这一层整个撤掉（此后什么都不渲染）。 */
  useEffect(() => {
    if (!outro) return;
    const timer = window.setTimeout(() => setIntroOutro(false), OUTRO_MS);
    return () => window.clearTimeout(timer);
  }, [outro, setIntroOutro]);

  const phase = introPhase(step, tree, outro);
  const current = step >= 1 && step <= INTRO_STEPS.length ? INTRO_STEPS[step - 1] : null;
  const target = current?.target;

  useEffect(() => {
    if (!target || phase !== 'card') {
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
  }, [target, phase, step]);

  if (phase === 'hidden') return null;

  /*
   * 压暗 + 模糊层，并在有目标时把目标"挖"出来。
   *
   * 挖洞用 clip-path 的 evenodd 填充规则：一条 polygon 就能表达"整块减去一个矩形"，
   * 不必算四块遮罩的坐标。挖出来的那块**既不压暗也不模糊** —— 否则被指的控件自己也是
   * 糊的，等于没指。
   */
  const clip = hole
    ? 'polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ' +
      hole.x + 'px ' + hole.y + 'px, ' + (hole.x + hole.w) + 'px ' + hole.y + 'px, ' +
      (hole.x + hole.w) + 'px ' + (hole.y + hole.h) + 'px, ' + hole.x + 'px ' + (hole.y + hole.h) + 'px, ' +
      hole.x + 'px ' + hole.y + 'px)'
    : undefined;

  /** 卡片。收尾阶段用同一套外观，但换成"正在渐隐"的变体、并且不再有按钮。 */
  const renderCard = (item: IntroStep, index: number, fading: boolean) => (
    <div
      className={'ygg-intro-card' + (fading ? ' is-out' : '')}
      key={fading ? 'outro' : step}
      role="dialog"
      aria-label="初始引导"
    >
      <div className="ygg-intro-count">
        {index} / {INTRO_STEPS.length}
      </div>
      <div className="ygg-intro-title">{item.title}</div>
      {item.body.map((line, i) => (
        <div className="ygg-intro-line" key={i}>
          {line}
        </div>
      ))}
      {fading ? null : (
        <div className="ygg-intro-actions">
          {index > 1 ? (
            <button className="ygg-btn ghost" onClick={() => setIntroStep(index - 1)}>
              上一步
            </button>
          ) : null}
          <span className="ygg-intro-spacer" />
          <button
            className="ygg-btn primary"
            onClick={() => (index === INTRO_STEPS.length ? finishIntro() : setIntroStep(index + 1))}
          >
            {index === INTRO_STEPS.length ? '完成' : '下一步'}
          </button>
        </div>
      )}
    </div>
  );

  const outroCard = INTRO_STEPS[INTRO_STEPS.length - 1];

  return (
    <div className="ygg-intro">
      {/*
        跳过放在左上角，并且**第一帧就在**：想跳过的人不该先走完七步。
        它在模糊层之上，随时可点；收尾那一段没有东西可跳过，所以不渲染。
      */}
      {phase === 'outro' ? null : (
        <button className="ygg-intro-skip" onClick={endIntro} title="不再显示这段引导">
          跳过引导
        </button>
      )}

      {phase === 'outro' ? (
        /*
         * 收尾：卡片渐隐 → 中间浮出「Yggdrasil」→ 文字与暗化一起淡出。
         * 三段的时间轴全在 CSS 里（global.css 的 ygg-intro-outro-*），
         * 定时器只负责"以后把这一层撤掉"。
         */
        <div className="ygg-intro-outro" aria-hidden="true">
          <div className="ygg-intro-outro-dim" />
          {renderCard(outroCard, INTRO_STEPS.length, true)}
          <div className="ygg-intro-outro-word">Yggdrasil</div>
        </div>
      ) : (
        <>
          <div className="ygg-intro-blur" style={clip ? { clipPath: clip } : undefined} />
          {hole ? (
            <div className="ygg-intro-hole" style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }} />
          ) : null}

          {/*
            占位示例：只在声明了 demo 的那两步出现，画在模糊层**之上**（所以它是清楚的），
            并且随引导一起卸载 —— 不进节点树、不落盘、不可交互。
          */}
          {phase === 'card' && current && current.demo === 'window' ? (
            <div className="ygg-intro-demo-window" data-ygg-intro="demo-window">
              <div className="ygg-intro-demo-title">示例组件</div>
              <div className="ygg-intro-demo-body">窗口内容</div>
            </div>
          ) : null}
          {phase === 'card' && current && current.demo === 'taskbar' ? (
            <div className="ygg-intro-demo-task" data-ygg-intro="demo-taskbar">
              示例窗口
            </div>
          ) : null}

          {phase === 'tree' ? <IntroTree /> : null}
          {phase === 'card' && current ? renderCard(current, step, false) : null}
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useDesktopStore } from '../store/desktopStore';

/**
 * 初始引导。
 *
 * 目的只有两个：**把模型配好**、**认识这个界面**。所以每步要么指向一个真控件
 * （设置、输入框、面板按钮、场景按钮），要么说清一个概念（"每个界面元素都是窗口"）。
 *
 * 三处刻意的设计：
 * 1. **跳过放在左上角**，且不藏在最后一步 —— 想跳过的人不需要先走完；
 * 2. 指向某一步的目标时会**把那个控件挖出来**（其余地方压暗），
 *    所以"说的"和"看到的"是同一个东西，不需要用户自己找；
 * 3. 看过就记进本地存储；重放入口在设置 → 常规（引导本身会告诉用户在哪儿）。
 */
interface IntroStep {
  title: string;
  body: string[];
  /** 要"挖出来"的控件。找不到就退化成普通卡片（不压暗）。 */
  target?: string;
}

const STEPS: IntroStep[] = [
  {
    title: '先配好模型',
    body: [
      '点右上角的 ⚙ 打开设置，在「入口」里填 Base / Key / Model。',
      '这三项只存在浏览器本地，不经过任何后端。',
    ],
    target: '[data-ygg-intro="settings"]',
  },
  {
    title: '这是入口',
    body: [
      '中间这个输入框就是唯一的入口：输入一句话，回车提交。',
      'Shift + Enter 换行；拖动标题栏可以把它挪到顺手的位置，位置会记住。',
    ],
    target: '[data-ygg-intro="input"]',
  },
  {
    title: '每个界面元素都是窗口',
    body: [
      '模型会根据你说的话生成窗口与组件：图表、列表、日历、看板都可以。',
      '所有窗口都能拖、能缩放、能最小化 —— 可以像整理桌面一样摆放它们。',
    ],
  },
  {
    title: '右上角是各个面板',
    body: [
      '节点树看生成出来的东西，轨迹看每一轮发生了什么，工作区放上传与加工的文件。',
      '插件面板用来安装插件（.graft），设置面板里有模型参数与安全等级。',
    ],
    target: '[data-ygg-intro="panels"]',
  },
  {
    title: '左上角是场景',
    body: [
      '导出把当前桌面存成一个 .seed 文件，导入把它读回来 —— 换台机器也能接着用。',
      '场景里只记内容，不含密钥，也不含装过的插件。',
    ],
    target: '[data-ygg-intro="scene"]',
  },
  {
    title: '最小化的窗口在左下角',
    body: ['收起来的窗口会排在这里，点一下就恢复。'],
    target: '[data-ygg-intro="taskbar"]',
  },
  {
    title: '可以开始了',
    body: [
      '想再看一遍这段引导：设置 → 常规 → 重放引导。',
      '试试说「做个时钟」，或者「帮我查一下今天的天气」。',
    ],
  },
];

export function IntroOverlay() {
  const step = useDesktopStore((s) => s.introStep);
  const setIntroStep = useDesktopStore((s) => s.setIntroStep);
  const endIntro = useDesktopStore((s) => s.endIntro);
  /** 目标控件的屏幕矩形；量不到就不压暗（退化成普通卡片）。 */
  const [hole, setHole] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const current = step >= 1 && step <= STEPS.length ? STEPS[step - 1] : null;
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
      // 留一点余量，让挖出来的洞不至于紧贴控件边缘。
      const pad = 6;
      setHole({ x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
    };
    measure();
    // 目标可能因为面板开关/窗口移动而变位置 —— 跟着重量，别让洞和控件错开。
    const t = window.setInterval(measure, 300);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('resize', measure);
    };
  }, [target, step]);

  if (!current) return null;
  const last = step === STEPS.length;

  return (
    <div className="ygg-intro">
      {/*
        压暗整页，并把当前步骤指向的控件"挖"出来。
        用一圈极大的 box-shadow 而不是四块遮罩：一块元素就能表达"除了这里都暗"，
        不必跟着目标尺寸算四个矩形的坐标。
      */}
      {hole ? (
        <div
          className="ygg-intro-hole"
          style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }}
        />
      ) : (
        <div className="ygg-intro-dim" />
      )}

      {/*
        跳过放在左上角，并且**第一帧就在**：想跳过的人不该先走完七步。
        它在遮罩之上，随时可点。
      */}
      <button className="ygg-intro-skip" onClick={endIntro} title="不再显示这段引导">
        跳过引导
      </button>

      <div className="ygg-intro-card" role="dialog" aria-label="初始引导">
        <div className="ygg-intro-count">
          {step} / {STEPS.length}
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
            {last ? '开始使用' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import { Desktop } from './Desktop';
import { Surface } from '../host/Surface';
import { Feedback } from '../ui/Feedback';
import { TopBar } from '../ui/TopBar';
import { ResetDialog } from '../ui/ResetDialog';
import { ConsoleErrorPrompt } from '../ui/ConsoleErrorPrompt';
import { SeedDialog } from '../ui/SeedDialog';
import { installConsoleErrorHooks, subscribeConsoleErrors } from '../host/consoleErrors';
import { useDesktopStore } from '../store/desktopStore';

export function App() {
  const loaded = useDesktopStore((s) => s.loaded);
  const hydrate = useDesktopStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  /*
   * 控制台报错 → 交给 store 决定要不要问用户。
   * 组件只管"听"，策略（agent 忙不忙、是不是刚问过）全在 store 里，别分两处。
   */
  useEffect(() => {
    installConsoleErrorHooks();
    return subscribeConsoleErrors((e) => {
      useDesktopStore.getState().reportConsoleError(e.text);
    });
  }, []);

  // 视口变化时把所有面板与窗口夹回可见区域 —— 不然缩小浏览器后标题栏会够不到。
  useEffect(() => {
    const onResize = () => {
      useDesktopStore.getState().fitToViewport(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!loaded) {
    return (
      <div className="ygg-desktop">
        <div className="ygg-desktop-bg" />
      </div>
    );
  }

  return (
    <>
      {/*
        面板（输入 / 检查器 / 轨迹 / 设置）由 Desktop 渲染，而不是这里。
        原因：.ygg-desktop 是 position:fixed，会创建自己的层叠上下文；
        面板若作为它的兄弟节点渲染，就永远压在组件窗口之上，z 值比较全部失效。
        放进同一个容器后，面板与组件窗口才真正共享一套层级。
      */}
      <Desktop />
      {/*
        整页效果层：盖在所有窗口与面板之上。
        这里是 Desktop 的**兄弟节点**（不是它的子节点）—— .ygg-desktop 会创建自己的层叠上下文，
        放进去的话就跟窗口们一起被关在里面了，盖不住。
        层级夹在桌面（低于它）与右上角按钮组（400000）之间。
        整层默认 pointer-events:none，不影响用户点窗口。
      */}
      <div className="ygg-overlay-layer">
        <Surface id="desktop.overlay" props={{ nodeCount: 0 }} fallback={null} />
      </div>
      {/* 下面两个是覆盖层，本就该在最上面 */}
      <TopBar />
      <ResetDialog />
      <ConsoleErrorPrompt />
      <SeedDialog />
      <Feedback />
    </>
  );
}

import { useEffect } from 'react';
import { Desktop } from './Desktop';
import { Feedback } from '../ui/Feedback';
import { TopBar } from '../ui/TopBar';
import { ResetDialog } from '../ui/ResetDialog';
import { useDesktopStore } from '../store/desktopStore';

export function App() {
  const loaded = useDesktopStore((s) => s.loaded);
  const hydrate = useDesktopStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

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
      {/* 下面两个是覆盖层，本就该在最上面 */}
      <TopBar />
      <ResetDialog />
      <Feedback />
    </>
  );
}

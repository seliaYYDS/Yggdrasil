import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { registerBuiltinTools } from './kernel/registry/builtins';
import { registerAllInterfaces } from './kernel/interfaces';
import { registerBuiltinSurfaces } from './host/surfaces';
import { registerModule } from './host/compile';
import { installConsoleErrorHooks } from './host/consoleErrors';
import { AgentIdContext, useAgent, isAgentId } from './host/agentRuntimeModule';
import './styles/tokens.css';
import './styles/global.css';

/*
 * 控制台报错钩子**在这里就装**，而不是等 App 的 useEffect ——
 * 后者要等第一次渲染完成，挂载期间（以及早于渲染的模块错误）都会被漏掉，
 * 用户看到的就是"报错了但没弹窗"。
 */
installConsoleErrorHooks();

registerBuiltinTools();
registerAllInterfaces();
registerBuiltinSurfaces();

/**
 * 把 Agent 运行时暴露给生成代码。
 * 这样 Agent 用 source 写自己的结构时，可以：
 *   import { useAgent } from "yggdrasil";
 * 拿到自己的上下文与派发能力，而不是被宿主的模板限死。
 */
registerModule('yggdrasil', {
  AgentIdContext,
  useAgent,
  isAgentId,
  __esModule: true,
});

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 容器');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

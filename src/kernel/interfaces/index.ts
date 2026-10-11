import { registerCoreInterfaces } from './core';
import { registerNodeInterfaces } from './nodes';
import { registerWindowInterfaces } from './windows';
import { registerBrowserInterfaces } from './browser';
import { registerNetInterfaces } from './net';

let done = false;

/** 装配全部 Agent 接口。新增能力模块只需在这里加一行。 */
export function registerAllInterfaces(): void {
  if (done) return;
  done = true;
  registerCoreInterfaces();
  registerNodeInterfaces();
  registerWindowInterfaces();
  registerBrowserInterfaces();
  registerNetInterfaces();
}

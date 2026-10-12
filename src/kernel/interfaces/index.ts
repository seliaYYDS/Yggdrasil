import { registerCoreInterfaces } from './core';
import { registerNodeInterfaces } from './nodes';
import { registerWindowInterfaces } from './windows';
import { registerBrowserInterfaces } from './browser';
import { registerNetInterfaces } from './net';
import { registerPluginDocsInterface } from '../plugin/runtime';

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
  // 插件文档是常驻接口（没有插件时它会如实说"没装插件"）—— 端点接口由插件自己动态登记。
  registerPluginDocsInterface();
}

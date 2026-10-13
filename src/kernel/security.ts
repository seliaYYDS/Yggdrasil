/**
 * 安全等级：**四档约束的唯一事实来源**。
 *
 * 为什么要有这一层：'隔离'与'约束'是两件事。
 * Worker 隔离（插件 js 工具跑在没有 DOM、没有网络的房间里）是**基础能力**，不随等级开关；
 * 这个文件管的是**在那之上再加多少限制** —— 允许不允许跑代码、密钥给不给看、
 * 一次调用能打几个请求、没签名的包收不收。
 *
 * 表驱动而不是散落各处的 if：等级一变，界面说明、安装检查、执行检查、
 * 提示词里的那句话必须同时变，散着写迟早会对不上。
 */
export type SecurityLevel = 'high' | 'normal' | 'weak' | 'none';

export interface SecurityPolicy {
  level: SecurityLevel;
  /** 界面上显示的名字。 */
  label: string;
  /** 一句话说清这档到底加了什么限制。 */
  summary: string;
  /** 插件自带的 js 工具（tools/*.js）能否执行。 */
  allowPluginTools: boolean;
  /** 没签名的插件能否安装。 */
  requireSignature: boolean;
  /** 插件工具能不能读到字段里的密钥（secret: true）。 */
  exposeSecretsToTools: boolean;
  /** 一次工具调用最多发几次 ctx.fetch（Infinity = 不限）。 */
  fetchPerCall: number;
  /** 单次响应正文最多取多少字符。 */
  responseBytes: number;
  /** 工具日志单条上限。 */
  logChars: number;
}

export const SECURITY_LEVELS: SecurityLevel[] = ['high', 'normal', 'weak', 'none'];

/**
 * 四档的实际差别。
 *
 * 设计取舍：
 * - **high 直接禁用插件 js 工具**，而不是"允许但限制"。
 *   一个没有 DOM、没有网络、密钥不可见的 js 工具还能做的事已经很少了，
 *   但"代码来自别人"这件事本身在高安全下就不该被接受 —— 拒绝要干脆。
 *   声明式端点不受影响：那是数据，不是代码。
 * - **normal（默认）** 允许 js 工具，但给它戴上配额与密钥遮蔽。
 * - **weak / none** 逐步放松配额与签名要求；**它们不会关掉 Worker 隔离**，
 *   因为那不是一个"程度"，而是另一套执行方式（这里根本没有第二条代码路径）。
 *   把这件事说清楚比假装"none = 无沙箱"诚实。
 */
export const SECURITY_POLICIES: Record<SecurityLevel, SecurityPolicy> = {
  high: {
    level: 'high',
    label: '高',
    summary: '只收已签名的插件，插件代码不执行。',
    allowPluginTools: false,
    requireSignature: true,
    exposeSecretsToTools: false,
    fetchPerCall: 0,
    responseBytes: 32 * 1024,
    logChars: 200,
  },
  normal: {
    level: 'normal',
    label: '标准',
    summary: '默认。插件 js 工具可用，但戴配额与遮蔽。',
    allowPluginTools: true,
    requireSignature: false,
    exposeSecretsToTools: false,
    fetchPerCall: 10,
    responseBytes: 64 * 1024,
    logChars: 400,
  },
  weak: {
    level: 'weak',
    label: '宽松',
    summary: '放宽配额，密钥对插件工具可见。',
    allowPluginTools: true,
    requireSignature: false,
    exposeSecretsToTools: true,
    fetchPerCall: 50,
    responseBytes: 256 * 1024,
    logChars: 400,
  },
  none: {
    level: 'none',
    label: '不限制',
    summary: '不追加配额与遮蔽；Worker 隔离仍在。',
    allowPluginTools: true,
    requireSignature: false,
    exposeSecretsToTools: true,
    fetchPerCall: Infinity,
    responseBytes: 2 * 1024 * 1024,
    logChars: 400,
  },
};

export const DEFAULT_SECURITY_LEVEL: SecurityLevel = 'normal';

export function isSecurityLevel(v: unknown): v is SecurityLevel {
  return typeof v === 'string' && (SECURITY_LEVELS as string[]).includes(v);
}

/** 取某一档的策略；认不出来的一律按默认档（配置被手改坏时不要把应用带崩）。 */
export function policyFor(level: unknown): SecurityPolicy {
  return SECURITY_POLICIES[isSecurityLevel(level) ? level : DEFAULT_SECURITY_LEVEL];
}

/**
 * 界面上的说明：**两行** ——一句这档的定位，一行具体差别。
 *
 * 说明曾经摊成五行（js 工具 / 联网配额 / 密钥 / 签名各一行），
 * 面板里读起来像一张表 —— 用户反馈"太长太罗嗦"。具体差别其实四个字段就够，
 * 用「·」压成一行；定位句交给 summary。
 */
export function describePolicy(p: SecurityPolicy): string[] {
  const net =
    p.fetchPerCall === 0 ? '不适用' : p.fetchPerCall === Infinity ? '不限' : '≤' + p.fetchPerCall + ' 次/调用';
  return [
    p.summary,
    (p.allowPluginTools ? 'js 工具 可执行' : 'js 工具 禁止') +
      ' · 联网 ' + net +
      ' · 密钥 ' + (p.exposeSecretsToTools ? '可读' : '不可读') +
      ' · 未签名插件 ' + (p.requireSignature ? '拒装' : '可装'),
  ];
}

# 插件开发指南

插件是对 Yggdrasil 的扩展包。安装并启用后，插件可以向 Agent 提供新的可调用能力，
或对既有的提示词与界面做出声明式改动。

本文是**格式与契约参考**：包结构、清单字段、运行时语义、校验规则、安全模型。
使用者视角的安装与使用说明见 [README](../README.md)。

## 包的形态

一个插件是一个目录，打包后扩展名为 `.graft`（内容为 zip），也可用等价的单文件 `.json`。

    插件目录/
      manifest.json     清单（必需）
      guide.md          给 Agent 看的用法说明（可选，但建议提供）
      tools/*.js        js 工具（可选）
      ui/*.tsx          自带界面（可选）

包内只接受下列路径，其余文件在打包与安装时都会被拒绝：

| 路径 | 说明 |
| --- | --- |
| `manifest.json` | 清单 |
| `guide.md` / `README.md` | 说明文档；`guide.md` 的内容可由 Agent 按需读取 |
| `tools/<name>.js` | js 工具，名字限小写字母开头的 `[a-z0-9_-]`，不超过 30 字符 |
| `ui/<name>.tsx` | 自带界面，命名规则同上 |

## 最小示例

    {
      "id": "my-plugin",
      "name": "我的插件",
      "version": "1.0",
      "description": "查询示例 API 的当前值。",
      "hosts": ["api.example.com"],
      "endpoints": [
        {
          "name": "current",
          "label": "查当前值",
          "description": "Read the current value. Returns { value, unit }.",
          "url": "https://api.example.com/current?city={city}",
          "params": [{ "name": "city", "description": "city name", "required": true }]
        }
      ]
    }

打包与试跑：

    node scripts/build-plugin.mjs my-plugin
    node scripts/try-plugin.mjs my-plugin

产物为 `public/plugins/my-plugin.graft` 与 `public/plugins/my-plugin.json`；安装入口在插件面板。

## 顶层字段

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | ✔ | string | 小写字母开头，仅含 `[a-z0-9-]`，2–31 字符。同时是 op 的前缀 |
| `name` | ✔ | string | 显示名，可含中文 |
| `version` | ✔ | string | `1.0` 或 `1.0.0`。同 `id` 视为升级 |
| `description` | ✔ | string | 一句话说明。会写入提示词，长度直接影响每轮成本 |
| `hosts` | ✔ | string[] | 主机白名单，见「安全模型」 |
| `minAppVersion` | | string | 要求的最低应用版本，高于当前版本时拒绝安装 |
| `author` | | string | 显示用 |
| `fields` | | object[] | 用户可填字段（配置与密钥） |
| `endpoints` | | object[] | 声明式 HTTP 端点，上限 60 |
| `tools` | | object[] | js 工具 |
| `ui` | | object[] | 自带界面，由 Agent 用 `plugin_ui` 摆出 |
| `pages` | | object[] | 默认页面：工具栏按钮 + 常驻窗口 |
| `prompts` | | object[] | 系统提示词改动 |
| `signature` | | object | Ed25519 签名，验签失败时拒绝安装 |
| `update` | | object | 版本更新地址，其主机须在 `hosts` 内 |

未在表中的顶层字段会导致解析失败（用于拦截拼写错误）。

### 内容判据

`endpoints` / `tools` / `prompts` / `pages` 四项中至少需要一项非空，否则拒绝安装。

### 校验与上限

| 项 | 限制 |
| --- | --- |
| 端点数量 | ≤ 60 |
| 提示词补丁文本 | 每条 ≤ 4000 字符 |
| 提示词替换的 `find` / `replace` | 各 ≤ 4000 字符 |
| 页面图标 | ≤ 12 条 path，单条 ≤ 2000 字符 |
| 端点 `maxChars` | 100–200000，默认 8000 |
| 工具 `timeoutMs` | 200–30000，默认 8000 |
| `endpoints[].name`、`tools[].name`、`pages[].id` | 三者之间不可重名 |
| `fields[].key`、`params[].name` | 小写字母开头，`[a-z0-9_]`，≤ 30 字符 |

## fields：用户可填字段

`fields` 声明用户在插件面板里填写的值。端点、工具与 `hosts` 都能引用这些值。

    "fields": [
      { "key": "token", "label": "访问令牌", "secret": true,
        "hint": "在服务商控制台生成；放在请求头里，不会出现在提示词中。" },
      { "key": "base_url", "label": "服务地址", "type": "url",
        "placeholder": "http://localhost:3000", "required": true, "default": "" }
    ]

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | ✔ | 引用名。小写字母开头，`[a-z0-9_]`，≤ 30 字符 |
| `label` | ✔ | 显示名，也是提示词中对该值的称呼 |
| `hint` | | 填写引导，显示在输入框下方 |
| `placeholder` | | 输入框占位文本 |
| `type` | | `"text"`（默认）或 `"url"`。被 `hosts` 以 `{config:key}` 引用的字段必须是 `"url"` |
| `required` | | 为真时不允许留空 |
| `secret` | | 为真时按密码输入框显示，值不写入提示词与日志，导出时排除 |
| `default` | | 初始值，`""` 表示留空 |

## endpoints：声明式 HTTP 端点

端点由宿主发起请求。插件本身不接触网络，也不需要打包请求代码。

### 最小示例

    "endpoints": [
      {
        "name": "search",
        "label": "搜索",
        "description": "Search items by keyword. Returns a list of { title, url }.",
        "url": "https://api.example.com/search?q={query}&limit={limit}",
        "params": [
          { "name": "query", "description": "keyword", "required": true },
          { "name": "limit", "description": "max results", "default": "5" }
        ],
        "pick": ["items[]"],
        "emptyHint": "没有匹配的结果，换一个关键词。"
      }
    ]

### 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✔ | 调用名 `<插件 id>.<name>`。宜与路由末段一致 |
| `label` | ✔ | 显示名 |
| `description` | ✔ | **写给模型看的**：何时调用、返回什么；参数说明放在 `params[].description` |
| `url` | ✔ | 完整 URL，可含 `{param}` 与 `{config:key}`。协议限 http/https |
| `method` | | 默认 `GET`；`POST` 时按 JSON 请求体发送 |
| `params` | | 调用参数：`name`、`description`、`required`、`default` |
| `headers` | | 请求头数组，值为占位符模板 |
| `body` | | `POST` 的请求体对象，可含占位符 |
| `pick` | | 响应截取路径，见下 |
| `emptyHint` | | 截取结果为空时返回给模型的提示 |
| `maxChars` | | 响应截断长度，默认 8000 |
| `cap` | | 安全等级上限，`null` 表示不额外约束 |
| `mutates` | | 声明该端点会改变远端状态 |
| `example` | | 示例参数，用于文档与试跑 |

### 参数与配置的区分

值按生命周期分为两类，这是 `params` 与 `fields` 分工的依据：

| 类别 | 模板写法 | 取值来源 |
| --- | --- | --- |
| 参数 | `{name}` | 模型每次调用时给出 |
| 配置 | `{config:key}` | 用户在插件面板填写 |

每次调用都不同的值（查询词、日期）属于参数；跨多次调用保持不变的（地址、令牌、默认城市）
属于配置。把配置写进 `params` 会使模型每轮都被要求重复提供同一个值。
`{config:key}` 引用的字段必须已在 `fields` 中声明。

### POST

`method: "POST"` 时，`body` 对象序列化为 JSON 发送，`Content-Type: application/json`；
`url` 中的占位符仍按上述规则解析。

### 请求头与可选鉴权

    "headers": [{ "name": "Authorization", "value": "Bearer {token}" }]

请求头值是占位符模板。**引用了未填写字段的请求头整条会被丢弃**，
因此同一个端点既能用于配置齐全的账户，也能在缺少令牌时以匿名方式调用 —— 可选鉴权即由此成立。

密钥宜放在请求头。查询串会进入日志、浏览器历史与中间层缓存，请求头不会。

### pick：截取响应

`pick` 指定响应中保留的部分，用于把宽大的原始响应削成模型真正需要的字段；
未写 `pick` 时，`maxChars` 约束下的原始响应整体交给模型。

| 形式 | 含义 |
| --- | --- |
| `"a.b"` | 取对象属性 |
| `"items[]"` | 取数组全部元素 |
| `"items[0]"` | 取数组单个元素 |

多条路径的结果合并为一个对象返回；路径不存在时该条被忽略。
路径字符集限 `[A-Za-z0-9_\[\].-]`。

### emptyHint

截取结果为空（空数组、空对象、`null`）时返回 `emptyHint` 而非空结果，
用于避免模型把「没有结果」误判为「调用失败」而反复重试。

### 提示词成本

`description`、`params[].description`、`label` 与插件 `description` 都会进入系统提示，每轮都会发送。
端点数量与说明长度直接决定固定成本：36 个端点的实测约为 8.4 KB。
用法细节应放在 `guide.md`，由 Agent 按需读取。

## tools：在隔离环境中执行的工具

工具在 Web Worker 中执行，适合需要循环、变换或解析的场合。宿主不为其提供 DOM 与 Node 接口。

### 最小示例

`manifest.json`：

    "tools": [
      {
        "name": "word_count",
        "label": "统计词频",
        "description": "Count word frequency in the given text. Returns the top entries.",
        "file": "tools/word-count.js",
        "params": [
          { "name": "text", "description": "input text", "required": true },
          { "name": "top", "description": "how many entries", "default": "10" }
        ],
        "example": { "text": "a b a", "top": "2" }
      }
    ]

`tools/word-count.js`：

    export default function run(params, ctx) {
      const counts = new Map();
      for (const w of String(params.text).split(/\s+/).filter(Boolean)) {
        counts.set(w, (counts.get(w) || 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(params.top) || 10);
      return { ok: true, data: top, message: top.length + " 个词" };
    }

### 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✔ | 工具名，与端点、页面不可重名 |
| `label` | ✔ | 显示名 |
| `description` | ✔ | 写给模型看的说明 |
| `file` | ✔ | `tools/<name>.js` |
| `exposeAs` | | `"op"`（默认）注册为 op；`"tool"` 进入工具表，由 `call_tool` 调用 |
| `params` | | 参数声明，字段同 `endpoints[].params` |
| `paramsSchema` | | JSON Schema 对象。`"tool"` 形态下替换由 `params` 推导出的参数结构，用于对象、数组等结构化参数 |
| `cap` | | 安全等级上限，默认 `"net"` |
| `timeoutMs` | | 执行上限，默认 8000 |
| `mutates` | | 声明该工具会改变远端状态 |
| `example` | | 示例参数，用于文档与试跑 |

### 入口与返回值

模块默认导出一个函数，签名为 `(params, ctx) => result`。返回值的可识别字段：

| 字段 | 说明 |
| --- | --- |
| `ok` | 布尔。为假时该次调用记为失败 |
| `message` | 一行摘要，写入轨迹 |
| `data` | 交给模型的观察数据，序列化为 JSON |
| `observation` | 需要原样输出的文本，优先于 `data` |

返回 `undefined`、抛异常或超时都会记为失败，错误文本进入轨迹，不中断会话。

### ctx

| 成员 | 说明 |
| --- | --- |
| `ctx.fetch(url, init)` | 发起网络请求。受 `hosts` 白名单与安全等级约束，由宿主代理执行 |
| `ctx.field(key)` | 读取用户填写的字段值 |
| `ctx.pluginId` | 当前插件 id |

Worker 中不存在 `window`、`document`、`localStorage` 与 Node 内置模块。
`ctx.fetch` 的目标主机不在白名单内时调用失败，失败原因写入轨迹。

### 取舍

同样的能力既能写成端点也能写成工具。端点为声明式，请求不经插件代码，可在安装前完整审阅；
工具为命令式，适合端点无法表达的变换。需要网络访问时宜优先选择端点。

## prompts：改动系统提示词

`prompts` 以声明方式修改系统提示词。改动在**每一轮拼接提示词时**应用，
因此停用插件会立即生效，无需重启；卸载则完全还原。

### 最小示例

    "prompts": [
      { "op": "insert", "anchor": "output-format", "position": "before",
        "label": "输出从简", "text": "## Keep it short\nKeep the reasoning field to one sentence." },
      { "op": "substitute", "find": "Yggdrasil", "replace": "小喵" },
      { "op": "remove", "section": "browser-rules" }
    ]

### 操作

| `op` | 必需字段 | 语义 |
| --- | --- | --- |
| `insert` | `anchor`、`text`（可选 `position`：`"before"` / `"after"`） | 在锚点段之前或之后插入一段 |
| `replace` | `section`、`text` | 整段替换 |
| `remove` | `section` | 整段删除 |
| `substitute` | `find`、`replace` | 在整份提示词中逐字替换 |

`anchor` / `section` 取提示词段落 id，完整清单见 `src/kernel/agent/prompts.ts` 的 `PROMPT_SECTIONS`
（`identity`、`role`、`operations`、`output-format`、`window-rules` 等）；
另有 `start` 与 `end` 两个虚拟锚点，分别表示整份提示词的首尾。

`substitute` 的 `find` 按字面量匹配，不解析正则；`replace` 取空串表示删除匹配文本。

### 受保护段落

`identity`、`operations`、`output-format` 三段不可 `replace` 或 `remove`；
这三段定义 Agent 的身份、可调用操作与输出契约，缺失会导致会话无法继续。
对它们施加的 `replace` / `remove` 会被忽略，在其相邻位置 `insert` 不受限制。
需要修改其中的个别词（例如身份名）时使用 `substitute`。

### 应用顺序

顺序为 `remove` → `replace` → `insert` → `substitute`。

- `substitute` 位于最后，其替换对象包含同批 `insert` 写入的文本：
  插件自身插入的说明文字中出现待替换字面量时同样会被替换。
- 多个插件的插入按**插件安装顺序、插件内声明顺序**排列，顺序稳定。
  系统提示词是模型侧的缓存前缀，顺序变化会使缓存失效。

锚点或段落 id 无法识别时该条补丁被忽略，不影响其余补丁，也不影响提示词其余部分；
此行为用于让插件在新旧版本应用上都能加载。

### 审阅

安装确认逐条列出补丁：改动位置与文本前若干字符。`substitute` 单独列出，
并注明其作用范围覆盖整份提示词，包括输出契约；版本升级时，新增或变更的补丁在差异中单独列出。

## pages：默认页面

一个 `pages` 条目对应工具栏上的一个按钮与一个常驻窗口。窗口可拖动、可最小化，位置会被记住。

### 最小示例

    "pages": [
      {
        "id": "clock",
        "label": "时钟",
        "description": "一个走着的时钟",
        "file": "ui/clock-page.tsx",
        "icon": ["M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20", "M12 7v5l3 2"]
      }
    ]

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✔ | 页面 id，与端点名、工具名不可重名 |
| `label` | ✔ | 窗口标题，也是按钮的提示文本 |
| `file` | ✔ | `ui/<name>.tsx` |
| `description` | | 按钮的悬浮说明 |
| `open` | | 初始开合建议，默认关 |
| `rect` | | 初始位置与尺寸 `{ x, y, w, h }`；用户拖动后以其位置为准 |
| `data` | | 静态数据，注入方式见下 |
| `icon` | | 按钮图标，见下 |

### 按钮

按钮只显示图标，页面名放在悬浮说明中，与工具栏其余按钮一致。
同一插件的多个页面在工具栏中相邻成组，组间留有间距，顺序为插件安装顺序。
按钮的点击行为为「打开或置于最前」，关闭窗口使用窗口自身的关闭控件。

### icon

`icon` 取 SVG path 的 `d`，一条字符串或字符串数组，坐标系统为 24×24；上限 12 条、单条 2000 字符。
只接受 path 的三个原因：

1. path 是纯数据，可按白名单校验（仅允许路径命令、数字与分隔符），标记符号与引号无法通过；
2. 描边宽度、颜色、圆角与尺寸由宿主统一设置，图标与内置图标观感一致；
3. 省略 `icon` 时使用通用图标，既有插件不受影响。

图标以 `<path d>` 渲染，不经过 HTML 解析。

### data 注入

`data` 以模块顶层常量 `data` 的形式置于源码之前，与 `ui` 条目相同：

    const data = {"title": "..."};
    // 插件源码

页面运行在主页面环境中，可 `import react` 与 `import "yggdrasil"`，也可直接使用 `localStorage`。
这一点与 `tools/*.js` 相反：工具在 Worker 沙箱内执行，页面不在沙箱内。
需要隔离执行或网络代理的场合应使用 `tools`。

## ui：自带界面

`ui` 声明的界面由 Agent 通过 `plugin_ui` 摆放到桌面上。

    "ui": [
      {
        "name": "repo_card",
        "label": "仓库卡片",
        "description": "显示一个仓库的概览：名称、星标数、最近一次提交时间。",
        "file": "ui/repo-card.tsx",
        "dataDoc": "data: { owner, repo }",
        "example": { "owner": "facebook", "repo": "react" }
      }
    ]

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✔ | Agent 调用 `plugin_ui` 时使用的名字 |
| `label` | ✔ | 显示名 |
| `description` | ✔ | 说明何时适合摆放，模型据此决定是否使用 |
| `file` | ✔ | `ui/<name>.tsx` |
| `dataDoc` | | 对 `data` 结构的说明，随界面一同提供给模型 |
| `example` | | 示例 `data`，用于文档与试跑 |

### 源码契约

`ui/*.tsx` 默认导出一个 React 函数组件，可按需引入以下模块：

| 模块 | 可用内容 |
| --- | --- |
| `react` | 完整 React 接口 |
| `yggdrasil` | `AgentIdContext`、`useAgent`、`isAgentId` |

组件不接收 props。渲染时需要的静态数据通过 `const data = {...}` 顶层常量读取。

### 与 pages 的区别

| | `ui` | `pages` |
| --- | --- | --- |
| 出现方式 | Agent 调用 `plugin_ui` 摆放 | 用户点击工具栏按钮 |
| `data` 来源 | 每次由 Agent 传入 | 清单中的静态声明 |
| 窗口 | 锁定，不可编辑 | 常规窗口，可拖动、可最小化 |
| 适用 | 内容由 Agent 逐次决定 | 为界面增加一个常驻页面 |

两者使用同一套源码契约与同一套 data 注入机制。

## guide.md

`guide.md` 是插件最值得投入的部分。插件在系统提示词中只占一行，
`guide.md` 由 Agent 在准备使用该插件时通过 `plugin_docs` 按需读取。

适用内容：模型无法自行推断的领域知识，例如枚举值对照表、单位、分段标识。

    天气代码（WMO）对照表：
    0 晴 / 1 多云 / 2 阴 / 45 雾 / 51 小雨 / 61 中雨 / 71 小雪 / 95 雷暴

不适用内容：可被 `description` 覆盖的重复说明。

## Agent 侧可见内容

| 内容 | 出现位置 | 时机 |
| --- | --- | --- |
| 插件名与 `description` | 系统提示词的插件段 | 每轮 |
| 端点名、`label`、`description`、参数说明 | 系统提示词的可用操作列表 | 每轮 |
| `tools` 中 `exposeAs: "tool"` 的项 | 工具表 | 每轮 |
| `guide.md` | 通过 `plugin_docs` 返回 | 按需 |
| 端点与工具的返回数据 | 观察结果 | 调用后 |

系统提示词是模型侧的缓存前缀，上述每轮内容越多，固定成本越高。
因此细节由 `guide.md` 承担，`description` 只保留「何时使用、返回什么」。

两种可调用形态：

- **操作**：`endpoints` 与 `tools` 中 `exposeAs: "op"` 的项，在可用操作列表中直接列出，
  调用格式为 `<插件 id>.<name>`。
- **工具**：`tools` 中 `exposeAs: "tool"` 的项，位于工具表中，通过 `call_tool` 调用；
  参数值可以是对象与数组，无需自行序列化。

## 安全模型

### 主机白名单

`hosts` 是主机白名单，列出插件允许访问的主机。条目有两种形式：

| 形式 | 含义 |
| --- | --- |
| `"api.example.com"` | 固定主机 |
| `"{config:base_url}"` | 由用户填写的字段提供主机；该字段必须是 `type: "url"` |

清单中 `url`、`update.url` 与工具内 `ctx.fetch` 的目标主机都必须落在白名单内，否则安装时被拒绝；
跨主机重定向同样受限。不发网络请求的插件（全部 `cap: null`）可将 `hosts` 声明为空数组。

### 字段与密钥

字段值保存在浏览器本地存储中。`secret` 项按密码输入框显示，其值不写入提示词、不写入日志，
导出场景时排除。密钥只存在本地，不会随插件包或场景文件外传。

### js 工具的隔离

`tools/*.js` 在 Web Worker 中执行，具备以下限制：

- 无 `window`、`document`、`localStorage`，无 Node 内置模块；
- 网络访问只能经由 `ctx.fetch`，受 `hosts` 白名单约束；
- 有执行时限，超时记为失败；
- 返回值为纯数据，序列化后交给模型。

`ui/*.tsx` 与 `pages[].file` 不在此沙箱内，运行在主页面环境中，适用于展示与交互。

### 安全等级

设置项「安全等级」为高 / 标准 / 宽松 / 不限制，默认标准。它在上述隔离之上追加约束：
能否执行 js 工具、单次调用可发起的请求数、插件可否读取 `secret` 字段、是否接受未签名的包。
端点与工具可用 `cap` 声明所需的最低等级，等级不足时该能力不可用。
四档的逐条差异由设置面板与应用运行时读取同一份声明。

### 插件可改动的范围

插件对提示词的改动限定为 `prompts` 声明的四种操作；
`identity`、`operations`、`output-format` 不可整段删除或替换。
插件不执行任意宿主代码，不能注册新的 op 类型，也不能修改运行时函数。

## 打包、签名与版本

    node scripts/build-plugin.mjs <插件目录> [更多目录…]

输出 `public/plugins/<id>.graft` 与 `public/plugins/<id>.json`。
打包会校验清单、检查端点参数与 `url` 占位符是否对应，并核对工具文件是否存在。

### 签名

清单可附带 Ed25519 签名，用于校验包在发布后未被修改；验签失败时拒绝安装。
未签名的包在标准等级下可安装，在「高」等级下被拒绝。

### 修改已签名的插件

修改内容后原签名失效。开发期间可移除 `signature` 字段后重新打包；对外发布时应重新签名。

### 版本更新

`update` 声明更新检查地址，其主机须在 `hosts` 内。同 `id` 的不同 `version` 视为升级。
升级时插件面板会显示权限差异：新增的主机、端点、提示词补丁与页面分别列出。

## 测试

### 命令行试跑

    node scripts/try-plugin.mjs <插件目录>
    node scripts/try-plugin.mjs <插件目录> --query=北京 --limit=3

该命令加载插件、列出其提供的能力，并以给定参数调用带 `example` 的操作或工具，打印返回值。
参数以 `--key=value` 传递。

### 安装后验证

| 检查项 | 预期 |
| --- | --- |
| 可用操作列表 | 每个端点各一项 |
| 工具表 | `exposeAs: "tool"` 的项各一条 |
| 工具栏 | 每个 `pages` 条目一个按钮 |
| 提示词改动 | 安装确认中逐条列出 |
| 停用插件 | 上述各项立即消失 |

### 发布前检查跨域

端点由宿主页面发起请求，因此目标服务需要返回 `access-control-allow-origin`。

    curl -i -H "Origin: http://127.0.0.1:19387" "https://api.example.com/current"

应检查响应中的 `access-control-allow-origin`。不使用 `Origin` 请求头时该响应头不会出现，
因此仅凭不带 `Origin` 的请求无法判断浏览器端能否读取。

## 排错

| 提示 | 原因 |
| --- | --- |
| `不认识的字段 …` | 清单中有未支持的顶层字段，通常为拼写错误 |
| 至少要有一个 endpoint / tools / prompts / pages | 四类内容全部为空 |
| hosts 里没有 … | `url` 或 `update.url` 的主机未列入 `hosts` |
| 占位符 {…} 没有对应的参数或字段 | `url` 中的占位符在 `params` 与 `fields` 中都找不到 |
| 包里有不允许的文件 | 存在 `manifest.json`、`guide.md`、`tools/*.js`、`ui/*.tsx` 之外的路径 |
| 找不到 ui/xxx.tsx | `file` 指向的路径不在包内 |
| 签名校验失败 | 内容修改后未重新签名 |
| 该能力需要更高的安全等级 | 端点或工具的 `cap` 高于当前设置 |

## 提交前自查

- [ ] `id` 与所有 `name`、`key`、`pages[].id` 符合命名规则，且端点 / 工具 / 页面之间无重名
- [ ] `hosts` 覆盖 `url`、`update.url` 与工具中 `ctx.fetch` 的全部目标主机
- [ ] 每个 `description` 说明「何时调用、返回什么」，细节在 `guide.md`
- [ ] `params` 与 `fields` 分工正确：每次调用变化的值属于 `params`
- [ ] `pick` 已将响应收敛到模型需要的字段
- [ ] 无结果的分支提供了 `emptyHint`
- [ ] `example` 可被 `try-plugin.mjs` 直接跑通
- [ ] 目标服务对带 `Origin` 的请求返回 `access-control-allow-origin`
- [ ] 提示词补丁未 `replace` 或 `remove` 受保护段落
- [ ] 插件自身插入的文本中不含该插件 `substitute` 的目标字面量

## 示例插件

| 目录 | 内容 |
| --- | --- |
| `plugins/weather` | 端点能力的最小实例：两个端点 + `pick`，指南中带 WMO 代码表 |
| `plugins/music-search` | 搜索类端点，返回可直接使用的媒体直链 |
| `plugins/currency` | 三个端点，全部无需密钥 |
| `plugins/github` | 可选鉴权：未填 Token 时降级为匿名只读 |
| `plugins/netease-music` | 自建服务：主机由 `{config:base_url}` 提供 |
| `plugins/status-board` | 端点 + js 工具 + `ui` 三种形态并存 |
| `plugins/status-board-1.1` | 与上者同 id、更高版本，用于验证升级差异 |
| `plugins/toolbox` | 八个 `exposeAs: "tool"` 的工具，无网络访问 |
| `plugins/clock` | 页面能力的最小实例：仅一个 `pages` 条目 |
| `plugins/brief` | 提示词补丁与一个用于查看改动的页面 |
| `plugins/nya` | 提示词能力的最小实例：`substitute` 改名与 `insert` 口吻要求 |

## 尚未实现

- 插件的第三方分发与更新源签名链
- `ui/*.tsx` 与 `pages[].file` 的样式隔离：两者运行在主页面环境中，可读取全局样式
- 端点响应的字段级类型校验

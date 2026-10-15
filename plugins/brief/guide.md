# brief

一个演示**"插件改动核心"**这一能力的插件。它做两件事：

1. **改 Agent 的系统提示词** —— 在 `output-format` 之前插一段"输出从简"的要求；
2. **给界面加一个页面与按钮** —— 工具栏上多一个「改动一览」，点开是一个常驻窗口，
   里面列出这个插件到底改了什么（可展开看原文）。

## 为什么这个例子是"审查页"而不是别的

提示词补丁会**直接改变 Agent 的行为**。安装确认里已经列过一次，但那是一次性的；
插件长期装着，改动却是长期的 —— 所以给一个随时可查的地方，是这类能力本来就该配的东西。

## 清单里对应的两段

    "prompts": [
      { "op": "insert", "anchor": "output-format", "position": "before",
        "label": "输出从简", "text": "## Keep it short\n..." }
    ],
    "pages": [
      { "id": "audit", "label": "改动一览", "file": "ui/brief-page.tsx",
        "data": { "title": "...", "patches": [ ... ] } }
    ]

两点值得注意：

- `anchor` / `section` 用的是**段落 id**（见 src/kernel/agent/prompts.ts 的 PROMPT_SECTIONS）。
  最稳的用法是把东西插在 `output-format` 之前 —— 那一段之后是输出契约，不该被挤走。
- `identity` / `operations` / `output-format` **不允许** replace 或 remove：
  删掉它们 Agent 就不知道该说什么、能调什么了。这是"**一定程度**更改核心代码"的界线。
  想影响它们就在附近 insert。

## 想看卸掉之后的样子

在插件面板里关掉它（不要卸载）：工具栏按钮立刻消失、提示词补丁立刻不再生效 ——
补丁是在**每轮拼提示词时**现读的，所以开关是即时的，不需要重启。

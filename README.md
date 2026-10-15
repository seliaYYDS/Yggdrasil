<p align="center"><img src="public/yggdrasil-180.png" width="120" alt="Yggdrasil"></p>

# Yggdrasil

用自然语言生成界面的桌面。输入一句话，模型生成可拖动的窗口与组件，每个界面元素都是窗口。

## 运行

```bash
pnpm install
pnpm dev
```

构建与预览：

```bash
pnpm build      # tsc --noEmit && vite build
pnpm preview
```

首次使用点输入窗口标题栏的 `⚙`，填写 OpenAI 兼容端点的 Base / Key / Model。配置只存在浏览器本地。

## 用法

| 操作 | 说明 |
| --- | --- |
| 提交任务 | 输入框内 `Enter` 提交，`Shift + Enter` 换行 |
| 移动 / 缩放窗口 | 拖标题栏移动，拖右下角缩放 |
| 最小化 | 收进左下角任务栏，点击恢复 |
| 挂件 | 无标题栏、背景透明；鼠标悬停时右下角出现移动 / 缩放 / 关闭按钮 |
| 多个输入框 | 每个输入框是一个独立会话，最多 6 个 |
| 导出 / 导入场景 | 左上角两个按钮，产出 `.seed` 文件 |
| 上传文件 | 拖入输入框窗口或直接粘贴；发送时存入 Agent 的工作区，提示词里只列文件名 |

窗口的位置与大小会保存，刷新后保持原样。

## 能做什么

- 生成窗口与组件：图表、列表、日历、看板、时钟等
- 联网抓取网页与图片
- 读图（需要支持视觉的模型）
- 打开并控制真实浏览器窗口
- 查看与调整默认窗口：面板、输入框、窗口外观
- 计算与文本处理

## 插件

插件（`.graft`）可向 Agent 增加操作与工具，或对提示词与界面做声明式改动。
完整的清单格式与安全模型见 [docs/plugins.md](docs/plugins.md)。

仓库自带示例，产物在 `public/plugins/`，可直接在插件面板里安装：

| 文件 | 内容 |
| --- | --- |
| `weather.graft` | 天气查询（无需密钥） |
| `netease-music.graft` | 网易云音乐（需填自建服务地址） |
| `github.graft` | GitHub 查询与建 issue（Token 可选） |
| `toolbox.graft` | 八个计算类工具（不联网） |
| `nya.graft` | 修改 Agent 名称与说话风格（纯提示词） |

```bash
pnpm plugin:build weather      # 打包
pnpm plugin:try weather        # 命令行试跑
pnpm plugin:sign               # 签名
```

## 设置

- **入口**：Base / Key / Model，支持常用服务商预设
- **安全等级**：高 / 标准 / 宽松 / 不限制（默认标准）
- **生成参数**：上下文窗口、压缩阈值、最大输出、Temperature
- **精简模式**：减少每轮发给模型的说明文字
- **成人模式**：调整内容策略
- **图片中转**：可选的图片代理地址

## 目录

    src/kernel/    模型调用与操作执行
    src/host/      窗口渲染与组件编译
    src/ui/        界面组件
    src/store/     状态与持久化
    src/styles/    样式
    plugins/       插件源码
    scripts/       打包 / 试跑 / 签名脚本
    docs/          文档
    public/        静态资源与插件产物

## 开发

```bash
pnpm typecheck
```

密钥只存在浏览器本地，不经过任何后端；模型请求由浏览器直接发往所填端点。

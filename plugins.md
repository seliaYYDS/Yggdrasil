# 插件开发指南

插件给 Agent 增加新的**操作**（op）。一个插件就是一个目录：一份清单 + 一份给模型看的指南。

装好并启用之后：

- 清单里的每个端点会变成 Agent 的一个 op（kind 是 `<插件id>.<端点名>`）；
- 提示词里只出现**一行**（插件名 + 它提供哪些操作），用法由 Agent 调 `plugin_docs` 按需读；
- 端点只能访问清单里声明过的主机（`hosts`），**执行时会再查一次**。

> 这一版**只支持声明式 HTTP 端点**，插件不能带自己的 js 代码。
> 原因见下面「安全与权限」一节 —— 那不是偷懒，是隔离还没做。

---

## 一分钟跑通

目录（仓库里的 `plugins/` 下）：

    plugins/my-plugin/
      manifest.json    清单
      guide.md         给 Agent 看的用法

最小可用的 `manifest.json`：

    {
      "id": "my-plugin",
      "name": "我的插件",
      "version": "1.0",
      "description": "一句话说明它是干什么的。",
      "hosts": ["api.example.com"],
      "endpoints": [
        {
          "name": "hello",
          "label": "打个招呼",
          "description": "Say hello. Give name; returns greeting.",
          "url": "https://api.example.com/hello?name={name}",
          "params": [
            { "name": "name", "description": "who to greet", "required": true }
          ]
        }
      ]
    }

打包并安装：

    node scripts/build-plugin.mjs my-plugin

产出 `public/plugins/my-plugin.graft`（zip）与 `.json`（单文件）。打开应用 → 拼图图标 →
「安装插件…」→ 选那个 `.graft` → 确认安装。

---

## manifest.json

### 顶层字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✔ | 小写字母开头，只含小写字母/数字/连字符，2 到 31 字符。它同时是 op 的前缀，改名等于换一个插件 |
| `name` | ✔ | 显示名（可以中文） |
| `version` | ✔ | `1.0` 或 `1.0.0`。升级靠它（同 `id` 视为升级） |
| `description` | ✔ | 一句话。**会写进提示词**，所以要短、要准 |
| `minAppVersion` | | 需要的最低应用版本；比当前版本高就拒绝安装 |
| `author` | | 显示用 |
| `hosts` | ✔ | 允许访问的主机白名单，至少一个 |
| `fields` | | 用户可以填的字段（密钥或配置） |
| `endpoints` | ✔ | 至少一个，最多 20 个 |

**不认识的顶层字段会被拒绝**（防拼错）。`format` 只出现在单文件形态的顶层，不在 manifest 里。

### fields：用户可以填的字段

    "fields": [
      {
        "key": "api_key",
        "label": "API Key",
        "hint": "去 xxx.com/settings 申请。",
        "placeholder": "sk-...",
        "secret": true,
        "default": ""
      }
    ]

- `secret: true` → 界面上是密码框。
- 值只存在**本地**：**不进提示词，不进日志，不进场景文件（.seed）**。
- 在 `url` 与 `headers` 里用 `{config:key}` 引用它。
- 升级时**保留用户已填的值**，卸载才丢。

### endpoints

    {
      "name": "search",
      "label": "搜索歌曲",
      "description": "Search the catalogue. Give term; returns trackName, artistName, previewUrl.",
      "method": "GET",
      "url": "https://api.example.com/search?term={term}&limit={limit}&market={config:market}",
      "params": [
        { "name": "term", "description": "what to search for", "required": true },
        { "name": "limit", "description": "how many hits (1-25)", "default": "5" }
      ],
      "pick": ["resultCount", "results[].trackName", "results[].previewUrl"],
      "emptyHint": "resultCount is 0: nothing matched. Try another market before giving up.",
      "maxChars": 12000,
      "cap": "net",
      "example": { "kind": "my-plugin.search", "term": "稻香" }
    }

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `name` | 必填 | 小写字母开头，可含小写字母/数字/下划线/连字符 |
| `label` | 必填 | 一行摘要，进度面板里显示 |
| `description` | 必填 | **写进提示词**：干什么、参数怎么给、返回里哪些字段有用 |
| `method` | `GET` | 只支持 `GET` / `POST` |
| `url` | 必填 | 地址模板，见下 |
| `params` | | 模型可以给的参数 |
| `headers` | | 附加请求头，值可以写 `{config:key}`（**不做 URL 编码**，适合 `Authorization`） |
| `pick` | | 只挑要用的字段，见下 |
| `emptyHint` | | 返回空结果时追加给模型的一句提示，见下 |
| `maxChars` | `8000` | 回读长度上限，100 到 200000 |
| `cap` | `net` | 需要哪个能力开关；`null` 表示基础能力（任何 Agent 都能用） |
| `mutates` | `false` | 会不会改到外部数据，只影响反馈措辞 |
| `example` | | 给模型照抄的示例 op；不写会按参数自动生成一个 |

#### url 模板

两个占位符：

- `{参数名}` → 模型给的参数值（或用 `default`）；
- `{config:字段名}` → 用户填的字段值。

**两者都会被 URL 编码**（中文、空格、`&` 都安全）。地址来自清单，**模型碰不到** ——
模型只能给声明过的参数值，所以它没法把你的插件当跳板去打别的地方。

模板里出现的每个 `{...}` 都必须声明过（在 `params` 或 `fields` 里），否则拒绝安装。

#### ★ 参数还是配置？这不是风格问题

这是实测踩过的坑，值得单独说：

> 一个插件把「市场」做成了**用户配置字段**。某次搜索返回 0 条，模型推断「可能是市场问题」，
> 但它**改不了配置字段** —— 于是只能瞎猜"是不是拼错了"，最后放弃。

分界线很简单：

| 这个值 | 放哪 | 例子 |
| --- | --- | --- |
| **会改变结果，且模型需要自己调整** | `params`（可覆盖） | 市场、页数、排序、时间范围 |
| **用户的个人偏好，模型不该动** | `fields` + `{config:}` | 温度单位、界面语言、是否显示封面 |

而且：**`{config:x}` 优先取同名参数**。所以如果一个字段既想有默认偏好、又想让模型临时覆盖，
就把它声明成配置字段，**同时**在 `params` 里加一个同名参数（说明书里写明"留空就用你在面板里设的值"）。

已验证的两个例子：

- `music-search` 的 `market`：配置字段 + 同名参数 → 模型能自己换市场重试；
- `weather` 的 `temperature_unit`：**只有**配置字段，没有同名参数 → 模型改不了，只能照着返回里的单位渲染。

#### method 与 POST

`POST` 会把参数序列化成 JSON 请求体（`content-type: application/json`，可在 `headers` 里覆盖）。

⚠ `POST` + `application/json` 会触发**跨域预检**（浏览器先发 `OPTIONS`）。
很多 API 只对 GET 配了 CORS，`OPTIONS` 返回 404 —— 那种情况下 POST 在浏览器里**注定失败**。
写插件前先用带 `Origin` 的请求确认一下（见「排错」里那条）。

#### ★ pick：把响应削成模型真正要用的部分

不写 `pick` 就是把整个响应正文塞进上下文。一次搜索的原始 JSON 动辄十几 KB，
而截断又会切出**坏 JSON**，模型没法解析。所以：

    "pick": ["resultCount", "results[].trackName", "results[].previewUrl"]

- 点路径，数组段末尾加 `[]`（表示"数组里每一项的…"）；
- **每个数组最多取 10 项**；
- 结果是按路径做键的小 JSON 对象；
- 解析不了 JSON（比如返回 HTML）就退回原始正文；
- **建议把总数之类的字段也挑上**（例如 `resultCount`）：只挑字段之后，
  「真的 0 条」和「我字段名挑错了」在回读里长得一模一样。

#### emptyHint：空了要说什么，由插件自己写

当挑出来的结果里 `resultCount` 是 0（或所有挑出来的值都是空数组）时，这句会追加到回读里。

写它的时候问自己：**模型看到"空"之后，最该做的下一步是什么？** 例如：

- 换个市场再试（并列出可用的市场）；
- 换个写法（本名/罗马音，去掉地区后缀）；
- 明确"两次尝试就是预算，之后告诉用户没找到"。

一句"没有结果"是废话；一句"换成 TW 再试，再空就明说"才是模型能照着做的动作。

---

## guide.md：插件最值钱的部分

`description` 是"这个工具干什么"，`guide.md` 是"**用它干活的方法**"。它**不进提示词**，
只在 Agent 调 `plugin_docs("<id>")` 时按需返回 —— 所以可以写得详细，别怕长。

**语言**：`description` 与 `guide.md` 都是**给模型看的，用英文**。
插件自己界面上要显示的中文可以在指南里以对照表的形式给出（见下）。

指南里最该有的四样东西：

1. **工作流**：从用户的一句话到具体调用顺序。例如
   「找城市 → 取天气 → 用 create_component 做窗口」。
2. **★ 模型不可能知道的知识**。这是插件区别于"再多一个接口"的地方：
   - `weather` 里那张 **WMO 天气代码中英对照表**（51 是毛毛雨、95 是雷阵雨）——
     模型没法凭空知道，而用户要看的正是这几个字；
   - `music-search` 里的「`previewUrl` 是 30 秒试听、可能为空」、
     「把 `100x100` 换成 `300x300` 拿更清晰的封面」。
3. **这套数据里容易踩的坑**：同名城市有三个、单位要从返回里读、坐标不能编。
4. **失败时该说什么**：哪一步失败了要如实报告，不要拿记忆里的数据冒充实时结果。

反面教材（别这么写）：「调用 search 端点搜索歌曲。」——
这句话 `description` 里已经有了，等于什么都没说。

---

## 安全与权限

- **主机白名单是墙，不是建议**。校验清单时查一次，**执行时再查一次**
  （清单是数据，数据可能被改）。不在名单里的主机直接拒绝，请求根本不会发出去。
- **密钥只存在本地**：不进提示词、不进日志、不进 `.seed`。指南里也**不要**把密钥写成示例值。
- **包里只允许三个文件**：`manifest.json` / `guide.md` / `README.md`。
  多出任何文件都会被拒绝 —— 包括将来才支持的 js。
- **路径与体积都有硬限制**：条目名不允许 `..` 或绝对路径，单文件不超过 1 MB，
  总量不超过 4 MB，最多 64 个条目。
- **压缩方式**：规范是**不压缩（stored）**，所以读包不依赖任何浏览器特性，任何解压工具也能打开；
  `deflate` 作为兼容也支持（用 Python/系统 zip 打的包能读）。
  自己打包请用 `node scripts/build-plugin.mjs`，它是确定性的（同样的源码打出同样的字节）。
- **为什么没有 js**：任意 js 会跑在主页面里，能读到设置里的 API Key 与全部场景数据、
  再发到任何地方。要开这个口子，必须先把插件代码关进 Worker（无 DOM、无存储）
  并且按插件卡住网络出口。那是一件独立的事，不是顺手能加的。

---

## 打包、安装、升级

    node scripts/build-plugin.mjs            # 打包 plugins/ 下全部
    node scripts/build-plugin.mjs my-plugin  # 只打一个

产出两份**同一个包**的不同包装：

| 文件 | 形态 | 适合 |
| --- | --- | --- |
| `<id>.graft` | zip（stored） | 作者交付、有资源、多文件 |
| `<id>.json` | 单文件 JSON | 小插件、要粘贴给别人、要在对话里 diff |

安装流程（面板里的实际步骤）：

1. 解析包 —— **只读清单，不执行任何东西**；
2. 把清单摊开给你看：可访问的主机、提供的操作、需要填的密钥；
3. 你点「安装」之后才生效。

**生命周期语义**：

- **开关**：关掉只是让 Agent 看不到它（接口被撤掉），插件与用户填的值都还在；
- **升级**（同 `id` 换版本）：**保留用户填的值与开关状态** ——
  升级不该让人重填一次密钥，也不该把禁用中的插件偷偷打开；
- **卸载**：撤掉接口、清掉记录。插件**不是**场景的一部分，
  所以 `.seed` 里不含插件，导入别人的场景也不会动你已装的插件与密钥。

---

## Agent 那边看到什么

理解这一层能帮你把描述写对：

1. **接口目录**里会有它：

       N. my-plugin.search —— [我的插件] Search the catalogue. Give term; returns ...

   其中 `[我的插件]` 是自动加的前缀，后面的 `description` 是你写的。
2. **示例**也会进提示词（你写的 `example`，或按参数自动生成的），模型照着抄字段名。
3. **快照里每个插件一行**：

       - 我的插件 (id "my-plugin" v1.0): 一句话说明...
         operations: my-plugin.search
         read its guide with plugin_docs("my-plugin") before using it.

4. **调用之后**，模型拿到的回读长这样：

       HTTP 200 from api.example.com：
       { "resultCount": 3, "results[].trackName": ["...", "..."] }
       (picked fields; the full response was 18432 chars)

5. **能力开关**：`cap` 决定谁看得见这个端点。没开 `net` 的 Agent
   在接口目录里根本看不到它，调用也会被拒。

---

## 排错

| 报错 | 原因 | 怎么改 |
| --- | --- | --- |
| `不认识的字段 xxx` | manifest 里有拼错的顶层字段 | 只留文档里列出的字段（名字大小写也必须对） |
| `id 要小写字母开头…` | id 用了大写或下划线 | 小写字母/数字/连字符 |
| `version 要像 1.0 或 1.0.0` | 版本写成 `v1` | 纯数字加点 |
| `缺少 hosts 白名单` | 没写 hosts | 把要访问的主机写全 |
| `endpoint xxx 请求 api.y.com，但它不在 hosts 白名单里` | hosts 与实际地址不一致 | 补进 hosts（这是防止插件偷跑的设计，不是找麻烦） |
| `endpoint xxx 的 url 里用了 {q}，但 params 里没有它` | 模板占位符没声明 | 加进 params，或改掉模板 |
| `endpoint xxx 用了 {config:key}，但没有声明这个字段` | 引用了不存在的字段 | 在 fields 里声明 |
| `包里不允许有 xxx` | 包里塞了别的文件 | 只放 manifest.json / guide.md / README.md |
| `不允许的路径` / `非法文件名` | 条目名里有 `..` 或绝对路径 | 打包时不要带目录前缀 |
| `太大` / `条目太多` | 超过 1 MB / 4 MB / 64 条 | 精简包内容 |
| `这个 .graft 不是 zip 包` | 文件被改坏，或其实是 json 改了后缀 | 重新打包；解析也不认后缀，认的是内容 |
| `读包失败… 不支持的压缩方式` | 用了 stored/deflate 以外的压缩 | 重新用 `scripts/build-plugin.mjs` 打包 |
| 回读里 `Calling api.x.com failed: Failed to fetch` | 浏览器把跨域请求拦了（主机没允许页面读取） | 在带 `Origin` 的请求上确认该主机返回 `access-control-allow-origin`；没有就只能换 API |
| 回读里 `HTTP 403 / 429` | 对方拒绝或限流 | 如实报给用户，别在循环里重试 |
| `缺少参数 term` | 模型没给必填参数 | 在 `description` 里把参数说明写清楚；考虑给 `default` |
| 结果永远为空 | 服务端那片目录/市场没东西，或参数值不对 | 把它做成**可覆盖参数**，并写 `emptyHint` 告诉模型下一步 |

**发布前一定做的两件事**（这两条能挡住绝大多数"装了却不能用"）：

1. 用带 `Origin` 头的请求（或直接在浏览器控制台里 fetch）确认目标主机允许页面读取：

       fetch('https://api.example.com/x', { headers: { accept: 'application/json' } })
         .then(r => console.log(r.headers.get('access-control-allow-origin')))

   拿到 `*` 或你自己的来源才算过。**注意：不带 `Origin` 的请求看不到这个头** ——
   用 Node 或 curl 测得"没有 CORS 头"经常是假象。
2. 用**清单里一模一样的地址**真跑一次，确认返回字段与 `pick` 对得上（字段名拼错不会报错，只会静默变空）。

---

## 提交前自查

- [ ] `id` / `name` / `version` / `description` / `hosts` / `endpoints` 齐全；
- [ ] 每个主机的 CORS 用带 `Origin` 的请求验过；
- [ ] 真实响应跑过一遍，`pick` 的每条路径都能取到值（不是一堆 `[]`）；
- [ ] `description` 说清了"参数怎么给、返回里哪些字段有用"，且**是英文**；
- [ ] `guide.md` 里有工作流、有模型不可能知道的知识、有失败时该说什么；
- [ ] 会改变结果的字段做成了**可覆盖参数**；用户偏好做成**配置字段**；
- [ ] 可能返回空的地方写了 `emptyHint`，且那句话是**可照做的下一步**；
- [ ] `maxChars` 够放下 `pick` 之后的结果（通常 8000 到 14000 足够）；
- [ ] 先在面板里装一遍、开关一次、卸载一次，都正常。

---

## 抄这两个

| 插件 | 目录 | 值得抄的地方 |
| --- | --- | --- |
| `weather` | `plugins/weather/` | 两个主机、两个端点串起来用、配置字段（温度单位）、指南里带代码表 |
| `music-search` | `plugins/music-search/` | 可覆盖的参数（市场）与 `emptyHint`、`pick` 削响应、指南里写清"不要 autoplay / 不要 fetch 音频字节 / 你听不到声音" |

---

## 现状与还没做的

**已有**：包格式与校验、两个入口（zip / 单文件）、主机白名单（两道）、字段与密钥、
响应 `pick`、`emptyHint`、提示词按能力裁剪 + 指南按需读、安装确认、开关 / 升级 / 卸载。

**还没有**（按大概的实施顺序）：

1. **js 工具** —— 声明式表达不了的那 20%（签名、分页拼接、格式转换）。需要 Worker 隔离 +
   每插件出口白名单 + 独立的授权话术；
2. **按 Agent 启用** —— 现在只有全局开关，不能让"只给某个 Agent 用"；
3. **插件自带界面** —— 随插件附一个组件/插槽（播放器、仪表盘这类）；
4. **签名与版本更新** —— 现在装的时候会展示主机与操作，但没有来源校验，
   也没有"这个包比上次多了权限"的提示；
5. **场景依赖声明** —— `.seed` 里记下"这个场景用了哪些插件"，导入时提示缺哪一个。

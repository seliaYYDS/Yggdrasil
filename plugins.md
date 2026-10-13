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
| `endpoints` | | 声明式端点，最多 60 个（与 tools 至少要有其一） |
| `tools` | | js 工具（~~tools/*.js~~，在 Worker 里隔离执行） |
| `ui` | | 自带界面（~~ui/*.tsx~~，Agent 用 plugin_ui 摆出来） |
| `signature` | | Ed25519 签名；验不过是**拒绝安装** |
| `update` | | 版本更新地址（主机必须在 hosts 里） |

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
| `headers` | | 附加请求头，值可以写 `{config:key}`（**不做 URL 编码**，适合 `Authorization`）；**引用了没填的字段时整条头会被丢掉**（可选鉴权靠这个） |
| `body` | | POST 时**只把这些参数**放进 JSON 请求体（默认全部）。路径参数不该混进 body |
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


### 可选鉴权：不填密钥也能用

很多服务（GitHub、各类开放 API）匿名可用但额度低，填了令牌额度高、还能写。想让一个插件**同时支持两种情况**：

    "fields": [
      { "key": "token", "label": "Token（可选）", "secret": true, "hint": "不填也能用（每小时 60 次）；填了变成 5000 次，并且只有填了才能创建。" }
    ],
    "endpoints": [
      {
        "name": "repo",
        "url": "https://api.github.com/repos/{owner}/{repo}",
        "headers": { "authorization": "Bearer {config:token}" }
      }
    ]

关键规则：**请求头里引用了没填的字段时，整条头会被丢掉**。
不这么做的话 ~~Bearer {config:token}~~ 会渲染成 ~~"Bearer "~~ ——
服务端会把它当成一个**无效令牌**直接拒绝，而不是当成匿名请求，于是"不填也能用"就废了。

（查询串里的 ~~{config:key}~~ 没填时只是留空，不影响请求，所以那边不需要特殊处理。）

### 密钥尽量放请求头，别放查询串

URL 会进日志、进 Trace、进你贴给别人的截图；请求头不会。
所以令牌、cookie、API Key 一律用 ~~headers~~ + ~~{config:...}~~。反面教材是把密钥拼在地址里
（~~?token=xxx~~）—— 那个地址一旦被打印出来，密钥就跟着走了。

案例：~~github~~ 插件用 ~~authorization: "Bearer {config:token}"~~；~~netease-music~~ 只能把 cookie 放查询串，
因为那个服务就是这么设计的（这不是好示范，但它说明了现实）。

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

## 自建服务类插件（地址由用户填）

有些服务要用户自己部署（网易云 API、自建图床、Home Assistant…），**地址不可能写死在清单里**。
这套格式为此留了三个东西，缺一个都会卡住：

    {
      "id": "netease-music",
      "hosts": ["{config:base_url}"],
      "fields": [
        {
          "key": "base_url",
          "label": "API 地址",
          "type": "url",
          "required": true,
          "placeholder": "http://localhost:3000"
        }
      ],
      "endpoints": [
        {
          "name": "search",
          "url": "{config:base_url}/cloudsearch?keywords={keywords}&limit={limit}"
        }
      ]
    }

| 东西 | 作用 | 不写会怎样 |
| --- | --- | --- |
| `hosts` 里写 `"{config:base_url}"` | 主机白名单由**用户填的值**决定 | 校验时地址主机不在静态白名单里，直接拒绝安装 |
| 字段 `type: "url"` | 值**原样插入**（不 URL 编码）、结尾斜杠自动去掉 | 地址被编码成 `http%3A%2F%2F…`，请求必失败 |
| 字段 `required: true` | 没填时**拦住调用**并提示"去插件面板填写「API 地址」" | 不拦 → 报一个看不懂的 URL 错误；乱拦 → 可选的 Cookie 一空就整个插件不能用 |
| 地址写成 `{config:base_url}/path` | 清单里查不到主机，主机校验交给执行时 | — |

**这对出口墙意味着什么**（值得写清楚，免得误会）：

- 用户填的值**定义**了白名单：填 `http://127.0.0.1:3000` 就只有 `127.0.0.1` 放行；
- 插件**没法**扩大这个范围 —— 清单里写死别的主机，安装时就会被拒；
- 模型也改不了它：它只能给声明过的参数值，而地址前缀来自用户字段；
- 执行时再查一遍：如果（被改过的）模板指向白名单外的主机，请求连发都不发。

**可选字段不要标 `required`**。像 "Cookie（可选）" 这种，留空是正常用法；
标了 required 会让用户一装上就觉得"用不了"。


### 端点会进提示词，所以有成本

每个端点的 ~~description~~ 与 ~~example~~ 都会写进系统提示（在**稳定前缀**里，配合前缀缓存只付一次，
不会破坏逐轮缓存）。实测参考：**36 个端点的网易云插件 = 约 8.4 KB**
（~~description~~ 6.1 KB + ~~example~~ 2.2 KB），另外快照里多一行；
而 ~~guide.md~~（4.5 KB）只在 Agent 调 ~~plugin_docs~~ 时才进上下文 —— 所以**写长指南不心疼，写长描述才心疼**。

推论：

- ~~description~~ 一句话，把"参数怎么给、返回里哪些字段有用"点到即可，背景知识放指南；
- ~~example~~ 只给真正容易被写错的端点（路径带好几个参数的那种）；不写会自动生成一个简单的；
- 60 个端点的上限是"别把提示词交给插件作者随意撑大"的兜底，不是鼓励写满。

### 命名：端点的名字跟着路由走

~~name~~ 决定 op kind（~~<插件id>.<name>~~）。**让名字与 API 自己的路由一一对应**，
用户拿着官方文档就能对上：路由 ~~/playlist/track/all~~ → 端点名 ~~playlist_track_all~~；
路由 ~~/artist/top/song~~ → ~~artist_top_song~~（注意官方那条是单数 song，别写成 songs）。

一个路由多种类型时可以拆开命名（例如 ~~/search?type=1/10/100/1000~~ 拆成
~~search~~ / ~~search_album~~ / ~~search_artist~~ / ~~search_playlist~~）——
这样每个端点的 ~~pick~~ 只挑一类结果，回读干净得多。

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
| ~~这个插件还没配好：请在插件面板里填写「API 地址」~~ | 标了 required 的字段为空 | 到插件面板填上；如果它其实是可选的，就别标 required |
| 自建服务的请求发不出去 | 地址字段没标 ~~type: "url"~~（被编码了），或 hosts 没写成 ~~{config:base_url}~~ | 按上一节的三件套改 |
| 回读里出现 ⚠ **「正文有内容但挑出来的字段全是空的」** | pick 路径与真实响应结构不一致（**不是"没搜到"**） | 照着一次真实响应修 pick；插件作者一定要用真响应验一遍 |
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

## js 工具（能执行代码的那一半）

~~tools/*.js~~ 里放的是**函数表达式**，装进包、由 Agent 按需调用：

    // tools/summarise.js  —— 整个文件就是一个函数
    async (args, ctx) => {
      const nums = String(args.numbers).split(',').map(Number);
      ctx.log('拿到 ' + nums.length + ' 个数');
      return { sum: nums.reduce((a, b) => a + b, 0) };
    }

清单里声明它：

    "tools": [
      { "name": "summarise", "label": "统计", "description": "…", "file": "tools/summarise.js",
        "params": [ { "name": "numbers", "description": "逗号分隔", "required": true } ],
        "cap": null, "timeoutMs": 3000 }
    ]

**ctx 能拿到什么**：

| | |
| --- | --- |
| ~~args~~ | 模型给的参数（按 ~~params~~ 校验过，必填缺了不会进来） |
| ~~ctx.fields~~ | 用户在插件面板填的值（含密钥）。**别把它写进返回值** —— 返回值会被回灌进提示词 |
| ~~ctx.log(text)~~ | 一行日志，会跟结果一起回给模型（最多 400 字符） |
| ~~ctx.fetch(url, init)~~ | **唯一的网络出口**，主机由主线程按白名单校验后代跑 |

**隔离模型（这是它敢被称为"能执行代码"的原因）**：

1. 工具在 **Worker** 里跑，碰不到主页面；
2. 进工具之前，那个 Worker 的 ~~fetch~~ / ~~XMLHttpRequest~~ / ~~WebSocket~~ / ~~EventSource~~ / ~~importScripts~~ **全部被抹掉**，
   所以它自己没有网络；
3. 要联网只能走 ~~ctx.fetch~~，而那一跳在主线程上做**主机白名单校验** —— 和声明式端点同一堵墙；
4. ~~timeoutMs~~（默认 8000，上限 30000）到点直接 ~~terminate()~~；
5. **拿不到 Worker 时拒绝执行**，不会退回主线程裸跑。界面上会说明"这个环境不支持隔离执行"。

**契约**：返回值必须能被 JSON 序列化（返回函数/DOM 会报错）；抛出的错误会如实回灌给模型；
源码里不能用 ~~import~~（包在 Worker 里以字符串执行，没有模块解析）。

**写工具时的三个坑**：~~Number('')~~ 是 0（先滤空串再转数）；返回值别太大（会被截断）；
密钥别放进返回值。


### js 工具的边界（实测，不是设计意图）

下面每一条都是**跑出来的**（拿探针工具走真实代码路径），不是读代码推测的：

| 边界 | 实测结果 |
| --- | --- |
| ~~fetch~~ / ~~XMLHttpRequest~~ / ~~WebSocket~~ / ~~EventSource~~ / ~~WebTransport~~ / ~~importScripts~~ | ~~typeof === "undefined"~~，真的没了 |
| ~~Worker~~ / ~~SharedWorker~~ / ~~sendBeacon~~ / ~~navigator~~ | 也没了 |
| ~~document~~ / ~~window~~ / ~~localStorage~~ / ~~indexedDB~~ / ~~caches~~ | 全是 undefined（Worker 本来就没有 DOM） |
| 白名单内的主机 | 200 |
| 白名单外的主机 | 主线程拒绝：~~插件不允许访问 evil.example.com~~ |
| ~~file://~~ 等非 http(s) | 拒绝：~~只允许 http(s)~~ |
| 返回值里有函数 | **静默丢掉**（~~{ fn }~~ 变成 ~~{}~~） |
| 返回 ~~undefined~~ | 变成 ~~null~~ |
| 返回值有循环引用 | 抛 ~~Converting circular structure to JSON~~ |
| 写 ~~import x from "y"~~ | 抛 ~~Cannot use import statement outside a module~~ |
| ~~while (true) {}~~ | 到点被杀：~~Script execution timed out~~ |
| ~~throw~~ | 原样把错误文本回读给模型 |
| 读 ~~ctx.fields~~ | ✅ 可读（含密钥） |
| 把密钥写进返回值 | ✅ 可以 —— **没有拦截** |
| 一次调用里 25 次 ~~ctx.fetch~~ | **全部发出**，没有次数配额 |

**三条真实缺口**（知道了才好决定要不要装某个插件）：

1. **~~ctx.fetch~~ 没有次数配额。** 只有整体超时（默认 8s）管着，所以一次调用能打几十个请求 ——
   足以打满对方站点的限流，或者刷掉你自己 token 的额度。声明式端点一次调用只发**一个**请求，
   js 工具没有这条天然约束。
2. **~~Function~~ 没被抹掉。** 所以"不能动态生成代码"不是一条边界。它逃不出沙箱（照样没网络），
   但别再声称这一点。
3. **密钥能顺着返回值流出去。** 工具读得到 ~~ctx.fields~~，而返回值会进回读、进提示词 ——
   也就是给了模型服务商。主机白名单管**往哪发**，管不了**往回复里写什么**。

**还有一个我不敢保证的点**：擦除实现方式是 ~~self[k] = undefined~~。
如果某个运行时把 ~~fetch~~ 定义在 ~~WorkerGlobalScope.prototype~~ 上而不是全局对象自身上，
那么 ~~Object.getPrototypeOf(self).fetch~~ 有可能把原函数捞回来。
**我没法在真浏览器里验证这一点**（Node 里没有 Worker）。所以请这样理解这层隔离：
它是**把破坏力关进小房间**（一个没有 DOM、没有存储、没有被授权的网络出口的 Worker），
而不是"对抗一个铁了心要逃出去的攻击者"的硬边界。

### 写工具时最容易踩的三条

- **只能拿到清单里声明过的参数**。没声明的读不到（~~args.n~~ 是 ~~undefined~~），
  而返回值只会安静地变成 ~~null~~，**不报错**。我自己的示例工具就这么踩过一次。
- **每次调用都是新的 Worker**，调用之间**没有共享状态** —— 不能靠全局变量攒缓存，
  也不能"第一次调用初始化、第二次调用使用"。
- **返回值走 JSON 往返**：函数会消失，~~NaN~~ 变 ~~null~~，循环引用直接报错。
  单次响应正文截到 200KB，返回值截到 12000 字符。

---

## 插件自带界面（ui/*.tsx）

~~ui/*.tsx~~ 是一个**普通 TSX 模块**，和组件源码同一套契约（~~export default~~ 一个函数组件，
可以 ~~import * as React from "react"~~，也可以用 ~~"yggdrasil"~~ 里的东西）：

    import * as React from "react";
    export default function Board() {
      const rows = (typeof data === "object" && data && data.rows) || [];
      return <div>{rows.map((r, i) => <div key={i}>{r.label}: {r.value}</div>)}</div>;
    }

**组件没有 props**（主页面就是 ~~<C />~~）。需要数据时，Agent 调 ~~plugin_ui~~ 传 ~~data~~，
它会被**注入成模块顶层的常量~~ data ~~** —— 所以上面那行直接读 ~~data~~ 就行。没传就是 ~~null~~。

    { "kind": "plugin_ui", "id": "status-board", "ui": "board",
      "data": { "title": "今天的数字", "rows": [{ "label": "合计", "value": "23" }] } }

清单里声明：

    "ui": [ { "name": "board", "label": "状态看板", "description": "…", "file": "ui/board.tsx",
              "dataDoc": "{ title?: string; rows?: {label,value}[] }" } ]

**建出来的窗口是锁定的**（~~locked: true~~）：它是插件作者的代码，
~~patch_source~~ 与 ~~remove_node~~ 都会拒绝，用户可以在 Nodes 面板解锁。
这样"插件代码只读"这条约定才不是空话。

---

## 签名与版本更新

**签名**是清单里的一个块（脚本帮你生成）：

    node scripts/sign-plugin.mjs keygen                       生成一对密钥
    node scripts/sign-plugin.mjs sign plugins/my-plugin key.priv
    node scripts/sign-plugin.mjs verify plugins/my-plugin

它输出一段 ~~signature~~，贴进 manifest.json 顶层：

    "signature": { "alg": "ed25519", "publicKey": "<base64 32 字节>", "value": "<base64 64 字节>" }

签的是**包内容哈希**：包内所有文件按名字排序拼起来做 SHA-256，
其中 ~~manifest.json~~ 的 ~~signature~~ 块**不参与**（否则签名把自己算进去，永远验不过）。
两类哈希必须用**作者写的原始清单**算，不能用校验后的对象 —— 校验会补齐/重排字段，
用它算出来的哈希对不上，报错还写着"内容被改过"，极难查。这个坑真踩过一次。

- 验不过（bad）→ **拒绝安装**（"内容与签名不符"）；
- 环境不支持 Ed25519 → 标成 ~~unsupported~~，**不假装验过**，也不因此拒装；
- 没签名 → ~~none~~。三种状态在插件面板里如实显示，并给出公钥指纹与包哈希前几位。

**版本更新**：清单里声明一个地址，返回 ~~{"version": "2.0", "url": "https://…/x.graft"}~~：

    "update": { "url": "https://example.com/my-plugin/version.json" }

它的**主机必须在 ~~hosts~~ 白名单里** —— 更新不给插件多开一个网络出口。
插件面板上的「检查更新」读它、比版本号；有新版才提示，并且**照旧走一遍安装确认**。

**升级时的权限差异**会逐条列出来：新增的主机、新增的操作、**新增的 js 工具**、
新增要填的密钥、新增的能力开关。理由很直白：用户上一次点的"安装"是针对**上一版**给的授权，
这一版多要了东西就必须再讲一遍 —— 否则"升级"就成了绕过授权的通道。
另外还会警告"版本号没变但内容变了"（哈希不同），那种包最可疑。

---

## 现状与还没做的

**已有**：包格式与校验、两个入口（zip / 单文件）、主机白名单（两道）、字段与密钥、
响应 `pick`、`emptyHint`、提示词按能力裁剪 + 指南按需读、安装确认、开关 / 升级 / 卸载。

**已经有了**：声明式端点、**js 工具（Worker 隔离）**、**自带界面**、
**签名（Ed25519）与版本更新（含权限差异）**、密钥、pick、emptyHint、按能力裁剪、安装确认、开关 / 升级 / 卸载。

**还没有**：

2. **按 Agent 启用** —— 现在只有全局开关，不能让"只给某个 Agent 用"；
3. **插件自带界面** —— 随插件附一个组件/插槽（播放器、仪表盘这类）；
5. **场景依赖声明** —— `.seed` 里记下"这个场景用了哪些插件"，导入时提示缺哪一个。

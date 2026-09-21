# 沸点抽卡 · 浏览器扩展

在 **juejin.cn** 页面上浮一层「沸点抽卡」，两态：

- **收起** —— 右上角一张**缩略卡**（站点自己的竖版纸牌），点一下展开；
- **展开** —— **牌阵 + HUD 整段版式端到页面正中**（主卡落在页面正中），
  底下铺一层全屏遮罩（半透明底 + 背景虚化），点遮罩收起。
  **窗口自身没有底板**：站点那三层白底（`.page` / `.stage` / `.hud`）在浮层里全部打透，
  只剩卡片 / 箭头 / AI 卡 / HUD 内容浮在虚化背景上。

两态都是站点首页那一整套，没有第二个实现。

---

## 这个扩展是怎么做的：复用，而不是重写

**站点前端只有一份源头，扩展是它的宿主。** `extension/` 里的 `app.css` /
`app.js` / `data.js` / `host.html` 全部由 `scripts/build_extension.py`
从 `site/` 生成，不手改。

```
site/index.html ──build──▶ extension/host.html   （加 embed.css / embed-boot.js / api-shim.js）
site/app.css    ──copy───▶ extension/app.css     （逐字节）
site/app.js     ──patch──▶ extension/app.js      （唯一一处补丁，见下）
site/data.js    ──copy───▶ extension/data.js     （逐字节，内置牌堆兜底）
```

### 唯一一处补丁

`site/app.js` 里有两处 `if (location.protocol !== 'http:' && ...)` 判断
「有没有同源代理可用」（`boot()` 的实时拉取闸门、`refreshDeck()` 的洗牌闸门）。
扩展页是 `chrome-extension:` 协议，但接口由扩展宿主提供，所以两处都放行：

```js
… && !window.__JB_HOST__
```

> 只放行 `boot()` 会让「洗牌」退化成纯本地换序、永远拉不到最新沸点——
> 是个很难发现的哑故障。所以 `build_extension.py` 会**校验补丁命中 2 次**，
> 命中数不对就直接报错退出。

### 接口层：从 `site/serve.mjs` 逐字移植

站点原本靠 `serve.mjs`（本地 dev server）提供 5 个接口。扩展里没有服务器，
所以 `api.mjs` 把它们的**业务逻辑、提示词、并发闸门、两级缓存**逐字搬了过来，
只把 Node 的 `req/res` 换成「入参对象 / 返回 `{status, body}`」：

| 站点（serve.mjs） | 扩展（api.mjs） |
|---|---|
| `handleApiPins` | `apiPins({ fresh })` |
| `handleApiRoast` | `apiRoast(payload)` |
| `handleApiComment` | `apiComment(payload, ctx)` |
| `handleApiComments` | `apiComments({ pinId }, ctx)` |
| `/api/roast/config` 内联分支 | `apiRoastConfig()` |

响应形状必须和 serve.mjs 一模一样，因为 `app.js` 就是按那个形状写的
（`/api/pins` 要 `{pins:[…]}`、`/api/roast` 要 `{roast}` 或 `{roasts:{},error}`）。
形状一对不上，站点前端就得改——那就不是复用了。

### 页面怎么拿到接口：只劫持 fetch

`api-shim.js` 在 `app.js` 之前加载，把 `/api/*` 的 `fetch` 转成
`chrome.runtime.sendMessage` 交给 `background.js`。**`app.js` 一行都不改**，
于是站点的牌面、样式、翻牌动效、AI 配置弹窗全部原样复用，不存在两套实现漂移。

没有扩展宿主时（本地 http 预览、直接打开 `host.html`）它会降级成同源 fetch ——
所以同一份页面**既能当扩展跑，也能当网页跑**。

---

## 展开态取哪一段版式，以及为什么（v0.2）

**窗口 = 舞台顶 → HUD 底**，即 page 坐标 `x[0,1440] × y[226,948]` → **1440 × 722**。

`embed.css` 做四件事：

```css
html.embed .hero { display: none; }                    /* 不要 Hero（230 高，占地方） */
html.embed .page-inner { transform: scale(var(--k,1)) translate(0, -226px); }
                                                       /* 舞台顶对到窗口顶；x 不动 */
html.embed .page-wrap  { height: calc(722px * var(--k,1)); }
html.embed .page       { width: calc(1440px*k); height: calc(722px*k); }
html.embed .page,
html.embed .stage,
html.embed .hud        { background: transparent; }     /* v0.2.1：白底整片打透 */
```

### x 方向**不要裁**（v0.1 的构图 bug 就在这）

站点的横坐标（`app.css` 为权威，文件头那行注释里的 796 是旧的）：

| 元素 | 设计 x |
|---|---|
| 左邻卡 `.ghost.left` | 424 – 764 |
| 主卡 `.main` | 534 – 906（中心 **720**） |
| 右邻卡 `.ghost.right` | 676 – 1016 |
| 翻牌箭头 `.round` | 448 与 956（中心 466 / 974，中点 **720**） |
| AI 点评卡 `.ai` | 1136 – 1420 |

**牌阵（424–1016）的中心正好是 720，而 1440 宽画布的中心也是 720 ——
主卡在站点上本来就是居中的**（已在 1440×1000 下实测：`.main` 落在 540–900，中心 720）。

v0.1 为了"去掉左侧 424 的留白"，把窗口裁成 `x[424,1440]`（`translateX(-424px)`）。
结果牌阵中心被挪到 1016 宽窗口的 296px 处（29%），**主卡看起来就偏左了**。

能不能既裁掉留白又让主卡居中？不能：AI 卡右缘在 1420，要让主卡（中心 720）居中
就得半宽 ≥ 700，也就是窗口 ≥ 1400 —— 顶多从 1440 收 40px。
**左侧那 424px 留白是站点自己的构图，删了构图就塌。** 现在左右各 424（右侧那 424 里
坐着 AI 卡），所以视觉上是平衡的。

### HUD 不要再藏起来

v0.1 写了 `html.embed .hud{display:none}`，把洗牌钮 / 动效档 / 快捷键提示整条藏了。
现在照常显示（page y 862–948 → 窗口 y 636–722，仍是整宽）。

### 白底整片打透：只留卡片 / 按钮 / HUD（v0.2.1）

站点上 `.page`、`.stage`、`.hud` 各铺一层 `#fff`，叠起来就是那张盖满窗口的大白纸。
浮层里三层全改透明后：

- 卡片（`.main` / `.ai`）本来就带 1px 描边 + 蓝调投影，脱离白底仍然立得住；
- 邻卡 `.ghost` 是 `#EBF2FF` 不透明 + `filter:blur(2.5px)`，照旧是"虚化的下一张"；
- 空处透出父页面那层遮罩 —— **虚化不在这里做**（原因见下一节）。

实测（1920×960，展开态，采样截图上的像素）：
主卡内部 `(255,255,255)` 纯白；而**面板内空处与面板外**取到同一组值
（`(189,190,192)`，HUD 行同样）—— 说明窗口底板已经彻底透掉。

**HUD 要跟着补一手**：那两行小字原来靠白底托着，`#A8AEB8` / `#8A9099` 这种浅灰
落在约 `#BDBEC0` 的虚化灰上几乎读不出来（第一版截图里第二行整行糊掉）。修法不动版式：

- 两级次要文字各提一档明度（`.keys` → `#4E555E`，`.keys b` → `#3D444D`）；
- 加一层极淡的白色 `text-shadow`，把字从灰底里"拎"出来；
- 小圆钮（`.hud .shuffle`，即"洗牌 / 动效"）是**按钮**，补一层 `rgba(255,255,255,.72)`
  半透明白底 —— 透得出虚化，但不是实心白条。

也就是说：**嵌入态的调色是按"落在虚化灰上"重新校过一遍的**，
`site/` 那份不动（它在白底上是对的）。

### 遮罩与背景虚化做在**父页面**，不能做在 iframe 里

`content.js` 在宿主下面铺一层 `<div id="juejin-pin-gacha-mask">`：

```js
position: fixed; inset: 0; z-index: Z - 1;
background: rgba(17,21,28,.28);
backdrop-filter: blur(12px) saturate(115%);
```

**为什么必须是父页面这一层**：`backdrop-filter` 糊的是"元素背后的内容"。
iframe 自己内部只看得见 iframe 的（透明）画布，在 iframe 里写 backdrop-filter
什么也糊不着 —— 要糊掘金页面，只能由 content script 在掘金文档里铺。

两个工程细节：

- **遮罩只在展开态存在。** 收起态直接不创建（`showMask(false)` 时若还没建过就 return）；
  淡出播完把 `display` 也设成 `none`。否则那层 `backdrop-filter` 会常驻一个合成层，
  而用户绝大多数时间是收起状态。
- **遮罩吃点击**（`pointer-events:auto`），点它就收起（等价于点站点的 dock 钮）。
  既是模态该有的行为，也顺手拦住误触 —— 不然点空处会点到下面的掘金页面。

### 展开居中 / 收起贴右上角，是一处开关

`content.js` 的 `ANCHOR`：`'center'`（默认，主卡落在页面正中）| `'topright'`。
收起态**永远**贴右上角，与它无关。本地预览可用 `?jb-anchor=topright` 覆盖着看：

```
http://127.0.0.1:7300/panel.html?jb-anchor=topright
```

实测 `topright` 下窗口是 `1440×722 @ (468,12)`（1920 视口），主卡落在视口 x=1188 ——
偏右，所以那个变体满足不了"主卡在页面中间"。

面板在「右上角 ⇄ 页面正中」之间是**滑动**过去的：宿主对 `left/top/width/height`
做 280ms 过渡。**这四个必须一起过渡** —— 缩略卡贴在窗口右上角，
而窗口右缘 = `left + width`；只过渡 `left` 不过渡 `width` 的话，
展开瞬间右缘会先跳出 1244px 再滑回来，缩略卡就闪一下。

---

## 文件

| 文件 | 角色 | 要改吗 |
|---|---|---|
| `manifest.json` | MV3 清单 | 手写 |
| `host.html` | 扩展页面（= `site/index.html`） | 由构建生成，勿手改 |
| `app.css` / `app.js` / `data.js` | 站点前端 | 由构建生成，勿手改 |
| `embed.css` | 浮层版式：去掉 Hero、窗口取「舞台顶→HUD 底」(1440×722)、白底整片打透、接管 `--k` | 手写 |
| `embed-boot.js` | 浮层宿主桥：打 `html.embed`、接管 `--k`、与父窗口交换展开/收起尺寸 | 手写 |
| `api-shim.js` | 把 `/api/*` 的 fetch 接到扩展宿主 | 手写 |
| `background.js` | MV3 service worker：消息路由；需要登录态的接口转到页面上下文去发 | 手写 |
| `api.mjs` | 移植自 `serve.mjs` 的 5 个接口 | 手写 |
| `content.js` | 在 juejin.cn 注入宿主与遮罩、落位、同步展开/收起尺寸 | 手写 |

## 装法

1. Chrome 打开 `chrome://extensions/`，右上角打开「开发者模式」
2. 「加载已解压的扩展程序」→ 选这个 `extension/` 目录
3. 打开或刷新 `juejin.cn`

工具栏图标等价于点浮层里的收起按钮（展开 ⇄ 缩略卡）。
展开后**点遮罩也能收起**。

**配置 AI 点评**：展开浮层后点右上角的 ✦，填任意 OpenAI 兼容接口
（baseUrl / API Key / 模型），配置存在扩展页自己的 localStorage。
站点那套「点评风格」弹窗（「风格」钮）也照常可用。

> 「一键评论」在扩展里比站点更省事：请求在**掘金页面上下文**里发出，
> 登录 Cookie 自动带上，**不用再手动复制 Cookie**。

## 改前端逻辑的正确姿势

改 `site/` 下的文件 → 重跑 `python scripts/build_extension.py`。
直接改 `extension/app.js` 会在下次构建时被覆盖（文件头有警示注释）。

## 开发/验证工具

```bash
python scripts/build_extension.py     # 从 site/ 重建扩展前端（补丁失配会报错退出）
python scripts/check_extension.py     # 静态自检：清单引用、JS 语法、注入顺序、补丁次数
node   scripts/_ext_preview.mjs 7300 --mock-ai
                                      # 本地预览服务：同一份 extension/ + 同一份 api.mjs
                                      #   /panel.html  → 模拟掘金页面，真跑 content.js
                                      #   /panel.html?tall=1 → 同上，但撑出一条竖向滚动条
                                      #       ⚠️ 复现定位类 bug 必用这个开关，原因见下
                                      #   /panel.html?jb-anchor=topright → 换个锚点变体看构图
                                      #   /host.html  → 站点原页面（构图参照，k 由 fitStage 自己算）
                                      #   /host.html?embed=1 → 只有牌面本身
node   scripts/_probe_api.mjs         # 接口层自测（假上游 + 真上游，不用真 Key）
```

> **`?tall=1` 不是装饰。** 默认那版预览页太短、压根不出滚动条，而浮层的
> 「贴右上角」自检一旦基准取错就只在**有滚动条**的页面上暴露 —— 真实掘金页是有
> 滚动条的。历史上 `content.js` 的落位 bug 就是因为预览页没滚动条而一路漏检。
> 现在预览服务还一律 `Cache-Control: no-store`，避免改了 `content.js` 却跑旧代码。

## 踩坑记录：浮层贴右上角的定位

**症状**：装上扩展、点开缩略卡，主卡阵跑到页面右边、大半个屏幕在视口外，
只剩贴着右缘窄窄的一条。

**根因（三层叠加，都在 `content.js` 的落位逻辑里）**：

1. 自检基准取错。判断「有没有贴到右上角」时拿 `window.innerWidth` 当视口宽度，
   但 `window.innerWidth` **包含竖向滚动条**，而 `position:fixed` 元素的包含块是
   **不含滚动条**的视口。本机 Chrome 实测差 15px，容差却是 2px
   → 于是**任何带滚动条的页面上都必然误判成"跑偏"**。
   （agent-browser 在真实 juejin.cn 上量的：viewport 1440×900，
   `innerWidth` 1440 / `clientWidth` 1425。）
2. 退路按旧宽度算死。误判后改用 `position:absolute` 兜底，`left` 却是拿
   **收起态宽度 196** 算的（`left = innerWidth - 12 - 196 = 1232`）。
   展开成 1016 时只改了 `width`、没重算 `left`，面板右缘于是长到 2248，
   视口只到 1425 —— **823px 出屏，只剩 193px 露在外面**。
3. 退路里多减了一次文档偏移。写的是 `scrollY + 12 - documentElement.rect.top`，
   而页面滚动时 `html.getBoundingClientRect().top` 本身就等于 `-scrollY`，
   减这一下等于把滚动量算了两遍，面板会往下掉一截。

**修法**：

- 视口尺寸一律走 `viewport()` → `documentElement.clientWidth / clientHeight`；
- 落位收敛成一个 `place(w, h)`，**任何尺寸变化都重算**（展开、收起、视口 resize、
  SPA 换路由后重新挂载），不再有「只改宽高、left 留在原地」的路径；
- `place()` 里先按 `fixed` 摆、量一次自检，真跑偏了才退 `absolute`，
  且退的时候 `left` 用**当前**宽度、`top/left` 直接用 `scrollX/scrollY` 换算；
- 元素**入文档之后**才落位（`place()` 依赖 `getBoundingClientRect()` 自检，
  不在文档里量出来全是 0，会被误判成跑偏）。

实测结论：真实掘金页 `html` / `body` 的 `transform`、`filter`、`perspective`
**全是 `none`** —— fixed 本来工作得好好的，根本不该走退路。退路现在只作为
「万一某个祖先带了 transform」的安全网保留。

**回归数据**（`/panel.html?tall=1`，viewport 1440×900，滚动条 15px）：

| 状态 | 面板 rect | 右缘出屏 |
|---|---|---|
| 收起 | `top 12, left 1217, right 1413, 196×236` | −12 |
| 展开 | `top 12, left 397, right 1413, 1016×620` | −12 |
| 再收起 | `top 12, left 1217, right 1413, 196×236` | −12 |

右缘恒为 `clientWidth − 12 = 1413`。窄视口 1100×800 同样 `right 1073 = 1085 − 12`，
`--k` 稳定为 1。

> 上表的「展开」那行是 **v0.1.1 时代**的数字（当时窗口裁成 1016×620，且贴着右上角）。
> v0.2 起展开态改成 1440×722 居中，纵向 12px 的贴边口径只对**收起态**成立 ——
> 收起态仍然恒为 `right = clientWidth − 12`。

## 验证到什么程度 / 没验证到什么

**验过（有实测数据）**

- 移植的接口：`/api/pins` 打真实上游拿到 60 条、12 个字段齐全；
  `/api/roast` 单条与批量（能从 ```` ```json ```` 包裹里容错提取）、10 分钟缓存命中不重复打上游、
  上游 404 的原错误如实透传、缺配置给可读提示；`/api/comments` 匿名可读（实测 3 条）。
- **展开态构图（v0.2 修）**：1920×960 视口（`clientWidth` 1905）下，
  宿主 `1440×722 @ (233,119)`，**宿主中心 (953,480) = 视口中心 (953,480)**；
  面板内主卡 `534–906`，**中心 720 = 面板中心 720**；HUD `0–1440 @ y 636–722`。
  站点原页面在 1440×1000 下实测主卡 `540–900`、中心 720 —— 与面板内一致。
- **白底打透（v0.2.1）**：展开态下 `getComputedStyle` 读回 ——
  `body` / `.page` / `.stage` / `.hud` / iframe 全部 `rgba(0,0,0,0)`；
  `.main`、`.ai` 仍 `rgb(255,255,255)`，`.ghost` 仍 `rgb(235,242,255)`，
  `.hud .shuffle` 为 `rgba(255,255,255,0.72)`，`.hud .keys` 为 `rgb(78,85,94)`。
  同屏像素采样：主卡内部 `(255,255,255)`；**面板内空处 HUD 行 (433,793)、面板内左空处
  (533,393)、面板内下空处 (600,700) 与面板外 (100,100)/(1800,480) 全部取到
  `(189,190,192)`** —— 面板内外的"背景"已是同一层虚化，白纸确认消失。
- 两态与遮罩生命周期：**加载即收起**、宿主 `196×236 @ (1697,12)`、右缘距视口 12px、
  **此时遮罩根本不存在**（`maskExists: 0`，不留常驻合成层）；
  点缩略卡 → 遮罩 `display:block / opacity:1 / pointer-events:auto`、面板滑到正中；
  点遮罩 → 回到 `196×236 @ (1697,12)`、遮罩 `display:none / opacity:0 / pointer-events:none`。
- 面板位移过渡：`left/top/width/height` 四者同时过渡（右缘 = `left+width` 才是线性的）。
- 展开后 `fitStage()` 反复重算也改不动 `--k`（这是踩过坑的地方，见 `embed.css` 注释）。
- **落位（v0.1.1 修）**：在带 15px 滚动条的页面上，收起 / 展开 / 再收起三态下
  右缘恒为 `clientWidth − 12`，横向出屏 −12px；窄视口 1100×800 同样贴右。
  基准数据（`innerWidth` 1440 / `clientWidth` 1425、`html`/`body` 无 transform）
  是直接用 agent-browser 在**真实 juejin.cn** 上量的。
- `ANCHOR='topright'` 变体：窗口 `1440×722 @ (468,12)`、右缘距视口 12px ✓
  （但主卡落视口 x=1188，偏右 —— 所以默认不用它）。

**没验到**

- **`chrome.*` 那几行真实链路**：本机无法给 Chrome 加载未打包扩展
  （agent-browser 起不了 `--load-extension`），所以 `chrome.runtime` /
  `chrome.tabs.sendMessage` / `web_accessible_resources` 的真实行为只做了静态检查
  （`scripts/check_extension.py`）与代码审查，没有端到端跑过。
- 在真实 juejin.cn 上的表现：掘金页面的全局 CSS、SPA 换路由、
  以及头部元素与缩略卡的位置冲突，都还需要在真环境里看一次。
  （定位基准那部分已经借 agent-browser 在真站上量过了，见上。）
- **全屏遮罩的滚动性能没验**：`backdrop-filter: blur(12px)` 铺满视口，
  掘金页面滚动时理论上要逐帧重糊。已做的缓解是「收起态不创建遮罩 + 淡出后
  `display:none`」，展开态滚动没在真站上跑过。真觉得卡就把 `MASK_ALPHA` 调小、
  或把 `backdrop-filter` 那两行去掉（只留半透明底也能起到遮罩作用）。

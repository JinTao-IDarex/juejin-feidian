# 沸点抽卡 · 掘金沸点翻牌站

把掘金沸点做成一副牌，一张一张翻，每张配一句 AI 点评，顺手就能贴进评论区。

不上传、不做掘金账号体系——AI 接口走你自己的 Key。评论一键代发暂时下线（按钮一律复制），恢复后用的是你本机的掘金登录态，发送与否始终由你亲手决定。

![joker logo](assets/logo-juejin-joker.jpg)

## 功能

- **翻牌**：60 张沸点一副牌，← → 翻，空格抽下一张，S 洗牌（拉最新沸点）
- **AI 点评**：支持 OpenAI / Anthropic / 智谱 GLM / Z.ai / Kimi 等多家厂商，AIMD 自适应并发批量生成
- **点评风格**：毒舌 / 温柔 / 理性 / 吃瓜 / 文青，五种预设一键切换
- **复制点评**：一键复制当前 AI 点评，贴进评论区即可。评论一键代发暂时下线（掘金网关 CSRF 拦截待解），链路保留，开关在 `site/app.js` 的 `COMMENT_POST_ENABLED`
- **浏览评论**：右侧 AI 卡升级成滑动卡组，↑ ↓ 翻掘金真实评论
- **音效**：Web Audio 实时合成纸牌咔哒声，默认静音，M 键切换
- **动效三档**：完整 / 轻量 / 跟随系统，HUD 一键切换，选择持久化
- **收起为迷你卡片**：页面可折叠成扑克牌样式的小卡，Esc 收起，盲翻有 tick 反馈
- **浏览器扩展**：在掘金页面悬浮同款主卡，收起/展开动画逐帧平滑

## 快速开始

### 站点

```bash
# 启动本地 dev server（零依赖，Node 18+）
npm install        # 只装一个根目录 package.json 的 dev 脚本
npm run dev        # 默认 http://127.0.0.1:7100
```

打开浏览器访问上面的地址即可。首次进入会经 `/api/pins` 拉实时沸点（服务端代理掘金接口，绕过 CORS），失败回退 `data.js` 内置牌堆。

### 配置 AI

点页面右下角的「AI 配置」按钮，或写一份 `site/.ai-config.json`（模板见 `site/.ai-config.example.json`）：

```json
{
  "baseUrl": "https://api.moonshot.cn/v1",
  "token": "sk-你的真实 Key",
  "model": "kimi-k2"
}
```

服务端配置文件里的 Key 不进浏览器。也可以在弹窗里临时配，存 localStorage。

### 浏览器扩展

1. `python scripts/build_extension.py` 生成 `extension/`（站点前端同步 + 补丁校验）
2. Chrome 打开 `chrome://extensions/`，开启开发者模式
3. 「加载已解压的扩展程序」→ 选 `extension/` 目录
4. 打开任意 `juejin.cn` 页面，右上角会出现缩略卡，点一下展开

详细设计见 [`extension/README.md`](extension/README.md)。

## 目录结构

```
juejin-boom/
├── site/              # 站点本体（前端 + dev server）
│   ├── app.js         # 主逻辑：翻牌、AI 点评、批量、评论
│   ├── app.css        # 磨砂玻璃风格样式 + 动效
│   ├── index.html     # 牌面 + HUD + 弹窗
│   ├── providers.js   # AI 供应商声明表（浏览器/Node/扩展三端共用）
│   ├── serve.mjs      # 零依赖 dev server + /api/* 代理
│   └── data.js        # 内置牌堆（60 条 0917 沸点 + 配对点评）
├── extension/         # Chrome 扩展（MV3）
│   ├── content.js     # 注入掘金页面，管理悬浮窗口
│   ├── api.mjs        # 接口层（从 serve.mjs 逐字移植）
│   └── ...            # 其他文件由 build_extension.py 从 site/ 同步
├── scripts/           # 工具链
│   ├── fetch_pins.py  # 抓掘金沸点原始数据
│   ├── build_extension.py   # 从 site/ 构建扩展（带补丁校验）
│   ├── build_icons.py       # 生成扩展图标
│   ├── check_extension.py   # 扩展一致性校验
│   ├── pack.py        # 打包 dist/juejin-feidian-card-extension.zip
│   └── ...
├── data/              # 原始沸点数据（0917）
├── previews/          # 预览页（单文件 HTML）
├── assets/            # 设计素材（logo、吉祥物）
└── dist/              # 打包产物
```

## 工具脚本

| 脚本 | 用途 |
|---|---|
| `python scripts/fetch_pins.py 0917` | 抓掘金沸点，输出 `data/pins_raw_0917.json` |
| `python scripts/build_data.py` | 生成 `site/data.js`（内置牌堆） |
| `python scripts/build_extension.py` | 从 `site/` 构建扩展（校验补丁命中 2 次） |
| `python scripts/check_extension.py` | 校验扩展与站点一致性 |
| `python scripts/build_icons.py` | 生成扩展图标（16/32/48/128） |
| `python scripts/pack.py` | 打包 `dist/juejin-feidian-card-extension.zip` |
| `python scripts/gen_card.py 0917` | 生成单文件预览页 `previews/juejin_pins_gacha_0917.html` |
| `python scripts/align.py 0917` | 对齐沸点与评论，输出 `data/align.txt` |
| `node scripts/_probe_api.mjs` | 探测 AI 接口连通性 |
| `node scripts/_probe_providers.mjs` | 探测供应商表可用性 |

## 技术栈

- **前端**：原生 JS + CSS，零框架、零构建
- **后端**：Node 18+ 零依赖 dev server（`site/serve.mjs`）
- **扩展**：Chrome MV3，`chrome-extension:` 协议，host_permissions 限定 `*.juejin.cn`
- **AI 接口**：OpenAI 兼容协议（chat/responses/anthropic 三种），服务端代理转发
- **数据**：掘金 recommend API（服务端代理，180s 缓存）

## 许可证

[Apache License 2.0](LICENSE)

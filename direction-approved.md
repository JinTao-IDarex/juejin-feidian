# direction-approved.md

- 任务：魔鬼榜单「AI 评分中」弹窗重设计
- 展示的三版初稿（截图）：
  - A · 像素游戏 HUD（轮盘 #9）→ design-demos/A-pixel-hud.png
  - B · Balatro 牌桌（现实参照 Balatro）→ design-demos/B-balatro-table.png
  - C · 原研哉精密仪器（最佳设计师逻辑）→ design-demos/C-hara-ledger.png
- 用户选择原话（2026-10-19 15:49）：「使用方案B，并结合当前页面的整体风格。」
- 执行口径：Balatro 骨架（计分丸 / 扇形待发牌 / 正在落位 / 六 Joker 位 / 日志式阶段条），
  视觉向站点现有语言靠拢——去掉 CRT 扫描线与重暗角、绿调亮一档、字体沿用 Noto Sans SC 既有档位、
  卡牌沿用白卡 + 赛道色；html.embed 浮层档位同步；保留全部既有 DOM id 契约与 check_extension.py 断言。

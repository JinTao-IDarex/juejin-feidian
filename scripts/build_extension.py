# -*- coding: utf-8 -*-
"""build_extension.py — 把 site/ 的前端原样同步进 extension/

设计原则：**extension 里不允许出现第二份手写的牌面实现**。
站点前端只有一份源头，扩展是它的宿主。所以这里做的是「复制 + 极小补丁」：

  1) app.css / data.js / providers.js            —— 逐字节复制（抽卡页）
     board.css / board.js / board-core.mjs       —— 逐字节复制（魔鬼榜单）
  2) app.js                 —— 复制后打唯一一处补丁（见 PATCHES）
  3) index.html             —— 改名 host.html 并挂上 embed.css / embed-boot.js / api-shim.js
  3b) board.html            —— 同样注入（embed.css 必须排在 board.css **之后**，见下）
  4) 图标
  5) 榜单卡牌形象 assets/board-cards/*.png  →  extension/cards/（按需缩到 640）

榜单为什么能直接复制、不用补丁：
  · board.js 的接口调用是相对路径 `fetch('api/board?…')`，由 api-shim.js 统一劫持；
  · 它读 AI 配置用的 localStorage 键与 app.js 同一个（同源页面共享）；
  · 浮层档位靠 board.css 里 `html.embed { … }` 那一整块，由 embed-boot.js 打标激活，
    所以同一份文件在站点是 1440x1000、在浮层是 1440x722。

补丁必须列在 PATCHES 里、且应用后校验命中次数：site/app.js 一旦改动导致
补丁失配，脚本直接报错退出，绝不留下一个「看起来能跑」的扩展。

用法：  python scripts/build_extension.py
"""
import os
import shutil
import sys

ROOT = r"D:\2workspace\codex\juejin-boom"
SITE = os.path.join(ROOT, "site")
EXT = os.path.join(ROOT, "extension")
# 图标不再从 _bak/ 拷旧图，改为由 scripts/build_icons.py 从主版 logo 生成
# （源：assets/logo-juejin-joker.jpg）。见本文件第 4 步。

# ---------------------------------------------------------------- 补丁表
# 每项：(说明, 原文, 替换成, 期望命中次数)
PATCHES = [
    (
        "app.js 用 location.protocol 判断「有没有同源代理可用」，共两处："
        "boot() 的实时拉取闸门、refreshDeck() 的洗牌闸门。"
        "扩展页是 chrome-extension: 协议，但接口由扩展宿主（background.js）提供，"
        "所以两处都要放行 —— 只放行 boot() 的话，点「洗牌」会退化成纯本地换序、"
        "永远拉不到最新沸点，是个很难发现的哑故障。",
        "if (location.protocol !== 'http:' && location.protocol !== 'https:') {",
        "if (location.protocol !== 'http:' && location.protocol !== 'https:' && "
        "!window.__JB_HOST__) {",
        2,
    ),
]

# index.html -> host.html 的插入点
HTML_ANCHOR_CSS = '<link rel="stylesheet" href="app.css">'
HTML_ANCHOR_JS = '<script src="data.js"></script>'

# board.html 的插入点
# ⚠️ board.css 里 `html.embed { --k: 1 !important }` 必须压过 embed.css 的
#    `--k: var(--jb-k,1) !important` —— 同优先级下后者会赢，所以 embed.css
#    必须排在 board.css **之后**。写反了浮层会按宿主的 k 缩放，整个版式错位。
BOARD_ANCHOR_CSS = '<link rel="stylesheet" href="board.css">'
BOARD_ANCHOR_JS = '<script src="board.js"></script>'

# 榜单卡牌形象：源在 assets/board-cards/，站点由 serve.mjs 把 /cards/ 指过去；
# 扩展里没有服务器，必须把文件放进包内。原图 1024 方图，实际最大只用到
# 「详情大牌形象区 ≈356 宽」，缩到 640 肉眼无差，包体积省一半多。
CARDS_SRC = os.path.join(ROOT, "assets", "board-cards")
CARDS_DST = os.path.join(EXT, "cards")
CARDS_MAX = 640


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)


def main():
    log = []

    # ---- 1) 逐字节复制 ----
    # providers.js 也进这一组：它是「厂商表 + 协议适配」的唯一实现，
    # 站点用 <script src> 加载、扩展的 api.mjs 用 import 加载同一份文件。
    # board-core.mjs 同理：榜单内核只有一份，api.mjs 用 import 加载它。
    # board.css / board.js 无补丁 —— 浮层档位全靠 CSS 里的 html.embed，不靠改代码。
    for name in ("app.css", "data.js", "providers.js",
                 "board.css", "board.js", "board-core.mjs"):
        src, dst = os.path.join(SITE, name), os.path.join(EXT, name)
        shutil.copyfile(src, dst)
        log.append("copy  %-15s %d bytes" % (name, os.path.getsize(dst)))

    # ---- 2) app.js + 补丁 ----
    js = read(os.path.join(SITE, "app.js"))
    for desc, old, new, expect in PATCHES:
        n = js.count(old)
        if n != expect:
            print("ERROR 补丁失配：期望命中 %d 次，实际 %d 次\n  说明：%s\n  原文：%s"
                  % (expect, n, desc, old))
            sys.exit(1)
        js = js.replace(old, new)
        log.append("patch app.js   %s" % desc.split("。")[0])
    header = ("/* ⚠️ 本文件由 scripts/build_extension.py 从 site/app.js 生成，请勿直接改。\n"
              " * 与站点的差异只有下面这一处补丁：\n"
              " *   %s\n"
              " * 要改逻辑请改 site/app.js，然后重跑构建。 */\n"
              % PATCHES[0][0].split("。")[0])
    write(os.path.join(EXT, "app.js"), header + js)
    log.append("write app.js   %d bytes (含补丁头注释)" % os.path.getsize(os.path.join(EXT, "app.js")))

    # ---- 3) index.html -> host.html ----
    html = read(os.path.join(SITE, "index.html"))
    for anchor, ins, label in (
        (HTML_ANCHOR_CSS, HTML_ANCHOR_CSS + '\n<link rel="stylesheet" href="embed.css">', "embed.css"),
        (HTML_ANCHOR_JS,
         '<script src="embed-boot.js"></script>\n<script src="api-shim.js"></script>\n' + HTML_ANCHOR_JS,
         "embed-boot.js + api-shim.js"),
    ):
        if html.count(anchor) != 1:
            print("ERROR host.html 插入点失配：%s（命中 %d 次）" % (label, html.count(anchor)))
            sys.exit(1)
        html = html.replace(anchor, ins)
        log.append("inject host.html  %s（须早于 app.js，顺序不能反）" % label)

    title_old = "<title>沸点抽卡 · 翻一张牌，看掘金今天在聊什么</title>"
    if html.count(title_old) == 1:
        html = html.replace(title_old, "<title>沸点抽卡 · 悬浮在掘金上的牌面</title>")
        log.append("title  host.html  已改为扩展口径")

    html = html.replace("<!DOCTYPE html>", "<!DOCTYPE html>\n<!-- 本文件由 scripts/build_extension.py 从 site/index.html 生成，请勿直接改 -->", 1)
    write(os.path.join(EXT, "host.html"), html)
    log.append("write host.html %d bytes" % os.path.getsize(os.path.join(EXT, "host.html")))

    # ---- 3b) board.html ----
    # 与 host.html 同一套注入，只有两处不同：
    #   · 锚点是 board.css / board.js（榜单页不引 app.css / data.js）
    #   · embed.css 插在 board.css **之后**（理由见 BOARD_ANCHOR_CSS 上方注释）
    board = read(os.path.join(SITE, "board.html"))
    for anchor, ins, label in (
        (BOARD_ANCHOR_CSS, BOARD_ANCHOR_CSS + '\n<link rel="stylesheet" href="embed.css">',
         "embed.css（**必须**排在 board.css 之后）"),
        (BOARD_ANCHOR_JS,
         '<script src="embed-boot.js"></script>\n<script src="api-shim.js"></script>\n' + BOARD_ANCHOR_JS,
         "embed-boot.js + api-shim.js"),
    ):
        if board.count(anchor) != 1:
            print("ERROR board.html 插入点失配：%s（命中 %d 次）" % (label, board.count(anchor)))
            sys.exit(1)
        board = board.replace(anchor, ins)
        log.append("inject board.html  %s" % label)

    title_b_old = "<title>魔鬼榜单 · 掘金沸点六摞牌</title>"
    if board.count(title_b_old) == 1:
        board = board.replace(title_b_old, "<title>魔鬼榜单 · 悬浮在掘金上的六摞牌</title>")
        log.append("title  board.html 已改为扩展口径")

    board = board.replace("<!DOCTYPE html>", "<!DOCTYPE html>\n<!-- 本文件由 scripts/build_extension.py 从 site/board.html 生成，请勿直接改 -->", 1)
    write(os.path.join(EXT, "board.html"), board)
    log.append("write board.html %d bytes" % os.path.getsize(os.path.join(EXT, "board.html")))

    # ---- 4) 图标 ----
    # 图标由 scripts/build_icons.py 从 assets/logo-juejin-joker.jpg 现场生成，
    # 不再从 _bak/ 拷旧图 —— 否则换 logo 后一重建就被旧图标盖回去。
    try:
        import build_icons
        n = build_icons.build_all(verbose=False)
        log.append("icons  从 assets/logo-juejin-joker.jpg 生成 %d 个" % n)
        for f in sorted(os.listdir(os.path.join(EXT, "icons"))):
            p = os.path.join(EXT, "icons", f)
            log.append("  icons/%-9s %d bytes" % (f, os.path.getsize(p)))
    except Exception as e:
        log.append("ERROR icons 生成失败：%r" % (e,))
        raise

    # ---- 5) 榜单卡牌形象 → extension/cards/ ----
    # board.js 里写的是相对路径 `url(cards/xxx.png)`，站点由 serve.mjs 把 /cards/
    # 映射到 assets/board-cards/；扩展没有服务器，只能把文件放进包里。
    os.makedirs(CARDS_DST, exist_ok=True)
    n_cards, bytes_cards = 0, 0
    wanted = set(f for f in os.listdir(CARDS_SRC) if f.lower().endswith(".png"))
    # ⚠️ 必须清掉源目录里已经没有的图。这一步是踩过坑加的：v0.5.0 把
    #    `c1-*.png` 换成了 `face-*.png`，源目录删了、但构建只复制不清理，
    #    旧图就一直留在 extension/cards/ 里 —— check_extension.py 只查"有没有"、
    #    不查"多没多"，所以自检全绿却背着 6 张废图（约 600KB）。
    pruned = []
    for f in sorted(os.listdir(CARDS_DST)):
        if f.lower().endswith(".png") and f not in wanted:
            os.remove(os.path.join(CARDS_DST, f))
            pruned.append(f)
    for f in sorted(wanted):
        if not f.lower().endswith(".png"):
            continue
        dst = os.path.join(CARDS_DST, f)
        try:
            from PIL import Image
            im = Image.open(os.path.join(CARDS_SRC, f))
            if max(im.size) > CARDS_MAX:
                r = CARDS_MAX / float(max(im.size))
                im = im.resize((max(1, int(round(im.width * r))),
                                max(1, int(round(im.height * r)))), Image.LANCZOS)
            im.save(dst, "PNG", optimize=True)
        except Exception as e:
            # Pillow 不在也不该让构建挂掉：原样复制（只是包大一点）
            shutil.copyfile(os.path.join(CARDS_SRC, f), dst)
            log.append("  cards/%s 缩图失败(%r)，已原样复制" % (f, e))
        n_cards += 1
        bytes_cards += os.path.getsize(dst)
    log.append("cards  %d 张 → extension/cards/（长边 ≤ %d，共 %d bytes）"
               % (n_cards, CARDS_MAX, bytes_cards))
    if pruned:
        log.append("cards  清理孤儿图 %d 张：%s" % (len(pruned), ", ".join(pruned)))

    log.append("--- extension/ 现有文件 ---")
    for f in sorted(os.listdir(EXT)):
        p = os.path.join(EXT, f)
        log.append("  %9s  %s" % (os.path.getsize(p) if os.path.isfile(p) else "<dir>", f))

    out = "\n".join(log)
    write(os.path.join(ROOT, "output", "build_extension.log"), out)
    print(out)


if __name__ == "__main__":
    main()

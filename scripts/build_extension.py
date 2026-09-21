# -*- coding: utf-8 -*-
"""build_extension.py — 把 site/ 的前端原样同步进 extension/

设计原则：**extension 里不允许出现第二份手写的牌面实现**。
站点前端只有一份源头，扩展是它的宿主。所以这里做的是「复制 + 极小补丁」：

  1) app.css / data.js      —— 逐字节复制
  2) app.js                 —— 复制后打唯一一处补丁（见 PATCHES）
  3) index.html             —— 改名 host.html 并挂上 embed.css / embed-boot.js / api-shim.js

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
    for name in ("app.css", "data.js", "providers.js"):
        src, dst = os.path.join(SITE, name), os.path.join(EXT, name)
        shutil.copyfile(src, dst)
        log.append("copy  %-12s %d bytes" % (name, os.path.getsize(dst)))

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

    log.append("--- extension/ 现有文件 ---")
    for f in sorted(os.listdir(EXT)):
        p = os.path.join(EXT, f)
        log.append("  %9s  %s" % (os.path.getsize(p) if os.path.isfile(p) else "<dir>", f))

    out = "\n".join(log)
    write(os.path.join(ROOT, "output", "build_extension.log"), out)
    print(out)


if __name__ == "__main__":
    main()

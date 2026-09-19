# -*- coding: utf-8 -*-
"""生成 _preview_demo.html：把 app.html 塞进 iframe，贴在掘金风格的网页上，
模拟"右下角弹窗"的真实观感（沙盘演示，不产生任何网络请求）。
"""
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "previews", "_preview_demo.html")

DEMO = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>沸点抽卡 · 弹窗效果预览</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    color:#e9ecf1;background:#171a1f;min-height:100vh}
  .page{max-width:820px;margin:0 auto;padding:60px 40px 120px}
  .page h1{font-size:26px;font-weight:700;letter-spacing:-.3px;margin-bottom:8px}
  .page .by{color:#8d96a3;font-size:13px;margin-bottom:28px}
  .page p{color:#b8c0cc;margin-bottom:18px}
  .fake{background:#1e2228;border:1px solid #2c3138;border-radius:14px;padding:18px;margin-bottom:16px}
  .fake .u{color:#9aa3b0;font-size:12.5px;margin-bottom:8px}
  .fake .c{color:#cfd6e0;font-size:14px}
  .note{position:fixed;left:20px;bottom:20px;background:rgba(30,34,40,.9);
    border:1px solid #3a4048;border-radius:12px;padding:12px 16px;font-size:12.5px;color:#a9b2be;
    max-width:340px;line-height:1.7}
  .note b{color:#e9ecf1;display:block;margin-bottom:4px;font-size:13px}
  iframe{position:fixed;right:16px;bottom:16px;width:min(1180px,calc(100vw - 32px));
    height:min(700px,calc(100vh - 32px));border:none;z-index:9;
    filter:drop-shadow(0 24px 60px rgba(0,0,0,.6))}
  .hintbar{position:fixed;right:16px;top:16px;z-index:20;font-size:12px;color:#8d96a3}
</style></head>
<body>
<div class="page">
  <h1>前端周报：那些被写得越来越长的组件</h1>
  <div class="by">掘金 · 前端 · 12 分钟前</div>
  <p>这是一个占位网页，用来还原「牌面弹窗浮在网页上」的实际观感。真正的扩展会在当前页面上直接盖出这一层，不用来回切标签页。</p>
  <div class="fake"><div class="u">掘友 A</div><div class="c">内联样式改到第 400 行的时候，我意识到该抽个组件了。</div></div>
  <div class="fake"><div class="u">掘友 B</div><div class="c">我司的规矩是：能在一个文件里写完的，就别拆成三个。</div></div>
  <div class="fake"><div class="u">掘友 C</div><div class="c">重构的尽头是重写，重写的尽头是重构。</div></div>
  <div class="fake"><div class="u">掘友 D</div><div class="c">这周终于把 CI 从 18 分钟压到 4 分钟，老板问我为什么不早点做。</div></div>
  <div class="fake"><div class="u">掘友 E</div><div class="c">摸鱼摸到怀疑人生，然后发现全组都在摸。</div></div>
  <div class="fake"><div class="u">掘友 F</div><div class="c">写文档的时间够我改三个 bug 了——所以还是先改 bug 吧。</div></div>
  <div class="fake"><div class="u">掘友 G</div><div class="c">别人的开源项目：三个星期一个版本。我的：三个版本一个想法。</div></div>
</div>

<div class="note"><b>这是沙盘演示</b>右下角那块就是弹窗里的牌面（真实大小、真实样式）。实际扩展里它会直接盖在你正在看的掘金页面上。</div>
<iframe src="./_preview.html"></iframe>
</body></html>
"""

open(OUT, "w", encoding="utf-8").write(DEMO)
print("demo -> %s" % OUT)

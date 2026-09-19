# -*- coding: utf-8 -*-
"""_demo_site/ —— 一个仿真"掘金"页面 + 一个真正跑 frame.js 的测试台。

关键点：frame.js 里用到了 chrome.runtime.getURL / chrome.runtime.sendMessage，
所以测试台要注入一个假的 chrome 对象（在 file:// 下也能跑），
用来验证「注入 host -> Shadow DOM -> iframe -> 关掉」这条链路真的通。
"""
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(BASE, "_demo_site")
os.makedirs(SITE, exist_ok=True)

POSTS = [
    ("掘友 A", "内联样式改到第 400 行的时候，我意识到该抽个组件了。"),
    ("掘友 B", "我司的规矩是：能在一个文件里写完的，就别拆成三个。"),
    ("掘友 C", "重构的尽头是重写，重写的尽头是重构。"),
    ("掘友 D", "这周终于把 CI 从 18 分钟压到 4 分钟，老板问我为什么不早点做。"),
    ("掘友 E", "摸鱼摸到怀疑人生，然后发现全组都在摸。"),
    ("掘友 F", "写文档的时间够我改三个 bug 了——所以还是先改 bug 吧。"),
    ("掘友 G", "别人的开源项目：三个星期一个版本。我的：三个版本一个想法。"),
    ("掘友 H", "面试问我会不会手写 Promise，我说我连 Promise 都懒得写。"),
    ("掘友 I", "把 if-else 换成策略模式之后，我现在有 12 个文件了。"),
]

cards = "\n".join(
    '  <div class="p"><div class="u">%s</div><div class="c">%s</div>'
    '<div class="m"><span>♥ %d</span><span>评论 %d</span><span>2 小时前</span></div></div>'
    % (u, c, 8 + i * 3, i * 2)
    for i, (u, c) in enumerate(POSTS))

SITE_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>沸点 - 掘金（仿真页）</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    color:#e9ecf1;background:#171a1f}
  .nav{position:sticky;top:0;background:#1b1f25;border-bottom:1px solid #2b3038;padding:14px 28px;
    display:flex;align-items:center;gap:18px;font-size:14px;color:#9aa3b0;z-index:5}
  .nav b{color:#e9ecf1;font-size:16px}
  .nav .sp{flex:1}
  .page{max-width:760px;margin:0 auto;padding:32px 24px 140px}
  .bar{margin-bottom:22px;color:#7f8894;font-size:13px}
  .p{background:#1e2228;border:1px solid #2c3138;border-radius:14px;padding:18px 20px;margin-bottom:14px}
  .p .u{color:#9aa3b0;font-size:12.5px;margin-bottom:7px}
  .p .c{color:#d3dae4;font-size:14.5px;margin-bottom:12px}
  .p .m{display:flex;gap:20px;color:#727b87;font-size:12px}
  .tip{position:fixed;left:20px;bottom:20px;background:rgba(30,34,40,.94);border:1px solid #3a4048;
    border-radius:12px;padding:13px 17px;font-size:12.5px;color:#a9b2be;max-width:360px;line-height:1.7}
  .tip b{color:#e9ecf1;display:block;margin-bottom:5px;font-size:13px}
  .tip code{background:#262b32;padding:1px 6px;border-radius:5px;color:#e8a06a;font-size:11.5px}
</style></head>
<body>
<div class="nav"><b>掘金</b><span>首页</span><span>沸点</span><span>课程</span><span class="sp"></span><span>仿真页，非真实站点</span></div>
<div class="page">
  <div class="bar">沸点 · 最新</div>
__CARDS__
</div>
<div class="tip"><b>注入链路测试台</b>
点右上角那个橙色「加载牌面」按钮，等于模拟点扩展图标 —— frame.js 会真的注入，
牌面真的盖上来。Esc 或牌上的 ✕ 关闭。</div>
</body></html>
"""

# 把 frame.js 的 chrome.* 调用换成能在 file:// 下工作的假实现，其余原样执行
SHIM = """<script>
window.chrome = {
  runtime: {
    getURL: function (p) { return './_frame_app.html'; },
    sendMessage: function (m, cb) {
      var out = { ok: true };
      if (m.type === 'inject') out = { ok: true };
      else if (m.type === 'getState') out = window.__ST__;
      else if (m.type === 'pinComments') out = { err_no: 0, data: [] };
      else if (m.type === 'refresh') out = { ok: true, added: 0 };
      else if (m.type === 'roast') out = { ok: true, roast: (window.__ST__.roasts || {})[m.id] };
      setTimeout(function () { if (cb) cb(out); }, 10);
    }
  },
  storage: { local: { get: function (k, cb) { cb({}); }, set: function (k, cb) { if (cb) cb(); } } }
};
</script>
"""

open(os.path.join(SITE, "index.html"), "w", encoding="utf-8").write(
    SITE_HTML.replace("__CARDS__", cards))
print("site -> %s" % os.path.join(SITE, "index.html"))

# -*- coding: utf-8 -*-
"""把 frame.js 原样搬进测试台，并配一个能跑的 _frame_app.html（牌面 + 假 chrome）。

用途：在 file:// 下真实走一遍「frame.js 注入 -> Shadow DOM -> iframe 牌面 -> 关闭」。
frame.js 除了 chrome.* 之外一行不改，改的只是宿主页面提供的 shim。
"""
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(BASE, "_demo_site")
EXT = os.path.join(BASE, "extension")

pins = open(os.path.join(BASE, "data", "pins_raw_0917.json"), encoding="utf-8").read()
cmts = __import__("json").loads(
    open(os.path.join(BASE, "data", "comments_0917.json"), encoding="utf-8").read())["comments"]
plist = __import__("json").loads(pins)

# 关键：pins_raw_*.json 是「抓取脚本的原始形状」（user_name / digg_count / comment_count / job_title），
# 而 app.js 吃的是 background.js normalize() 之后的形状（user / digg / cmt / job）。
# 预览必须做同一层归一化，否则 rankOf() 算出 NaN、牌面直接不渲染。
def normalize(p):
    return {
        "id": str(p.get("id") or ""),
        "content": p.get("content") or "",
        "topics": p.get("topics") or [],
        "ctime": int(p.get("ctime") or 0),
        "digg": int(p.get("digg_count") or 0),
        "cmt": int(p.get("comment_count") or 0),
        "user": p.get("user_name") or "掘友",
        "company": p.get("company") or "",
        "job": p.get("job_title") or "",
        "avatar": p.get("avatar") or "",
        "pics": p.get("pics") or [],
        "url": p.get("url") or ("https://juejin.cn/pin/" + str(p.get("id") or "")),
    }

plist = [normalize(x) for x in plist]

roasts = {}
for p, c in zip(plist, cmts):
    roasts[p["id"]] = {"roasts": [
        {"persona": "毒舌", "text": c},
        {"persona": "冷幽默", "text": c},
        {"persona": "工科直男", "text": c}],
        "tags": ["摸鱼", "职场"], "at": 1789628000000, "model": "deepseek-chat"}

state = {"pins": plist, "roasts": roasts,
         "cfg": {"aiProvider": "openai", "autoFetch": True, "everyMinutes": 15},
         "meta": {"lastAdded": 6, "lastOk": 1789628000000},
         "seen": [], "defaultCfg": {}, "softKeywords": []}

# 1) _frame_app.html：app.html + 假 chrome（让牌面在 file:// 下也能取到数据）
html = open(os.path.join(EXT, "app.html"), encoding="utf-8").read()
css = open(os.path.join(EXT, "app.css"), encoding="utf-8").read()
js = open(os.path.join(EXT, "app.js"), encoding="utf-8").read()

mock = """
window.__ERR__ = [];
window.addEventListener('error', function (e) {
  window.__ERR__.push('ERR: ' + (e.message || '') + ' @' + (e.lineno || '?'));
  document.title = 'APPERR::' + window.__ERR__.join(' ;; ');
});
window.addEventListener('unhandledrejection', function (e) {
  window.__ERR__.push('REJ: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
  document.title = 'APPERR::' + window.__ERR__.join(' ;; ');
});
window.__ST__ = %s;
window.chrome = {
  runtime: {
    lastError: null,
    sendMessage: function (msg, cb) {
      var ST = window.__ST__; var out = { ok: true };
      if (msg.type === 'getState') out = Object.assign({ ok: true }, ST);
      else if (msg.type === 'refresh') out = { ok: true, added: 0 };
      else if (msg.type === 'markSeen') out = { ok: true };
      else if (msg.type === 'roast') out = { ok: true, roast: ST.roasts[msg.id] };
      else if (msg.type === 'pinComments') out = { err_no: 0, data: [] };
      setTimeout(function () { cb(out); }, 20);
    }
  },
  storage: { local: { get: function (k, cb) { cb({}); }, set: function () {} } }
};
""" % __import__("json").dumps(state, ensure_ascii=False).replace("</", "<\\/")

html = html.replace('<link rel="stylesheet" href="app.css">', "<style>\n" + css + "\n</style>")
html = html.replace('<script src="app.js"></script>', "<script>\n" + mock + "\n" + js + "\n</script>")
# 测试台里永远按「被注入」的样子跑
html = html.replace('</head>', "<script>history.replaceState(0,'','?embed=1');</script></head>")
open(os.path.join(SITE, "_frame_app.html"), "w", encoding="utf-8").write(html)

# 2) index.html 里插入 shim + 加载按钮 + frame.js 原文
site = open(os.path.join(SITE, "index.html"), encoding="utf-8").read()
frame = open(os.path.join(EXT, "frame.js"), encoding="utf-8").read()

shim = """<script>
window.chrome = {
  runtime: {
    getURL: function () { return './_frame_app.html?embed=1'; },
    sendMessage: function (m, cb) { setTimeout(function () { if (cb) cb({ ok: true }); }, 0); }
  },
  storage: { local: { get: function (k, cb) { cb({}); }, set: function () {} } }
};
</script>
"""

btn = """
<button id="__inject" style="position:fixed;right:20px;top:14px;z-index:99;background:#f2661a;color:#fff;
  border:none;border-radius:10px;padding:11px 20px;font-size:14px;font-weight:600;cursor:pointer;
  box-shadow:0 10px 26px -12px rgba(242,102,26,.95);font-family:inherit">加载牌面（模拟点扩展图标）</button>
<script>
document.getElementById('__inject').onclick = function () {
  var s = document.createElement('script');
  s.textContent = %s;
  document.body.appendChild(s);
};
</script>
""" % __import__("json").dumps(frame)

site = site.replace("</head>", shim + "</head>")
site = site.replace("</body>", btn + "</body>")
open(os.path.join(SITE, "index.html"), "w", encoding="utf-8").write(site)
print("frame app -> %s" % os.path.join(SITE, "_frame_app.html"))
print("site      -> %s" % os.path.join(SITE, "index.html"))

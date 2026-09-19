# -*- coding: utf-8 -*-
"""在本地把 app.html 用假数据跑一遍：注入 mock 的 chrome API + 数据，输出预览 HTML。
产物 _preview.html 直接读，用来肉眼确认牌面渲染。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pinshape import load, make_roasts   # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(BASE, "extension")

pins, cmts = load(BASE)
roasts = make_roasts(pins, cmts)

state = {
    "pins": pins, "roasts": roasts,
    "cfg": {"aiProvider": "openai", "autoFetch": True, "everyMinutes": 15},
    "meta": {"lastAdded": 6, "lastOk": 1789628000000},
    "seen": [], "defaultCfg": {}, "softKeywords": [],
}

html = open(os.path.join(EXT, "app.html"), encoding="utf-8").read()
css = open(os.path.join(EXT, "app.css"), encoding="utf-8").read()
js = open(os.path.join(EXT, "app.js"), encoding="utf-8").read()

mock = """
window.chrome = {
  runtime: {
    lastError: null,
    sendMessage: function (msg, cb) {
      var ST = %s;
      var out = { ok: true };
      if (msg.type === 'getState') out = Object.assign({ ok: true }, ST);
      else if (msg.type === 'refresh') out = { ok: true, added: 0 };
      else if (msg.type === 'markSeen') out = { ok: true };
      else if (msg.type === 'roast') out = { ok: true, roast: ST.roasts[msg.id] };
      else if (msg.type === 'pinComments') out = { err_no: 0, data: [] };
      else out = { ok: true };
      setTimeout(function () { cb(out); }, 20);
    }
  },
  storage: { local: { get: function (k, cb) { cb({}); }, set: function () {} } }
};
""" % json.dumps(state, ensure_ascii=False).replace("</", "<\\/")

html = html.replace('<link rel="stylesheet" href="app.css">', "<style>\n" + css + "\n</style>")
html = html.replace('<script src="app.js"></script>', "<script>\n" + mock + "\n" + js + "\n</script>")

out = os.path.join(BASE, "previews", "_preview.html")
open(out, "w", encoding="utf-8").write(html)
print("preview -> %s (%d KB)" % (out, len(html) // 1024))

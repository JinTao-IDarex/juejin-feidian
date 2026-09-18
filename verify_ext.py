# -*- coding: utf-8 -*-
"""校验扩展：JS 语法、JSON 有效性、HTML 中的 id 引用与消息类型一致性。"""
import json
import os
import re
import subprocess

EXT = r"D:\2workspace\codex\juejin-boom\extension"
NODE = r"C:\Users\apple\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
out = []

for f in ("background.js", "popup.js", "options.js", "app.js", "frame.js"):
    r = subprocess.run([NODE, "--check", os.path.join(EXT, f)], capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    out.append("check %-14s exit=%d %s" % (f, r.returncode, r.stderr.strip()[:400]))

try:
    m = json.load(open(os.path.join(EXT, "manifest.json"), encoding="utf-8"))
    out.append("manifest.json OK mv%d perms=%s" % (m["manifest_version"], m["permissions"]))
    for s in m["icons"].values():
        if not os.path.exists(os.path.join(EXT, s)):
            out.append("MISSING ICON %s" % s)
    # content_scripts / web_accessible_resources 里引用的文件必须真实存在
    for cs in m.get("content_scripts", []):
        for f in cs.get("js", []) + cs.get("css", []):
            if not os.path.exists(os.path.join(EXT, f)):
                out.append("MISSING content_script file: %s" % f)
    for war in m.get("web_accessible_resources", []):
        for f in war.get("resources", []):
            if not os.path.exists(os.path.join(EXT, f)):
                out.append("MISSING web_accessible_resource: %s" % f)
    out.append("content_scripts: %s" % [c.get("js") for c in m.get("content_scripts", [])])
    out.append("commands: %s" % list(m.get("commands", {}).keys()))
except Exception as e:
    out.append("manifest.json FAIL %s" % e)

html = open(os.path.join(EXT, "popup.html"), encoding="utf-8").read()
ids = set(re.findall(r'id="([^"]+)"', html))
js = open(os.path.join(EXT, "popup.js"), encoding="utf-8").read()
appjs = open(os.path.join(EXT, "app.js"), encoding="utf-8").read()
used = set(re.findall(r"\$\('#([A-Za-z0-9_]+)'\)", js))
# 这些是 JS 动态插入的，不算缺失
dynamic = {"btnGen", "btnCopyRoast", "btnUseRoast", "btnBatch", "pics"}
missing = sorted(u for u in used - dynamic if u not in ids)
out.append("popup: html ids=%d referenced=%d" % (len(ids), len(used)))
out.append("popup MISSING ids: %s" % (missing or "none"))

# 整页 app
ahtml = open(os.path.join(EXT, "app.html"), encoding="utf-8").read()
aids = set(re.findall(r'id="([^"]+)"', ahtml))
aused = set(re.findall(r"\$\('#([A-Za-z0-9_]+)'\)", appjs))
adyn = {"btnGen", "btnCopyRoast", "btnUseRoast", "btnBatch", "pLink", "aiHost"}
amissing = sorted(u for u in aused - adyn if u not in aids)
out.append("app: html ids=%d referenced=%d" % (len(aids), len(aused)))
out.append("app MISSING ids: %s" % (amissing or "none"))
out.append("app created ids: %s" % sorted(set(re.findall(r'id="([A-Za-z0-9_]+)"', appjs))))

# --- HTML 注释陷阱：注释里出现 "*/" 会吞掉后面整块 DOM ---
# 真实踩过：app.html 的 <!-- ... 关 */ 少了 "--"，把整个 .hud 区块当成注释吃掉了，
# 于是 #btnRefresh 等全都不存在，bind() 第一行就 TypeError，页面永远停在占位状态。
# 正则抓 id 抓不到这种问题（源码里有、解析后没有），必须用解析器还原真实 DOM。
import html.parser


class _P(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if d.get("id"):
            self.ids.append(d["id"])


for name in ("app.html", "popup.html", "options.html"):
    src = open(os.path.join(EXT, name), encoding="utf-8").read()
    p = _P()
    p.feed(src)
    src_ids = set(re.findall(r'id="([^"]+)"', src))
    parsed_ids = set(p.ids)
    eaten = sorted(src_ids - parsed_ids)
    out.append("%s parsed ids=%d source ids=%d" % (name, len(parsed_ids), len(src_ids)))
    if eaten:
        out.append("  !! COMMENT-EATEN ids (%s): %s" % (name, eaten))
    # 未闭合的注释（以 */ 收尾而不是 -->）
    bad = re.findall(r"<!--(?:(?!-->).)*?\*/(?:(?!-->).)*?-->", src, re.S)
    if bad:
        out.append("  !! comment closed with */ : %s" % [b[:50] for b in bad])
    # 完全未闭合的注释
    if src.count("<!--") != src.count("-->"):
        out.append("  !! unbalanced comments in %s: <!--=%d -->=%d"
                   % (name, src.count("<!--"), src.count("-->")))

ohtml = open(os.path.join(EXT, "options.html"), encoding="utf-8").read()
oids = set(re.findall(r'id="([^"]+)"', ohtml))
ojs = open(os.path.join(EXT, "options.js"), encoding="utf-8").read()
oused = set(re.findall(r"\$\('#([A-Za-z0-9_]+)'\)", ojs))
out.append("options MISSING ids: %s" % (sorted(u for u in oused if u not in oids) or "none"))

bg = open(os.path.join(EXT, "background.js"), encoding="utf-8").read()
fjs = open(os.path.join(EXT, "frame.js"), encoding="utf-8").read()
block = bg.split("const handlers = {")[1]
# 取到 "};" 之前
depth = 0
end = len(block)
for i, ch in enumerate(block):
    if ch == "{":
        depth += 1
    elif ch == "}":
        if depth == 0:
            end = i
            break
        depth -= 1
bh = set(re.findall(r"^\s{2}(\w+):", block[:end], re.M))
sent = set(re.findall(r"type: '(\w+)'", js)) | set(re.findall(r"type: '(\w+)'", ojs)) \
    | set(re.findall(r"type: '(\w+)'", appjs)) | set(re.findall(r"type: '(\w+)'", fjs))
# postMessage 用的 type 不是后台消息，别混进来
pm = set(re.findall(r"type: '([\w-]+)'", fjs + appjs)) - sent - {'pin-gacha-close', 'pin-gacha-open-link'}
out.append("bg handlers: %s" % sorted(bh))
out.append("sent: %s" % sorted(sent))
out.append("sent w/o handler: %s" % (sorted(sent - bh) or "none"))
out.append("handler w/o sender: %s" % (sorted(bh - sent) or "none"))

# frame.js 与 app.js 之间的 postMessage 协议必须对得上
post_types = set(re.findall(r"type: '(pin-gacha-[\w-]+)'", fjs + appjs))
host_sends = set(re.findall(r"type: '(pin-gacha-[\w-]+)'", fjs))       # 宿主发出的
frame_sends = set(re.findall(r"type: '(pin-gacha-[\w-]+)'", appjs))    # 牌层发出的
out.append("postMessage all: %s" % sorted(post_types))
out.append("host emits w/o frame listener: %s" % (sorted(host_sends - frame_sends) or "none"))
out.append("frame emits w/o host listener: %s" % (sorted(frame_sends - host_sends) or "none"))
# token 机制：两边都得有
out.append("token handshake: frame=%s app=%s" % ('t=' in fjs, "get('t')" in appjs))

# 重复声明的粗检
for name in ("hero", "card", "body", "st", "ps", "acts", "o", "r"):
    n = len(re.findall(r"\bconst %s\b" % name, js))
    if n > 3:
        out.append("WARN popup.js has %d 'const %s'" % (n, name))

# 检查 popup.js 中所有 DOM id 引用是否与 html 一致（含模板字符串里的）
tpl = set(re.findall(r"id=\"([A-Za-z0-9_]+)\"", js))
out.append("ids created by JS: %s" % sorted(tpl))

open(r"D:\2workspace\codex\juejin-boom\_verify.txt", "w", encoding="utf-8").write("\n".join(out))
print("done")

# -*- coding: utf-8 -*-
"""check_extension.py — 扩展包的静态自检（不启动浏览器）

本机没法给 Chrome 加载未打包扩展（agent-browser 起不了 --load-extension），
所以 chrome.* 那几行胶水代码只能靠静态检查兜。这里做四件事：

  1) manifest.json 能解析，且它引用的每个文件都真实存在
  2) 每个 JS 语法可用（node --check；ESM 的复制成 .mjs 再 check）
  3) host.html 的注入顺序正确（embed.css 在 app.css 后；两个脚本必须早于 app.js）
  4) 构建补丁确实打上了（__JB_HOST__ 出现次数）

用法：  python scripts/check_extension.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = r"D:\2workspace\codex\juejin-boom"
EXT = os.path.join(ROOT, "extension")
NODE = r"C:\Users\apple\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

problems = []
notes = []


def need(rel, why):
    p = os.path.join(EXT, rel)
    if not os.path.exists(p):
        problems.append("缺失文件 %s（%s）" % (rel, why))
        return None
    return p


# ---------------- 1) manifest ----------------
mf = need("manifest.json", "扩展清单")
man = None
if mf:
    try:
        man = json.load(open(mf, encoding="utf-8"))
        notes.append("manifest 解析通过：name=%s version=%s" % (man.get("name"), man.get("version")))
    except Exception as e:
        problems.append("manifest.json 不是合法 JSON：%r" % (e,))

if man:
    for k, v in (man.get("icons") or {}).items():
        need(v, "图标 %s" % k)
    for cs in man.get("content_scripts", []):
        for f in cs.get("js", []):
            need(f, "content_scripts")
    bg = (man.get("background") or {}).get("service_worker")
    if bg:
        need(bg, "background service_worker")
    for war in man.get("web_accessible_resources", []):
        for r in war.get("resources", []):
            if "*" in r:
                base = r.split("*")[0].rstrip("/")
                if base and not os.path.isdir(os.path.join(EXT, base)):
                    problems.append("web_accessible_resources 通配目录不存在：%s" % r)
            else:
                need(r, "web_accessible_resources")
    notes.append("manifest 引用的文件全部存在")

# ---------------- 2) JS 语法 ----------------
tmpdir = tempfile.mkdtemp(prefix="jbchk_")
for name in ("content.js", "api-shim.js", "embed-boot.js", "background.js", "api.mjs"):
    src = os.path.join(EXT, name)
    if not os.path.exists(src):
        problems.append("缺失文件 %s" % name)
        continue
    # .js 里带 import/export 的按 ESM 解析（extension/ 下没有 package.json）
    text = open(src, encoding="utf-8").read()
    is_esm = re.search(r"^\s*(import|export)\s", text, re.M) is not None
    if is_esm and name.endswith(".mjs"):
        target = src
    elif is_esm:
        target = os.path.join(tmpdir, name.replace(".js", ".mjs"))
        shutil.copyfile(src, target)
    else:
        target = src
    r = subprocess.run([NODE, "--check", target], capture_output=True, text=True)
    if r.returncode != 0:
        problems.append("语法错误 %s：%s" % (name, (r.stderr or "").strip().splitlines()[:3]))
    else:
        notes.append("语法通过 %-14s %s" % (name, "ESM" if is_esm else "CJS"))

# ---------------- 3) host.html 注入顺序 ----------------
host = need("host.html", "扩展页面")
if host:
    h = open(host, encoding="utf-8").read()
    order = ["app.css", "embed.css", "embed-boot.js", "api-shim.js", "data.js", "app.js"]
    pos = {}
    for name in order:
        # 必须按标签找，不能按裸文件名找：host.html 第 175 行的注释里就出现过
        # "卡牌由 app.js 按 STYLES 预设生成"，按裸名找会把注释位置当成脚本位置，
        # 从而误判成「data.js 排在 app.js 后面」。
        tag = ('src="%s"' % name) if name.endswith(".js") else ('href="%s"' % name)
        i = h.find(tag)
        pos[name] = i
        if i < 0:
            problems.append("host.html 里找不到 %s" % tag)
    if all(pos[n] >= 0 for n in order):
        if not (pos["app.css"] < pos["embed.css"]):
            problems.append("embed.css 必须在 app.css 之后（靠层叠覆盖）")
        for must_early in ("embed-boot.js", "api-shim.js"):
            if not (pos[must_early] < pos["data.js"] < pos["app.js"]):
                problems.append("%s 必须早于 data.js / app.js" % must_early)
        notes.append("host.html 注入顺序正确：" + " < ".join(order))

# ---------------- 4) 补丁 ----------------
aj = os.path.join(EXT, "app.js")
if os.path.exists(aj):
    a = open(aj, encoding="utf-8").read()
    n = a.count("__JB_HOST__")
    if n != 3:
        problems.append("app.js 的 __JB_HOST__ 应出现 3 次（boot + refreshDeck + isExtHost），实际 %d 次" % n)
    else:
        notes.append("app.js 补丁正确：__JB_HOST__ 3 处（boot 实时拉取闸门 + refreshDeck 洗牌闸门 + isExtHost 登录探测）")
    if "build_extension.py" in a[:400]:
        notes.append("app.js 带「由构建生成」头注释")
    else:
        problems.append("app.js 缺「由构建生成」头注释，可能是被直接改过")

# ---------------- 汇总 ----------------
print("\n".join(notes))
print("")
if problems:
    print("发现问题 %d 个：" % len(problems))
    for p in problems:
        print("  ✗ " + p)
    shutil.rmtree(tmpdir, ignore_errors=True)
    sys.exit(1)
print("全部通过 ✓")
shutil.rmtree(tmpdir, ignore_errors=True)

# -*- coding: utf-8 -*-
"""pack.py — 打包 extension/ 为可分发的 zip，并做一次最终校验。

和 check_extension.py 的区别：check 只做事前静态检查；pack 在打包前再跑一遍
同样的检查（避免把半坏的包发出去），然后把 extension/ 整个目录压成 zip。

用法：  python scripts/pack.py
产物：  dist/juejin-pin-gacha-extension.zip
报告：  output/ext-pack.txt
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(BASE, "extension")
OUT = os.path.join(BASE, "dist", "juejin-pin-gacha-extension.zip")
REPORT = os.path.join(BASE, "output", "ext-pack.txt")
NODE = r"C:\Users\apple\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

# 扩展里的 JS：手写的那几个 + 由构建生成、带补丁的 app.js
JS_FILES = ("content.js", "api-shim.js", "embed-boot.js", "background.js",
            "api.mjs", "app.js")

report = []
problems = []


def line(s):
    report.append(s)


# ---------------- 1) JS 语法 ----------------
tmpdir = tempfile.mkdtemp(prefix="jbpack_")
for name in JS_FILES:
    src = os.path.join(EXT, name)
    if not os.path.exists(src):
        problems.append("缺失文件 %s" % name)
        continue
    # content.js / api-shim.js / embed-boot.js 是经典脚本（CJS 解析即可）；
    # background.js / api.mjs 是 ESM，app.js 是经典脚本。extension/ 下没有
    # package.json，所以 .js 里的 import/export 会被 node 按 CJS 报错 —— 判到
    # 顶层 import/export 就复制成 .mjs 再 check。
    text = open(src, encoding="utf-8").read()
    is_esm = re.search(r"^\s*(import|export)\s", text, re.M) is not None
    if is_esm and name.endswith(".mjs"):
        target = src
    elif is_esm:
        target = os.path.join(tmpdir, name.replace(".js", ".mjs"))
        shutil.copyfile(src, target)
    else:
        target = src
    r = subprocess.run([NODE, "--check", target], capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        problems.append("语法错误 %s：%s" % (name, (r.stderr or "").strip()[:200]))
    line("js %-14s %-4s ok" % (name, "ESM" if is_esm else "CJS"))
shutil.rmtree(tmpdir, ignore_errors=True)

# ---------------- 2) 清单 ----------------
man = json.load(open(os.path.join(EXT, "manifest.json"), encoding="utf-8"))
line("manifest mv%d  name=%s  version=%s" % (
    man["manifest_version"], man["name"], man["version"]))
for size, rel in sorted((man.get("icons") or {}).items(), key=lambda kv: int(kv[0])):
    p = os.path.join(EXT, rel)
    if not os.path.exists(p):
        problems.append("图标缺失 %s" % rel)
    line("  icon %-4s %-16s %s" % (size, rel,
                                   ("%d B" % os.path.getsize(p)) if os.path.exists(p) else "MISSING"))

# ---------------- 3) 补丁 ----------------
adot = os.path.join(EXT, "app.js")
if os.path.exists(adot):
    n = open(adot, encoding="utf-8").read().count("__JB_HOST__")
    if n != 2:
        problems.append("app.js 的 __JB_HOST__ 应为 2 处（boot + refreshDeck），实际 %d" % n)
    line("patch __JB_HOST__ x%d" % n)

# ---------------- 4) 打包 ----------------
os.makedirs(os.path.dirname(OUT), exist_ok=True)
if os.path.exists(OUT):
    os.remove(OUT)
files = []
for root, dirs, names in os.walk(EXT):
    dirs[:] = [d for d in dirs if not d.startswith(".")]
    for n in sorted(names):
        if n.endswith((".zip", ".psd", ".md")):
            continue  # README 是给人看的，不进可分发包
        full = os.path.join(root, n)
        files.append((full, os.path.relpath(full, EXT).replace("\\", "/")))
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for full, rel in files:
        z.write(full, rel)
line("zip %s  entries=%d  size=%d KB" % (os.path.basename(OUT), len(files),
                                         os.path.getsize(OUT) // 1024))
line("entries: " + ", ".join(rel for _, rel in files))

# ---------------- 汇总 ----------------
os.makedirs(os.path.dirname(REPORT), exist_ok=True)
if problems:
    line("")
    line("问题 %d 个：" % len(problems))
    for p in problems:
        line("  x " + p)
else:
    line("")
    line("全部通过 OK")
open(REPORT, "w", encoding="utf-8").write("\n".join(report))
print("-> %s" % REPORT)
sys.exit(1 if problems else 0)

# -*- coding: utf-8 -*-
"""打包扩展目录为 zip，并做最终校验。"""
import json
import os
import subprocess
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(BASE, "extension")
OUT = os.path.join(BASE, "dist", "juejin-pin-gacha-extension.zip")
NODE = r"C:\Users\apple\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

report = []

# 1. JS 语法
for f in ("background.js", "popup.js", "options.js", "app.js"):
    r = subprocess.run([NODE, "--check", os.path.join(EXT, f)], capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    report.append("js %-14s exit=%d %s" % (f, r.returncode, r.stderr.strip()[:200]))

# 2. 清单
m = json.load(open(os.path.join(EXT, "manifest.json"), encoding="utf-8"))
report.append("manifest mv%d name=%s" % (m["manifest_version"], m["name"]))
for s in m["icons"].values():
    p = os.path.join(EXT, s)
    report.append("  %s %s bytes" % (s, os.path.getsize(p) if os.path.exists(p) else "MISSING"))

# 3. 打包
if os.path.exists(OUT):
    os.remove(OUT)
files = []
for root, dirs, names in os.walk(EXT):
    dirs[:] = [d for d in dirs if not d.startswith(".")]
    for n in sorted(names):
        if n.endswith((".zip", ".psd")):
            continue
        full = os.path.join(root, n)
        files.append((full, os.path.relpath(full, EXT).replace("\\", "/")))
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for full, rel in files:
        z.write(full, rel)
report.append("zip %s entries=%d size=%d KB" % (os.path.basename(OUT), len(files),
                                                os.path.getsize(OUT) // 1024))
report.append("entries: " + ", ".join(rel for _, rel in files))

open(os.path.join(BASE, "_pack.txt"), "w", encoding="utf-8").write("\n".join(report))
print("done")

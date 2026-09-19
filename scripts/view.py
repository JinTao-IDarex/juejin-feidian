# -*- coding: utf-8 -*-
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

day = sys.argv[1]
items = json.load(open(os.path.join(DATA, "pins_raw_%s.json" % day), encoding="utf-8"))
lines = []
for i, it in enumerate(items):
    c = (it.get("content") or "").replace("\n", " / ")
    lines.append("%d. [%s|%s|%s] %s" % (i + 1, it.get("user_name"), it.get("company"),
                                        it.get("job_title"), c[:300]))
    if it.get("topics"):
        lines.append("   话题: %s" % " ".join(it["topics"]))
    if it.get("hot_comments"):
        lines.append("   热评: " + " || ".join("%s: %s" % (h["name"], h["content"][:60])
                                               for h in it["hot_comments"]))
out = "\n".join(lines)
out_path = os.path.join(DATA, "_view.txt")
open(out_path, "w", encoding="utf-8").write(out)
print("n=%d -> %s" % (len(items), out_path))

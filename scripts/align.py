# -*- coding: utf-8 -*-
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

day = sys.argv[1]
pins = json.load(open(os.path.join(DATA, "pins_raw_%s.json" % day), encoding="utf-8"))
cmts = json.load(open(os.path.join(DATA, "comments_%s.json" % day), encoding="utf-8"))["comments"]
assert len(pins) == len(cmts), "COUNT MISMATCH pins=%d comments=%d" % (len(pins), len(cmts))
lines = ["%2d| %-22s || %s" % (i + 1, pins[i]["content"][:20].replace("\n", " "),
                               cmts[i][:20]) for i in range(len(cmts))]
out = os.path.join(DATA, "align.txt")
open(out, "w", encoding="utf-8").write("\n".join(lines))
print("OK %d" % len(cmts))

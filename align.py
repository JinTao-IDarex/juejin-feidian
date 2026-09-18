# -*- coding: utf-8 -*-
import json
import sys

day = sys.argv[1]
pins = json.load(open("pins_raw_%s.json" % day, encoding="utf-8"))
cmts = json.load(open("comments_%s.json" % day, encoding="utf-8"))["comments"]
assert len(pins) == len(cmts), "COUNT MISMATCH pins=%d comments=%d" % (len(pins), len(cmts))
lines = ["%2d| %-22s || %s" % (i + 1, pins[i]["content"][:20].replace("\n", " "),
                               cmts[i][:20]) for i in range(len(cmts))]
open("align.txt", "w", encoding="utf-8").write("\n".join(lines))
print("OK %d" % len(cmts))

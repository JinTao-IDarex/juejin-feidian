# -*- coding: utf-8 -*-
"""把 pins_raw_0917.json + comments_0917.json 归一化后写成 site/data.js。

用法：
    python build_data.py

输出形状（与 pinshape.py:normalize 一致）：
    id / content / topic / ctime(int) / digg / cmt / user / company / job / avatar / url / roast
"""
import json
import os

from pinshape import load

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAY = "0917"
OUT = os.path.join(BASE, "site", "data.js")


def main():
    pins, cmts = load(os.path.join(BASE, "data"), DAY)
    for p, c in zip(pins, cmts):
        p.pop("topics", None)
        p.pop("pics", None)
        p["topic"] = p.get("topic") or "沸点"
        p["roast"] = c

    payload = {
        "day": DAY,
        "date": "2026-09-17",
        "pins": pins,
    }

    body = json.dumps(payload, ensure_ascii=False, indent=1)

    # json.dumps 的缩进是空格，转成更省体积的写法
    header = (
        "/* data.js — 牌面数据\n"
        " * 由 pins_raw_%s.json + comments_%s.json 归一化生成（见 build_data.py）\n"
        " * 形状与 pinshape.py 的 normalize() 保持一致：\n"
        " *   id / content / topic / ctime(int) / digg / cmt / user / company / job / avatar / url / roast\n"
        " * 不做任何网络请求，纯本地数据。\n"
        " */\n"
        "window.PINS_DATA = " % (DAY, DAY)
    )

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(header)
        f.write(body)
        f.write(";\n")

    print("wrote %s  pins=%d  bytes=%d" % (OUT, len(pins), os.path.getsize(OUT)))


if __name__ == "__main__":
    main()

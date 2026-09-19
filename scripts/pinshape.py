# -*- coding: utf-8 -*-
"""与 extension/background.js 的 normalize() 保持一致的归一化。

pins_raw_*.json 是抓取脚本的「原始形状」：
    user_name / company / job_title / digg_count / comment_count / ctime(str)
extension 里 app.js 吃的是 normalize() 之后的形状：
    user / company / job / digg / cmt / ctime(int)

预览脚本必须做同一层转换，否则 rankOf() 会算出 NaN、牌面直接不渲染。
（这个坑真实踩过：_frame_app.html 里 .stage 一直停在占位状态。）
"""
import json
import os


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


def load(base, day="0917"):
    """读取并归一化一天的沸点 + 手写点评。"""
    pins = json.load(open(os.path.join(base, "pins_raw_%s.json" % day), encoding="utf-8"))
    cmts = json.load(open(os.path.join(base, "comments_%s.json" % day), encoding="utf-8"))["comments"]
    return [normalize(x) for x in pins], cmts


def make_roasts(pins, cmts):
    """把一手写点评包装成 3 个性格版本（预览用）。"""
    out = {}
    for p, c in zip(pins, cmts):
        out[p["id"]] = {
            "roasts": [
                {"persona": "毒舌", "text": c},
                {"persona": "冷幽默", "text": c},
                {"persona": "工科直男", "text": c},
            ],
            "tags": ["摸鱼", "职场"],
            "at": 1789628000000,
            "model": "deepseek-chat",
        }
    return out

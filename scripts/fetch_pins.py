# -*- coding: utf-8 -*-
"""Fetch juejin.cn pins (short_msg) via the recommend API."""
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

API = "https://api.juejin.cn/recommend_api/v1/short_msg/recommend?aid=2608&spider=0"
HEADERS = {
    "content-type": "application/json",
    "origin": "https://juejin.cn",
    "referer": "https://juejin.cn",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}


def fetch(cursor="0", limit=20, sort_type=300):
    body = json.dumps({"id_type": 4, "sort_type": sort_type, "cursor": str(cursor),
                       "limit": limit}).encode("utf-8")
    req = urllib.request.Request(API, data=body, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def strip(s):
    s = re.sub(r"<[^>]+>", "", s or "")
    return s.replace("&nbsp;", " ").strip()


TOPIC_RE = re.compile(r"\[(\d+)#([^#\]]+)#\]")


def normalize(item):
    msg = item.get("msg_Info") or {}
    au = item.get("author_user_info") or {}
    topic = item.get("topic") or {}
    raw = msg.get("content") or ""
    pics = []
    for p in (msg.get("pic_list") or []):
        if isinstance(p, dict):
            pics.append(p.get("url") or p.get("pic_url") or "")
    hot = []
    hc = item.get("hot_comment")
    if isinstance(hc, dict):
        hc = [hc]
    elif not isinstance(hc, list):
        hc = []
    for c in hc[:3]:
        if isinstance(c, dict):
            cu = c.get("user_info") or {}
            hot.append({
                "name": cu.get("user_name") or "",
                "content": strip((c.get("comment_info") or {}).get("content")),
                "digg": (c.get("comment_info") or {}).get("digg_count") or 0,
            })
    topics = [m.group(2) for m in TOPIC_RE.finditer(raw)]
    content = strip(TOPIC_RE.sub("", raw))
    return {
        "id": msg.get("msg_id") or item.get("msg_id") or "",
        "content": content,
        "topics": topics,
        "topic": topic.get("title") or "",
        "ctime": msg.get("ctime"),
        "digg_count": msg.get("digg_count") or 0,
        "comment_count": msg.get("comment_count") or 0,
        "user_name": au.get("user_name") or "",
        "company": au.get("company") or "",
        "job_title": au.get("job_title") or "",
        "avatar": au.get("avatar_large") or "",
        "level": au.get("level") or 0,
        "pics": [p for p in pics if p],
        "hot_comments": hot,
        "url": "https://juejin.cn/pin/" + str(msg.get("msg_id") or ""),
    }


def main():
    day = sys.argv[1] if len(sys.argv) > 1 else time.strftime("%m%d")
    want = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    items, cursor, seen = [], "0", set()
    while len(items) < want:
        data = fetch(cursor, 20)
        if data.get("err_no") not in (0, None) and not data.get("data"):
            raise SystemExit("api error: %s" % json.dumps(data, ensure_ascii=False)[:300])
        lst = data.get("data") or []
        if not lst:
            break
        for it in lst:
            n = normalize(it)
            if not n["content"] or n["id"] in seen:
                continue
            seen.add(n["id"])
            items.append(n)
        cursor = data.get("cursor") or ""
        if not data.get("has_more") or not cursor:
            break
        time.sleep(0.6)
    items = items[:want]
    out = os.path.join(DATA, "pins_raw_%s.json" % day)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    print("saved %d -> %s" % (len(items), out))


if __name__ == "__main__":
    main()

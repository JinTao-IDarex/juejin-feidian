# -*- coding: utf-8 -*-
"""探测：recommend 流一路翻页，能覆盖多长的时间跨度？
日榜/周榜能不能成立，全看这个数。结果写 output/probe_range.txt。
"""
import json, os, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.juejin.cn/recommend_api/v1/short_msg/recommend?aid=2608&spider=0"
HEADERS = {
    "content-type": "application/json",
    "origin": "https://juejin.cn",
    "referer": "https://juejin.cn",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}


def page(cursor, limit=20, sort_type=300):
    body = json.dumps({"id_type": 4, "sort_type": sort_type,
                       "cursor": str(cursor), "limit": limit}).encode("utf-8")
    req = urllib.request.Request(API, data=body, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def run(sort_type, max_pages=25):
    cursor, seen, rows = "0", set(), []
    t0 = time.time()
    for i in range(max_pages):
        try:
            d = page(cursor, 20, sort_type)
        except Exception as e:
            return rows, "page %d error: %s" % (i, e), i
        lst = d.get("data") or []
        if not lst:
            return rows, "page %d empty data (err_no=%s)" % (i, d.get("err_no")), i
        new = 0
        for it in lst:
            m = it.get("msg_Info") or {}
            mid = str(m.get("msg_id") or "")
            if not mid or mid in seen:
                continue
            seen.add(mid)
            new += 1
            rows.append({
                "id": mid,
                "ctime": int(m.get("ctime") or 0),
                "digg": int(m.get("digg_count") or 0),
                "cmt": int(m.get("comment_count") or 0),
                "len": len((m.get("content") or "")),
            })
        cursor = d.get("cursor") or ""
        if not d.get("has_more") or not cursor or new == 0:
            return rows, "stop@page%d has_more=%s new=%d" % (i, d.get("has_more"), new), i + 1
        time.sleep(0.35)
    return rows, "hit max_pages=%d" % max_pages, max_pages


def fmt(rows, note, pages, sort_type):
    L = []
    L.append("=== sort_type=%d  pages=%d  %s ===" % (sort_type, pages, note))
    L.append("total=%d  cost=%.1fs" % (len(rows), 0))
    if rows:
        ct = [r["ctime"] for r in rows if r["ctime"]]
        lo, hi = min(ct), max(ct)
        span_h = (hi - lo) / 3600.0
        L.append("ctime 最早 %s" % time.strftime("%m-%d %H:%M", time.localtime(lo)))
        L.append("ctime 最晚 %s" % time.strftime("%m-%d %H:%M", time.localtime(hi)))
        L.append("跨度 = %.1f 小时 = %.2f 天" % (span_h, span_h / 24.0))
        L.append("现在   %s" % time.strftime("%m-%d %H:%M", time.localtime()))
        # 单调性检查：是否严格按 ctime 降序
        seq = [r["ctime"] for r in rows]
        desc = all(seq[i] >= seq[i + 1] for i in range(len(seq) - 1))
        L.append("ctime 严格降序 = %s  （降序才好用二分/早停）" % desc)
        # 热度分布
        d = sorted([r["digg"] for r in rows], reverse=True)
        L.append("digg top10 = %s" % d[:10])
        L.append("digg 中位 = %s   cmt top5 = %s" % (
            d[len(d) // 2], sorted([r["cmt"] for r in rows], reverse=True)[:5]))
    return "\n".join(L)


def main():
    out = []
    for st in (300, 200):
        t0 = time.time()
        rows, note, pages = run(st, max_pages=60)
        cost = time.time() - t0
        out.append(fmt(rows, note, pages, st).replace("cost=%.1fs" % 0, "cost=%.1fs" % cost))
        out.append("")
    p = os.path.join(ROOT, "output", "probe_range.txt")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print("saved -> " + p)


if __name__ == "__main__":
    main()

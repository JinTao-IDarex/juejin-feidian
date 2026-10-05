# -*- coding: utf-8 -*-
"""把魔鬼榜单打成一个**自包含的单文件 HTML**（双击即看，不需要 node / 服务）。

用法：
    python scripts/make_board_snapshot.py [输出路径]

原理：把 board.css / board.js / data/board/<range>.json / 12 张形象图（6 张封面牌面 + 6 张详情插画带）**全部内联**进一个 HTML，
再在 board.js 之前插一个 20 行的 fetch 垫片，把 `api/board?...` 直接答上内联数据。
其余部分（DOM、样式、交互）与线上完全同一份源码，没有第二套实现。

形象图在 board.js 里是 `background-image:url(cards/xx.png)`（相对路径），
单文件快照必须换成 data URI，否则双击打开只会看到没有角色的空白封面。
优先用扩展构建产物 `extension/cards/`（已被 build_extension.py 缩到长边 640）。

⚠️ 快照是**只读**的：
  - 「日榜 / 周榜」与「重新评分」需要服务端重跑，快照里隐藏（不然点了必报错）；
  - 数据是打进文件那一刻的 `data/board/` 缓存。
"""
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')
BOARD_DIR = os.path.join(ROOT, 'data', 'board')


def read(p):
    return io.open(p, encoding='utf-8').read()


# 与 board.js 的 CARD_CHAR / CARD_ART 对应
# ⚠️ 选择器用**整路径子串** `url(cards/<名>.png)`，不能用裸文件名子串：
#    `char-c1-vicious` 含 `c1-vicious`，裸子串会让两套图互相命中。
CARD_CHAR = {
    'venom': 'char-c1-vicious', 'absurd': 'char-c2-absurd', 'passive': 'char-c3-passive',
    'stubborn': 'char-c4-stubborn', 'blah': 'char-c5-blah', 'emo': 'char-c6-emo',
}
CARD_ART = {
    'venom': 'art-c1-vicious', 'absurd': 'art-c2-absurd', 'passive': 'art-c3-passive',
    'stubborn': 'art-c4-stubborn', 'blah': 'art-c5-blah', 'emo': 'art-c6-emo',
}


def figure_css():
    """把 12 张形象图内联成 data URI（封面角色 6 张 + 详情插画带 6 张）。"""
    import base64
    dirs = [os.path.join(ROOT, 'extension', 'cards'),
            os.path.join(ROOT, 'assets', 'board-cards')]
    rules, total, missing = [], 0, []
    for name in list(CARD_CHAR.values()) + list(CARD_ART.values()):
        for d in dirs:
            p = os.path.join(d, name + '.png')
            if os.path.exists(p):
                raw = open(p, 'rb').read()
                total += len(raw)
                rules.append('[style*="url(cards/%s.png)"] '
                             '{ background-image: url("data:image/png;base64,%s") !important; }'
                             % (name, base64.b64encode(raw).decode('ascii')))
                break
        else:
            missing.append(name)
    return '\n'.join(rules), total, missing


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'output', 'board-snapshot.html')

    html = read(os.path.join(SITE, 'board.html'))
    css = read(os.path.join(SITE, 'board.css'))
    js = read(os.path.join(SITE, 'board.js'))

    # 收集缓存：文件名形如 day-2026-09-24.json / week-2026-09-24.json
    data = {}
    if os.path.isdir(BOARD_DIR):
        for fn in sorted(os.listdir(BOARD_DIR)):
            if not fn.endswith('.json'):
                continue
            parts = fn[:-5].split('-', 1)          # ['day', '2026-09-24']
            if len(parts) != 2:
                continue
            data[parts[0]] = {'range': parts[0], 'at': parts[1],
                              'payload': json.loads(read(os.path.join(BOARD_DIR, fn)))}
    if not data:
        print('[X] data/board/ 里没有缓存，先跑一次站点版让服务端生成缓存')
        return 1

    # 默认展示哪一档：优先 day，否则任意一个
    default = 'day' if 'day' in data else sorted(data)[0]
    stamp = data[default]['at']
    picked = data[default]['payload'].get('generatedAt') or data[default]['payload'].get('savedAt')

    shim = """
<script>
/* ---- 快照垫片：把 api/board 直接答上内联数据 ---- */
window.__JB_SNAPSHOT__ = %(payload)s;
window.__JB_SNAPSHOT_RANGE__ = %(default)s;
(function () {
  var orig = window.fetch;
  window.fetch = function (url, init) {
    var u = String(url && url.url ? url.url : url);
    if (u.indexOf('api/board') === 0) {
      var q = u.indexOf('?') >= 0 ? u.slice(u.indexOf('?') + 1) : '';
      var m = /range=(\\w+)/.exec(q);
      var want = m ? m[1] : window.__JB_SNAPSHOT_RANGE__;
      var d = window.__JB_SNAPSHOT__[want] || window.__JB_SNAPSHOT__[window.__JB_SNAPSHOT_RANGE__];
      return Promise.resolve(new Response(JSON.stringify(d.payload),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (u.indexOf('api/') === 0) {
      return Promise.reject(new Error('snapshot: ' + u + ' 不可用（静态快照没有服务端）'));
    }
    return orig.apply(this, arguments);
  };
})();
</script>
""" % {
        'payload': json.dumps({k: {'range': v['range'], 'payload': v['payload']} for k, v in data.items()},
                              ensure_ascii=False),
        'default': json.dumps(default),
    }

    # 快照专有的收尾样式：只读提示 + 隐藏需要服务端的两个控件 + 内联形象图
    fig_rules, fig_bytes, fig_missing = figure_css()
    extra = """
<style>
  /* 只有快照才隐藏这两个 —— 它们都要服务端重跑（抓取 + AI 打分） */
  .seg, .bd-refresh { display: none !important; }
  .bd-snap {
    position: fixed; right: 16px; bottom: 16px; z-index: 99;
    padding: 6px 12px; border-radius: 999px;
    background: rgba(26, 29, 33, .82); color: #fff;
    font: 500 11px/1.4 Inter, 'Noto Sans SC', sans-serif; letter-spacing: .2px;
  }
  /* ---- 内联的 12 张形象图（原本是 url(cards/xx.png) 相对路径） ---- */
  %(fig)s
</style>
""" % {'fig': fig_rules}

    # 1) 内联 CSS：把 <link ... board.css> 换掉
    html = html.replace('<link rel="stylesheet" href="board.css">',
                        '<style>\n' + css + '\n</style>')
    # 2) 在内联 script 之前插垫片
    html = html.replace('<script src="board.js"></script>',
                        shim + '<script>\n' + js + '\n</script>')
    # 3) 收尾样式 + 只读角标
    html = html.replace('</body>', extra + '<div class="bd-snap">静态快照 · '
                        + stamp + ' · 只读</div>\n</body>')
    html = html.replace('<head>', '<head>\n<!-- 由 scripts/make_board_snapshot.py 生成，'
                        + '数据快照 %s（generatedAt=%s）；改版式请改 site/board.css|board.js 后重新生成 -->'
                        % (stamp, picked), 1)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    io.open(out, 'w', encoding='utf-8', newline='\n').write(html)

    print('written %s  (%.1f KB)' % (out, os.path.getsize(out) / 1024.0))
    print('  内联形象图 %d/12 张，%.0f KB 原图' % (12 - len(fig_missing), fig_bytes / 1024.0))
    if fig_missing:
        print('  [X] 缺图：%s（先跑 build_extension.py 生成 extension/cards/）' % ', '.join(fig_missing))
    for r, v in sorted(data.items()):
        tops = v['payload'].get('boards') or []
        n = sum(len(b.get('top') or []) for b in tops) if isinstance(tops, list) else 0
        print('  range %-5s 快照日 %s  上榜 %d 张' % (r, v['at'], n))
    return 0


if __name__ == '__main__':
    sys.exit(main())

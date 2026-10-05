# -*- coding: utf-8 -*-
"""
校验 output/board-snapshot.html 里内联的 12 张卡牌图有没有串图 / 是不是最新素材。

为什么需要它：`make_board_snapshot.py` 用**整路径子串** `[style*="url(cards/<名>.png)"]`
来定位要内联的元素。一旦 `char-` 与 `art-` 两套前缀里有一个是另一个的子串
（比如 `char-c1-vicious` 含 `c1-vicious`），12 个选择器会互相命中，
快照里 12 张会悄悄变成同一张 —— 不报错、不失败，只有肉眼能发现。

判据用字节而不是像素：把每条内联 data URI 解码，和期望的源文件逐字节比。

⚠️ 比较对象是 `extension/cards/`，不是 `assets/board-cards/`：
   `build_extension.py` 会把素材长边压到 640（`CARDS_MAX`）再放进扩展包，
   快照也按同样的查找顺序优先读它。所以 `art-*` 在内联里是 640×450，不是 760×534。
   脚本会额外断言「extension 版是 assets 版的等比缩放」，防止 reals STALE。
"""
import base64
import os
import re
import sys

try:
    from PIL import Image
except ImportError:
    Image = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP = os.path.join(ROOT, 'output', 'board-snapshot.html')
EXT_CARDS = os.path.join(ROOT, 'extension', 'cards')
SRC_CARDS = os.path.join(ROOT, 'assets', 'board-cards')

EXPECT = [
    'char-c1-vicious', 'char-c2-absurd', 'char-c3-passive',
    'char-c4-stubborn', 'char-c5-blah', 'char-c6-emo',
    'art-c1-vicious', 'art-c2-absurd', 'art-c3-passive',
    'art-c4-stubborn', 'art-c5-blah', 'art-c6-emo',
]

RULE_RE = re.compile(
    r'\[style\*="url\(cards/([^")]+\.png)\)"\]\s*\{[^}]*'
    r'url\("?data:image/png;base64,([A-Za-z0-9+/=]+)"?\)')


def png_size(raw):
    """只读 IHDR 拿宽高，不依赖 Pillow。"""
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    import struct
    return struct.unpack('>II', raw[16:24])


def main():
    html = open(SNAP, 'r', encoding='utf-8').read()

    inline = {}
    for m in RULE_RE.finditer(html):
        inline[m.group(1)] = base64.b64decode(m.group(2))

    bad = []
    seen = {}
    rows = []

    for name in EXPECT:
        key = name + '.png'
        ext = os.path.join(EXT_CARDS, key)
        src = os.path.join(SRC_CARDS, key)

        if not os.path.exists(ext):
            bad.append('%s：extension/cards/ 里没有（先跑 build_extension.py）' % name)
            continue
        ref = open(ext, 'rb').read()
        got = inline.get(key)

        ok = True
        note = ''
        if got is None:
            bad.append('%s 没被内联进快照' % name)
            ok = False
        elif got != ref:
            bad.append('%s 内联字节与 extension/cards/ 不一致'
                       '（期望 %d B / 实际 %d B）' % (name, len(ref), len(got)))
            ok = False
        elif got in seen:
            bad.append('%s 与 %s 内联出同一张图 —— 前缀子串相撞了'
                       % (name, seen[got]))
            ok = False
        else:
            seen[got] = name

        # 扩展里的图必须是源素材的等比缩放（build_extension.py 压长边到 640）
        if Image is not None and os.path.exists(src):
            a = Image.open(src)
            b = Image.open(ext)
            if abs(a.width / float(a.height) - b.width / float(b.height)) > 0.004:
                bad.append('%s 长宽比漂了：源 %s vs 包内 %s' % (name, a.size, b.size))
                ok = False
            elif max(a.size) > 640 and max(b.size) != 640:
                note = '未按 CARDS_MAX=640 压缩'
                ok = False
                bad.append('%s %s' % (name, note))

        rows.append((ok, name, len(got or b''), png_size(got or b'')))

    print('快照 %s' % SNAP)
    print('  内联规则 %d 条，去重后 %d 张不同字节' % (len(inline), len(seen)))
    for ok, name, n, size in rows:
        wh = '%dx%d' % size if size else '?'
        print('  [%s] %-20s %-9s %6d B' % ('OK' if ok else 'NG', name, wh, n))

    extra = set(k for k in inline if k[:-4] not in EXPECT)
    if extra:
        bad.append('快照里多内联了不属于这 12 张的规则：%s' % ', '.join(sorted(extra)))

    if bad:
        print('\n发现问题：')
        for b in bad:
            print('  - ' + b)
        return 1
    print('\n12 张全部与扩展包内素材字节一致、互不相同、等比缩放正确 ✓')
    return 0


if __name__ == '__main__':
    sys.exit(main())

# -*- coding: utf-8 -*-
"""从榜单实拍图里量卡牌几何 —— 用像素而不是肉眼判断「牌阵还是不是 202 / 36 / 1392」。

守的是 spec 里那条硬口径：六摞宽 202、gap 36、牌阵总宽 1392；
另量**摞的总高**（⭐ v0.6.0 起封面牌 202x283、摞 301，见下）。

✅ v0.6.0 起**所有卡又全部回到 1 : 1.4**，没有例外了 —— 封面牌改回自绘版式之后
   也一并断言 1:1.4。（v0.5.1 那两年它曾按参考图原比例 1:1.218 = 202x246，
   那段历史见 spec §11.10 / §11.11，**别再按那个口径维护**。）

⚠️ 封面牌的角色是**透明底 PNG**（`char-*.png`）贴在纯白卡面上，
   卡面又回到纯白 #FFFFFF —— 所以下面那条「近白」判据（A）**重新可用**了
   （v0.5.0/5.1 时期因为整张贴的是 249 底色的位图，A 失效过一阵）。
   详情大牌仍是 396x554 / 300x420。

判据有两条，脚本自动挑能用的那条：
  A) 「近白」：页面底 #F4F5F7、卡面纯白 #FFFFFF，差 11 个灰阶。
     ✅ v0.6.0 起封面牌回到纯白自绘卡面，这条重新可用。
     （v0.5.0 / v0.5.1 时封面整张贴的是 249 底色的位图，A 找不到六段游程而失效。）
  B) 「与页面底色有差」：|c - #F4F5F7| 任一通道 > 4。卡面 249 对底色 244 也能分开。
B 是兜底，A 更干净；优先 A，A 找不到 6 段就用 B。

⚠️ 量出来的数会比设计值**小 2**（每侧 1px 描边不算）、gap 会大 2，属正常。

用法： python scripts/measure_board_shot.py output/board-v5-deck-1440x1000.png
"""
import sys
from PIL import Image

BG = (244, 245, 247)


def near_white(c, tol=3):
    return abs(c[0] - 255) <= tol and abs(c[1] - 255) <= tol and abs(c[2] - 255) <= tol


def off_bg(c, tol=2):
    return (abs(c[0] - BG[0]) > tol or abs(c[1] - BG[1]) > tol
            or abs(c[2] - BG[2]) > tol)


def runs_in_row(px, y, w, pred, minlen=80):
    out, cur = [], None
    for x in range(w):
        if pred(px[x, y]):
            if cur is None:
                cur = x
        else:
            if cur is not None:
                if x - cur >= minlen:
                    out.append((cur, x - 1))
                cur = None
    if cur is not None and w - cur >= minlen:
        out.append((cur, w - 1))
    return out


def best_rows(px, w, h, pred):
    return [(y, r) for y, r in ((y, runs_in_row(px, y, w, pred)) for y in range(0, h, 2))
            if len(r) == 6]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    im = Image.open(src).convert('RGB')
    px = im.load()
    w, h = im.size
    print('图纸 %dx%d' % (w, h))

    hits, how = best_rows(px, w, h, near_white), 'A 近白'
    if not hits:
        hits, how = best_rows(px, w, h, off_bg), 'B 与页面底色有差'
    if not hits:
        sys.exit('✗ A/B 两条判据都找不到「一行 6 段」：布局不是六摞，或底色变了')
    y, r = hits[len(hits) // 2]
    widths = [b - a + 1 for a, b in r]
    gaps = [r[i][0] - r[i - 1][1] - 1 for i in range(1, len(r))]

    # ⚠️ 站点版的 `--k` 是 `min(1, (视口宽 - 48) / 1440)`（board.js 的 fitStage）。
    #    所以 **1440 宽的视口 k=0.9667、量出来会是 230 而不是 238**，这不是 bug。
    #    想量到设计原值请用 ≥1488 宽的视口（v0.4.0 的对照图都是 1920x1000）。
    #    这里直接从「摞间距」反算 k，把期望值也一起换算，脚本就与视口无关了。
    pitch = (r[-1][0] - r[0][0]) / float(len(r) - 1)
    k = pitch / float(202 + 36)
    print('横向（判据 %s，y=%d，共 %d 行命中）：' % (how, y, len(hits)))
    print('   摞间距 %.1f  →  反算 --k = %.4f（1440 宽视口本来就该是 0.9667）' % (pitch, k))
    print('   六摞宽 %s   期望 %.0f（(202-2) * k）' % (widths, 200 * k))
    print('   摞间距 %s   期望 %.0f（(36+2) * k）' % (gaps, 38 * k))
    print('   牌阵总宽 %d   期望 %.0f（1392 * k = 6x202 + 5x36）'
          % (r[-1][1] - r[0][0] + 1, 1392 * k))
    print('   ⚠️ 绝对宽度会系统性偏小 10~17px：封面牌整张是用户参考图，'
          '它最外圈是**接近页面底色的柔光**，')
    print('     再叠上 .cover 的 box-shadow，边缘和底色糊在一起，判据切不准。')
    print('     **能信的是「摞间距」那一行**（= 202 + 36 的 pitch，与边缘无关）。')
    print('     卡面尺寸的硬契约放在 scripts/check_extension.py 里断言'
          '（素材像素 + board.css 变量 + board.js 常量三者一致）。')

    print('   ⤷ 纵向不做断言：封面牌与底牌同色、又都带柔光边，截图里量不出边界。')

    cx = (r[0][0] + r[0][1]) // 2
    seg, cur = [], None
    for yy in range(h):
        if off_bg(px[cx, yy]):
            if cur is None:
                cur = yy
        else:
            if cur is not None:
                if yy - cur >= 40:
                    seg.append((cur, yy - 1))
                cur = None
    if cur is not None and h - cur >= 40:
        seg.append((cur, h - 1))
    print('纵向（x=%d 第 1 摞中轴）非底色纵段：%s' % (cx, [(a, b, b - a + 1) for a, b in seg]))
    print('   ⤷ 只作参考：封面牌中段被插画占满、上下又都是柔光边，会被切成好几段。')
    print('     所以这里**不**从截图断言纵向尺寸 —— 见上面那条注释。')


if __name__ == '__main__':
    main()

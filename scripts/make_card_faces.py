# -*- coding: utf-8 -*-
"""把用户参考图里的 6 张牌处理成两套素材。

参考图实测：卡片 395x481，3 列 x 2 行。列左 [118,585,1028]、行上 [25,542]。

产出两套（**文件名前缀刻意互不为子串**，避免快照内联时用整路径子串互相命中）：
  A) assets/board-cards/char-<id>.png  **从牌里抠出来的角色**（透明底，含腿与紧邻道具）
     → 贴到我们自己排的封面牌形象区（202x283 的 1:1.4 纸牌）
  B) assets/board-cards/art-<id>.png   牌中间的插画带（详情大牌形象区用）

⭐ 三次改版的演进（结论比过程重要，别再往回走）：
  1. v0.4.0「照着重画」被否 —— AI 出插画 + 网页字体排字。**根因是字体复刻不出来**
     （参考图赛道名是粗描边毛笔感、名次/分数是圆头粗体）。
  2. v0.5.0「从图里切 + 凑 1:1.4」被否 —— 为凑纸牌比例把牌面**从自带外框里切出来**再补白边，
     内容相对放大 9%、原图留白与柔光外框全丢 → 发紧变味。
     **教训：手上有成品图时，「改造它去适配版式」几乎总比「让版式适配它」更难看。**
  3. v0.5.1「整张参考牌直接用」也被否 —— 用户：「是把角色抠出来，**不是把整张图都放进去**，
     贴在原有的那个卡片上，现在卡片看起来特别奇怪。」
     ⭐ 所以整图直接用同样不对：自带外框 + 我们的圆角 = 双框，名次/分数还是画死的假值。
  4. **现在（v0.6.0）= 我们自己排卡面版式（文字全部实时）+ 只把图里的角色抠出来当插画。**
     封面牌回到纸牌比例 1:1.4（202x283），与详情大牌同比例。

用法：
  python scripts/make_card_faces.py            # 出图
  python scripts/make_card_faces.py --probe    # 只打印逐张探测结果
  python scripts/_probe_char.py                # 调参用：出角色抠图预览（白底/深底/棋盘格）
"""
import os
import sys
from collections import deque

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, 'assets', 'board-cards')
REF = r'C:\Users\apple\.workbuddy\clipboard-images\clipboard-2026-09-24T07-35-37-034Z-096c2c6b.jpg'

CW, CH = 395, 481                      # 单张参考牌的实测尺寸
COLS = [118, 585, 1028]                # 三列的左边界（实测）
ROWS = [25, 542]                       # 两行的上边界（实测）
NAMES = [['c1-vicious', 'c2-absurd', 'c3-passive'],
         ['c4-stubborn', 'c5-blah', 'c6-emo']]

# ======================= A) 角色素材 =======================

# ⭐ 逐张裁剪框（**牌内坐标**）。
#   上界 28：留住顶部装饰（c5 的吊灯从 y28 起，c4 的横条在 y56 起）。
#   下界 278：带刻度的放大图实测「角色腿底 ≈ 275」「赛道名顶 ≈ 290」，取一个
#     既不切腿、又不放进赛道名的值。c1 的三叉戟比腿长，末端会被切掉一点 ——
#     这是有意的取舍：宁可切装饰，也不让赛道名的字进来。
#   左右 = 角色主体（连通块探测）左右各留一点装饰。
CHAR_BOX = {
    'c1-vicious':  (86, 28, 336, 278),
    'c2-absurd':   (78, 28, 312, 278),
    'c3-passive':  (74, 28, 306, 278),
    'c4-stubborn': (80, 28, 326, 278),
    'c5-blah':     (92, 28, 298, 278),
    'c6-emo':      (92, 28, 358, 278),
}
# 名次行「矩形抹白」（牌内坐标）—— 逐张手定，依据是连通块探测出的名次块包围盒。
# ⚠️ 不能用一整条横带（那是 art-* 的旧做法）：c6 的 emo 气泡（x266~350, y106~175）
#    是**角色的一部分**，整条抹会把气泡一起抹掉。
RANK_WIPE = {
    'c1-vicious':  [(14, 20, 130, 104), (286, 20, 385, 92)],
    'c2-absurd':   [(14, 20, 100, 92),  (264, 20, 385, 95)],
    'c3-passive':  [(14, 20, 100, 96),  (275, 20, 385, 100)],
    'c4-stubborn': [(14, 20, 134, 92),  (300, 20, 385, 80)],
    'c5-blah':     [(14, 20, 124, 86),  (272, 20, 385, 72)],
    'c6-emo':      [(14, 20, 132, 96),  (276, 20, 385, 100)],
}
# c6 要放宽：它的 emo 气泡离角色主体 15px，而赛道名离角色也只有 15px ——
# 用统一阈值要么丢气泡、要么带进赛道名。
CHAR_NEAR = {'c6-emo': 20}
CHAR_NEAR_DEFAULT = 12

# 封面牌形象区的 2 倍（202x283 的卡面里，形象区约 178x146）。
CHAR_OUT_W, CHAR_OUT_H = 356, 292

NEAR_WHITE = 244       # flood fill 判据：三通道都 ≥ 此值算背景
FEATHER = 0.9          # alpha 羽化半径（px，原图尺度）

# ======================= B) 插画带（详情大牌） =======================

# ⚠️ 参考图里**名次行（🔥1 / 8.5）与角色头部在纵向完全重叠**（名次在 y≈76~140，
#    角色的角/头顶也从 y≈76 起），没有一条水平的干净缝可切。
#    好在它们在**横向是分开的**，所以做法是：上界提到 y=28、下界切在 y=286，
#    再把 y<148 的左右两角抹白。
BAND_TOP, BAND_BOT = 28, 286
BAND_LEFT_IN, BAND_RIGHT_IN = 14, 14

# 上区抹白的左右边界（**牌内坐标，逐张量出来的**）。
# ⚠️ 边界一定要落在空档**里**（宁可切到名次、别留半截数字）。
CLEAR_X = {
    'c1-vicious':  (130, 274),
    'c2-absurd':   (92, 268),
    'c3-passive':  (100, 276),
    'c4-stubborn': (120, 294),
    'c5-blah':     (140, 276),
    'c6-emo':      (108, 258),
}
# c6 要清得更低：它的「emo」对话气泡和名次数字在横向重叠。
CLEAR_Y = {'c6-emo': 182}
CLEAR_Y_DEFAULT = 148


def ink(c):
    """有墨 = 暗，或者饱和（彩色）。参考牌的描边是浅灰（约 220 亮度 / 低饱和），
    天然被排除在外，所以这个判据只认内容、不认卡边。"""
    mx, mn = max(c), min(c)
    lum = (c[0] * 299 + c[1] * 587 + c[2] * 114) // 1000
    return lum < 175 or (mx - mn) > 60


def row_ink(px, x0, y0, y, xa, xb, step=2):
    n = 0
    for x in range(x0 + xa, x0 + xb, step):
        if ink(px[x, y0 + y]):
            n += 1
    return n


def detect(px, x0, y0):
    """逐张探测：整张牌的墨迹上下界（只给 --probe 看，出图不依赖它）。"""
    full = [row_ink(px, x0, y0, y, 16, CW - 16) for y in range(CH)]
    ink_top = next((y for y in range(CH) if full[y] >= 4), 0)
    ink_bot = next((y for y in range(CH - 1, -1, -1) if full[y] >= 4), CH - 1)
    return ink_top, ink_bot


def whiten_bg(img, lum0=216, lum1=230, sat_flat=14, sat_max=36, white_floor=236):
    """把「低饱和 + 高亮度」的像素推到**纯白**。

    为什么需要：参考图的牌面底色是**带柔光阴影的浅灰**（干净页边约 249，
    顶部中间那层柔光暗场只有 **230~240**）。细节大牌的形象区是坐在**纯白卡面**
    上的，直接放进去会看见一块边界分明的浅灰场。彩色涂鸦不受影响。

    两条规则叠用：
      1) **近白直推**：最暗通道 ≥ white_floor 一律纯白。用「最暗通道」判而不是
         「饱和度」判 —— 那层柔光带一点淡紫/暖色偏，饱和度不高但确实不是灰。
      2) 亮度软斜坡 lum0..lum1：**lum0 必须低到 216**。踩过的坑：材质放大后
         那层柔光实测是 233，用 230/238 只能推到 241，实拍里就是一片带明显边界的浅灰。
    """
    out = img.convert('RGB')
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            mx, mn = max(r, g, b), min(r, g, b)
            if mn >= white_floor:
                px[x, y] = (255, 255, 255)
                continue
            sat = mx - mn
            if sat >= sat_max:
                continue
            lum = (r * 299 + g * 587 + b * 114) // 1000
            if lum <= lum0:
                continue
            wl = min(1.0, (lum - lum0) / float(lum1 - lum0))
            ws = 1.0 if sat <= sat_flat else max(0.0, 1.0 - (sat - sat_flat) / float(sat_max - sat_flat))
            t = wl * ws
            if t <= 0:
                continue
            px[x, y] = (int(round(r + (255 - r) * t)),
                        int(round(g + (255 - g) * t)),
                        int(round(b + (255 - b) * t)))
    return out


def wipe_rects(img, rects, soft=10):
    """把给定矩形（**图内坐标**）往白推，边缘 soft 像素软斜坡。"""
    out = img.convert('RGB')
    px = out.load()
    w, h = out.size
    for (x0, y0, x1, y1) in rects:
        for y in range(max(0, y0 - soft), min(h, y1 + soft)):
            d = max(0, max(y0 - y, y - (y1 - 1)))
            ty = 1.0 - d / float(soft)
            if ty <= 0:
                continue
            for x in range(max(0, x0 - soft), min(w, x1 + soft)):
                d = max(0, max(x0 - x, x - (x1 - 1)))
                tx = 1.0 - d / float(soft)
                if tx <= 0:
                    continue
                t = tx * ty
                t = t * t * (3 - 2 * t)
                r, g, b = px[x, y]
                px[x, y] = (int(round(r + (255 - r) * t)),
                            int(round(g + (255 - g) * t)),
                            int(round(b + (255 - b) * t)))
    return out


def cutout(img, thresh=NEAR_WHITE, feather=FEATHER):
    """从**外围** flood fill 吃掉近白背景 → alpha=0。

    为什么用 flood fill 而不是全局阈值：角色身上有白色高光、纸条是白底，
    全局阈值会把角色内部掏空。从边界灌水则只吃「连通到画外的白」。
    """
    rgb = img.convert('RGB')
    px = rgb.load()
    w, h = rgb.size
    alpha = bytearray(b'\xff' * (w * h))
    seen = bytearray(w * h)
    dq = deque()

    def white(x, y):
        r, g, b = px[x, y]
        return r >= thresh and g >= thresh and b >= thresh

    for x in range(w):
        for y in (0, h - 1):
            i = y * w + x
            if not seen[i] and white(x, y):
                seen[i] = 1
                dq.append(i)
    for y in range(h):
        for x in (0, w - 1):
            i = y * w + x
            if not seen[i] and white(x, y):
                seen[i] = 1
                dq.append(i)

    while dq:
        i = dq.popleft()
        alpha[i] = 0
        x = i % w
        for j in (i - 1, i + 1, i - w, i + w):
            if j < 0 or j >= w * h or seen[j]:
                continue
            if abs((j % w) - x) > 1:
                continue
            if white(j % w, j // w):
                seen[j] = 1
                dq.append(j)

    am = Image.frombytes('L', (w, h), bytes(alpha))
    if feather:
        am = am.filter(ImageFilter.GaussianBlur(feather))
    rgba = rgb.convert('RGBA')
    rgba.putalpha(am)
    return rgba


def keep_main(rgba, near=12, min_area=180, floor_trim=2600):
    """只保留与「最大块」邻近的连通块。

    参考图里**赛道名三个字是独立的连通块**（与角色之间隔着白间隙），
    所以这条判据能自动把赛道名丢掉 —— 不用去猜「赛道名顶边在哪一行」，
    那个量法会被角色自己的墨段干扰，一直不准。顺带也丢掉远处散落的涂鸦短线。

    判据 = 「候选块与主块包围盒的 x/y 间隙，两个都不超过 near」，
    外加：**贴着裁剪框底边的小块直接丢掉** —— 那是被切掉一半的脚部装饰，
    留在图上就是一圈硬切的碎渣。
    """
    a = rgba.getchannel('A').point(lambda v: 255 if v > 128 else 0)
    w, h = a.size
    src = a.load()
    seen = bytearray(w * h)
    blocks = []
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if seen[i] or not src[x, y]:
                continue
            dq = deque([(x, y)])
            seen[i] = 1
            x0 = x1 = x
            y0 = y1 = y
            cnt = 0
            while dq:
                cx, cy = dq.popleft()
                cnt += 1
                x0 = min(x0, cx); x1 = max(x1, cx)
                y0 = min(y0, cy); y1 = max(y1, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not seen[j] and src[nx, ny]:
                            seen[j] = 1
                            dq.append((nx, ny))
            blocks.append((cnt, x0, y0, x1, y1))
    if not blocks:
        return rgba
    blocks.sort(reverse=True)
    _, mx0, my0, mx1, my1 = blocks[0]
    m = Image.new('L', (w, h), 0)
    mp = m.load()
    kept = [blocks[0]]
    for b in blocks[1:]:
        cnt, x0, y0, x1, y1 = b
        if cnt < min_area:
            continue
        if y1 >= h - 10 and cnt < floor_trim:
            continue
        gx = max(0, max(mx0 - x1, x0 - mx1))
        gy = max(0, max(my0 - y1, y0 - my1))
        if max(gx, gy) > near:
            continue
        kept.append(b)
    for cnt, x0, y0, x1, y1 in kept:
        for yy in range(y0, y1 + 1):
            for xx in range(x0, x1 + 1):
                if src[xx, yy]:
                    mp[xx, yy] = 255
    m = m.filter(ImageFilter.GaussianBlur(0.9))
    out = rgba.copy()
    out.putalpha(m)
    return out


def trim(rgba, pad=2):
    """裁到 alpha>8 的包围盒，四周留 pad。"""
    a = rgba.getchannel('A').point(lambda v: 255 if v > 8 else 0)
    bb = a.getbbox()
    if not bb:
        return rgba
    x0, y0, x1, y1 = bb
    return rgba.crop((max(0, x0 - pad), max(0, y0 - pad),
                      min(rgba.width, x1 + pad), min(rgba.height, y1 + pad)))


def fade_edges(img, top_pct=0.025, bot_pct=0.08):
    """插画带上下缘往白色柔和淡出（硬切边一眼就看出「图被裁过」）。"""
    out = img.convert('RGB')
    px = out.load()
    w, h = out.size
    top_n = max(1, int(h * top_pct))
    bot_n = max(1, int(h * bot_pct))
    for y in range(h):
        t = 0.0
        if y < top_n:
            t = 1.0 - y / float(top_n)
        elif y >= h - bot_n:
            t = 1.0 - (h - 1 - y) / float(bot_n)
        if t <= 0:
            continue
        t = t * t * (3 - 2 * t)
        for x in range(w):
            r, g, b = px[x, y]
            px[x, y] = (int(round(r + (255 - r) * t)),
                        int(round(g + (255 - g) * t)),
                        int(round(b + (255 - b) * t)))
    return out


def clear_top_corners(img, oy, oxl, oxr, soft=14):
    """把切片**上缘的左右两角**抹白（往白推，带软斜坡）—— 只给 art-* 用。"""
    out = img.convert('RGB')
    px = out.load()
    w, h = out.size
    for y in range(min(h, int(oy) + soft)):
        ty = 1.0 if y < oy - soft else max(0.0, (oy + soft - y) / float(2 * soft))
        ty = ty * ty * (3 - 2 * ty)
        if ty <= 0:
            continue
        for x in range(w):
            if x < oxl:
                d = oxl - x
            elif x > oxr:
                d = x - oxr
            else:
                continue
            t = min(1.0, d / float(soft)) * ty
            t = t * t * (3 - 2 * t)
            if t <= 0:
                continue
            r, g, b = px[x, y]
            px[x, y] = (int(round(r + (255 - r) * t)),
                        int(round(g + (255 - g) * t)),
                        int(round(b + (255 - b) * t)))
    return out


def make_char(card, n):
    """从一张参考牌里抠出角色 → RGBA。"""
    bx0, by0, bx1, by1 = CHAR_BOX[n]
    zone = card.crop((bx0, by0, bx1, by1))
    zone = wipe_rects(whiten_bg(zone),
                      [(a - bx0, b - by0, c - bx0, d - by0)
                       for (a, b, c, d) in RANK_WIPE[n]])
    ch = trim(keep_main(cutout(zone),
                        near=CHAR_NEAR.get(n, CHAR_NEAR_DEFAULT)))
    s = min(CHAR_OUT_W / float(ch.width), CHAR_OUT_H / float(ch.height))
    return ch.resize((max(1, int(round(ch.width * s))),
                      max(1, int(round(ch.height * s)))), Image.LANCZOS)


def main():
    im = Image.open(REF).convert('RGB')
    px = im.load()
    if not os.path.isdir(CARDS):
        sys.exit('找不到 ' + CARDS)

    cards = []
    for ri, y0 in enumerate(ROWS):
        for ci, x0 in enumerate(COLS):
            it, ib = detect(px, x0, y0)
            cards.append((NAMES[ri][ci], x0, y0, it, ib))

    if '--probe' in sys.argv:
        print('  参考牌内部墨迹范围（⚠️ 只作参考：角色素材已改成逐张裁剪框，不再按它裁；')
        print('     art-* 仍依赖这张表）')
        print('  名字             墨上  墨下  内容高')
        for n, x0, y0, it, ib in cards:
            print('  %-15s %5d %5d %6d' % (n, it, ib, ib - it + 1))
        return

    print('角色素材：逐张裁剪框 → 推白 → 抹名次 → 抠透明 → 就近保留 → 缩到 %dx%d 内'
          % (CHAR_OUT_W, CHAR_OUT_H))
    print('插画带：y %d~%d、左右各内缩 %d → 760 宽（推白 + 抹名次 + 上下淡出）\n'
          % (BAND_TOP, BAND_BOT, BAND_LEFT_IN))

    made = []
    for n, x0, y0, it, ib in cards:
        card = im.crop((x0, y0, x0 + CW, y0 + CH))

        # ---------- A) 角色素材（透明底，贴到我们自己排的封面卡面上） ----------
        ch = make_char(card, n)
        p = os.path.join(CARDS, 'char-' + n + '.png')
        ch.save(p, 'PNG', optimize=True)
        made.append(('char-' + n, ch.width, ch.height, os.path.getsize(p),
                     '抠出的角色 %dx%d（框 %s）' % (ch.width, ch.height, CHAR_BOX[n])))

        # ---------- B) 插画带 ----------
        band = card.crop((BAND_LEFT_IN, BAND_TOP, CW - BAND_RIGHT_IN, BAND_BOT))
        bw, bh = band.size
        bw2 = 760
        bh2 = int(round(bh * bw2 / float(bw)))
        band = band.resize((bw2, bh2), Image.LANCZOS)
        bsc = bw2 / float(bw)
        cy = CLEAR_Y.get(n, CLEAR_Y_DEFAULT)
        cxl, cxr = CLEAR_X[n]
        # 顺序要紧：先推白牌面，再抹角（抹出来就是纯白，和牌面接得上），最后收边
        band = clear_top_corners(whiten_bg(band),
                                 (cy - BAND_TOP) * bsc,
                                 (cxl - BAND_LEFT_IN) * bsc,
                                 (cxr - BAND_LEFT_IN) * bsc)
        band = fade_edges(band)
        band = band.convert('P', palette=Image.ADAPTIVE, colors=256)
        p = os.path.join(CARDS, 'art-' + n + '.png')
        band.save(p, 'PNG', optimize=True)
        made.append(('art-' + n, bw2, bh2, os.path.getsize(p),
                     '插画带 y %d~%d（推白 + 上下淡出）' % (BAND_TOP, BAND_BOT)))

    # ---------- 清掉 v0.5.x 遗留的 face-*.png（已由 char-* 取代） ----------
    dropped = []
    for f in sorted(os.listdir(CARDS)):
        if f.startswith('face-') and f.endswith('.png'):
            os.remove(os.path.join(CARDS, f))
            dropped.append(f)

    total = 0
    for n, w, h, b, note in made:
        total += b
        print('  %-16s %4dx%-4d %6.0f KB   %s' % (n, w, h, b / 1024.0, note))
    print('合计 %.1f KB' % (total / 1024.0))
    if dropped:
        print('已清理旧素材 %d 个（face-*）：%s' % (len(dropped), ', '.join(dropped)))


if __name__ == '__main__':
    main()

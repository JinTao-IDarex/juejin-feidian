# -*- coding: utf-8 -*-
"""临时探测：从用户参考图里把六只角色抠成**透明底**，输出预览拼图。

用途：定稿「char-<id> 角色素材」的抠图口径，参数确认后再搬进 make_card_faces.py。
    python scripts/_probe_char.py

输出：
  output/_char-bounds.png    在参考图上画出逐张裁剪框 + 名次抹白框
  output/_char-preview.png   白卡面底色上的六只角色（封面牌里的实际观感）
  output/_char-dark.png      深灰底上同一批（检查透明区有没有漏白）
  output/_char-raw.png       棋盘格底，看原始边界
"""
import os
import sys
from collections import deque

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from make_card_faces import whiten_bg  # noqa: E402

REF = r'C:\Users\apple\.workbuddy\clipboard-images\clipboard-2026-09-24T07-35-37-034Z-096c2c6b.jpg'
OUT = os.path.join(ROOT, 'output')

CW, CH = 395, 481
COLS = [118, 585, 1028]
ROWS = [25, 542]
NAMES = [['c1-vicious', 'c2-absurd', 'c3-passive'],
         ['c4-stubborn', 'c5-blah', 'c6-emo']]

# ⭐ 逐张裁剪框（**牌内坐标**）。
#   左/右 = 角色主体（连通块探测）左右各留一点装饰；上界 28 留住顶部装饰（c5 的吊灯从 y28 起）。
#   ⚠️ 下界 = **278**：带刻度的放大图实测「角色腿底 ≈ 275」「赛道名顶 ≈ 290」，
#      取中值 → 上下各留 7px 余量。（c1 的三叉戟比腿长，末端会被切掉一点，这是有意的取舍：
#      宁可切装饰，也不让赛道名的字进来。）
CHAR_BOX = {
    'c1-vicious':  (86, 28, 336, 278),
    'c2-absurd':   (78, 28, 312, 278),
    'c3-passive':  (74, 28, 306, 278),
    'c4-stubborn': (80, 28, 326, 278),
    'c5-blah':     (92, 28, 298, 278),
    'c6-emo':      (92, 28, 358, 278),
}
# ⭐ 名次行「矩形抹白」（牌内坐标）—— 逐张手定，依据是连通块探测出的名次块包围盒。
#   ⚠️ 不能用一整条横带（那是 art-* 的旧做法）：c6 的 emo 气泡（x266~350, y106~175）
#      是**角色的一部分**，整条抹会把气泡一起抹掉。
RANK_WIPE = {
    'c1-vicious':  [(14, 20, 130, 104), (286, 20, 385, 92)],
    'c2-absurd':   [(14, 20, 100, 92),  (264, 20, 385, 95)],
    'c3-passive':  [(14, 20, 100, 96),  (275, 20, 385, 100)],
    'c4-stubborn': [(14, 20, 134, 92),  (300, 20, 385, 80)],
    'c5-blah':     [(14, 20, 124, 86),  (272, 20, 385, 72)],
    'c6-emo':      [(14, 20, 132, 96),  (276, 20, 385, 100)],
}

NEAR_WHITE = 244
FEATHER = 0.9


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
    那个量法被角色自己的墨段干扰，一直不准。
    顺带也丢掉远处散落的涂鸦短线。

    判据 = 「候选块与主块包围盒的 x/y 间隙，两个都不超过 near」，
    外加一条：**贴着裁剪框底边的小块直接丢掉** —— 那是被切掉一半的脚部装饰，
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
        if y1 >= h - 10 and cnt < floor_trim:   # 贴底的碎块 = 被切一半的脚部装饰
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
    a = rgba.getchannel('A').point(lambda v: 255 if v > 8 else 0)
    bb = a.getbbox()
    if not bb:
        return rgba
    x0, y0, x1, y1 = bb
    return rgba.crop((max(0, x0 - pad), max(0, y0 - pad),
                      min(rgba.width, x1 + pad), min(rgba.height, y1 + pad)))


def build(im):
    chars = []
    for ri, y0 in enumerate(ROWS):
        for ci, x0 in enumerate(COLS):
            n = NAMES[ri][ci]
            bx0, by0, bx1, by1 = CHAR_BOX[n]
            card = im.crop((x0, y0, x0 + CW, y0 + CH))
            zone = card.crop((bx0, by0, bx1, by1))
            zone = wipe_rects(whiten_bg(zone),
                              [(a - bx0, b - by0, c - bx0, d - by0)
                               for (a, b, c, d) in RANK_WIPE[n]])
            # c6 要放宽：它的 emo 气泡（x266~350）离角色主体 15px，
            # 而赛道名离角色也只有 15px —— 用统一阈值要么丢气泡、要么带进赛道名。
            c = trim(keep_main(cutout(zone), near=(20 if n == 'c6-emo' else 12)))
            chars.append((n, c))
            op = sum(1 for v in c.getchannel('A').getdata() if v > 128)
            print('%-14s 框 %3d,%3d~%3d,%3d → %3dx%3d  实占 %2.0f%%  宽高比 1:%.2f'
                  % (n, bx0, by0, bx1, by1, c.width, c.height,
                     op / float(c.width * c.height) * 100,
                     c.height / float(c.width)))
    return chars


def sheet_of(chars, bg, path, card_w=202, card_h=283, checker=False, framed=False):
    pw = 6 * (card_w + 16) + 16
    ph = card_h + 32
    sheet = Image.new('RGB', (pw, ph), bg)
    if checker:
        d = ImageDraw.Draw(sheet)
        for yy in range(0, ph, 16):
            for xx in range(0, pw, 16):
                if (xx // 16 + yy // 16) % 2:
                    d.rectangle([xx, yy, xx + 15, yy + 15], fill=(222, 222, 222))
    for i, (n, c) in enumerate(chars):
        card = Image.new('RGB', (card_w, card_h), (255, 255, 255) if not checker else None) \
            if False else Image.new('RGB', (card_w, card_h), (255, 255, 255))
        if framed:
            ImageDraw.Draw(card).rounded_rectangle([0, 0, card_w - 1, card_h - 1],
                                                   18, outline=(224, 227, 232))
        s = min((card_w - 16) / float(c.width), (card_h - 16) / float(c.height))
        r = c.resize((max(1, int(c.width * s)), max(1, int(c.height * s))), Image.LANCZOS)
        card.paste(r, ((card_w - r.width) // 2, (card_h - r.height) // 2), r)
        if checker:
            rr = c.resize((max(1, int(c.width * s)), max(1, int(c.height * s))), Image.LANCZOS)
            sheet.paste(rr, (16 + i * (card_w + 16) + (card_w - rr.width) // 2,
                             16 + (card_h - rr.height) // 2), rr)
        else:
            sheet.paste(card, (16 + i * (card_w + 16), 16))
    sheet.save(path)


def main():
    im = Image.open(REF).convert('RGB')
    if not os.path.isdir(OUT):
        os.makedirs(OUT)

    chars = build(im)
    sheet_of(chars, (244, 245, 247), os.path.join(OUT, '_char-preview.png'), framed=True)
    sheet_of(chars, (38, 42, 48), os.path.join(OUT, '_char-dark.png'))
    sheet_of(chars, (255, 255, 255), os.path.join(OUT, '_char-raw.png'), checker=True)

    marks = im.copy()
    d = ImageDraw.Draw(marks)
    for ri, y0 in enumerate(ROWS):
        for ci, x0 in enumerate(COLS):
            n = NAMES[ri][ci]
            bx0, by0, bx1, by1 = CHAR_BOX[n]
            d.rectangle([x0 + bx0, y0 + by0, x0 + bx1, y0 + by1],
                        outline=(0, 160, 255), width=3)
            for (a, b, c2, dd) in RANK_WIPE[n]:
                d.rectangle([x0 + a, y0 + b, x0 + c2, y0 + dd],
                            outline=(255, 60, 60), width=2)
    marks.save(os.path.join(OUT, '_char-bounds.png'))
    print('\n出图：output/_char-bounds.png / _char-preview.png / _char-dark.png / _char-raw.png')


if __name__ == '__main__':
    main()

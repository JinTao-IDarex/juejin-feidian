# -*- coding: utf-8 -*-
"""从主版 logo 生成浏览器扩展图标（16 / 32 / 48 / 128）。

源：assets/logo-juejin-joker.jpg        （唯一源头）
出：extension/icons/{16,32,48,128}.png

**默认模式 = 整张直接使用**（用户指定）：主版是满幅的 —— 奶油底铺到画布四边，
蓝框自带 54/1254 ≈ 4.3% 的圆角，画面本身没有留白可裁。
所以直接整体缩放，再按蓝框自己的弧度（CARD_RADIUS_PCT）打圆角，
只让框外那点奶油角变透明，不做任何裁切、不重画、不改色。

    python scripts/build_icons.py             整张直接使用（默认）
    python scripts/build_icons.py --medallion 圆章特写模式（备选，见下）
    python scripts/build_icons.py --preview   额外输出 output/icon-preview.png 自查

备选模式 `--medallion`：取中央圆章（角色 + 蓝色时钟环 + 环外装饰点）收成圆形，
居中放到奶油底上占 90%，外套 22% 圆角轮廓。
**为什么留着它**：整张使用的代价是小尺寸放不下细节 ——
48px 起开始糊、32px 勉强能看出色块分布、16px 只剩一团。
圆章特写版在 32px 仍能读出「橙角色 + 蓝环」。需要小尺寸可读性时一句话就能切回去。
"""
import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "assets", "logo-juejin-joker.jpg")
ICON_DIR = os.path.join(ROOT, "extension", "icons")
PREVIEW = os.path.join(ROOT, "output", "icon-preview.png")

SIZES = (16, 32, 48, 128)

# 主版蓝框自身的圆角：实测最左侧蓝色 y≈90 处进入直边、y≈36 到达弧顶，半径 ≈ 54px。
# 用它打圆角 = 只把框外的奶油角变透明，不切进设计里。
CARD_RADIUS_PCT = 0.043

# 圆章特写模式
MEDALLION_RADIUS_PCT = 0.22
MEDALLION_FILL = 0.90

# ---- 圆章位置（主版 1254×1254 上实测）----------------------------------
# 改主版后必须重测；下面的 _check 用中行扫描交叉验证左右边界，漂了会打印。
RING_BOX = (267, 253, 1018, 1004)      # 751 × 751
RING_PAD_PCT = 0.02                    # 外接框再放一点，避免裁到环外装饰点


def _is_blue(px):
    r, g, b = px
    return b > 150 and b - r > 60


def _check_ring(im):
    """用中行扫描交叉验证 RING_BOX 的左右边界，返回测量值。"""
    w, h = im.size
    cy = h // 2
    xs = [x for x in range(w) if _is_blue(im.getpixel((x, cy))) and w * 0.07 < x < w * 0.93]
    return (min(xs), max(xs)) if xs else None


def _rounded_mask(size, radius_pct):
    """圆角方形 alpha 遮罩。4 倍超采样后再缩，边缘更干净。"""
    ss = 4
    m = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, size * ss - 1, size * ss - 1], radius=max(1, int(size * ss * radius_pct)), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def _build_whole(im, size):
    """整张直接使用：整体缩放 + 按蓝框自身弧度打圆角。"""
    out = im.resize((size, size), Image.LANCZOS).convert("RGBA")
    out.putalpha(_rounded_mask(size, CARD_RADIUS_PCT))
    return out


def _build_medallion(im, size):
    """圆章特写：中央圆章收成圆形，居中放到奶油底上。"""
    cx = (RING_BOX[0] + RING_BOX[2]) / 2.0
    cy = (RING_BOX[1] + RING_BOX[3]) / 2.0
    side = RING_BOX[2] - RING_BOX[0]
    pad = int(side * RING_PAD_PCT)
    med = im.crop((int(cx - side / 2) - pad, int(cy - side / 2) - pad,
                   int(cx + side / 2) + pad, int(cy + side / 2) + pad))
    cream = im.getpixel((int(im.size[0] * 0.13), im.size[1] // 2))

    inner = max(1, int(size * MEDALLION_FILL))
    canvas = Image.new("RGB", (size, size), cream)
    circle = Image.new("L", (inner * 4, inner * 4), 0)
    ImageDraw.Draw(circle).ellipse([0, 0, inner * 4 - 1, inner * 4 - 1], fill=255)
    circle = circle.resize((inner, inner), Image.LANCZOS)
    canvas.paste(med.resize((inner, inner), Image.LANCZOS),
                 ((size - inner) // 2, (size - inner) // 2), circle)
    out = canvas.convert("RGBA")
    out.putalpha(_rounded_mask(size, MEDALLION_RADIUS_PCT))
    return out


def build_all(mode="whole", verbose=True):
    im = Image.open(MASTER).convert("RGB")
    w, h = im.size
    fn = _build_whole if mode == "whole" else _build_medallion

    if verbose:
        print("master %dx%d   mode=%s" % (w, h, mode))
        if mode == "medallion":
            meas = _check_ring(im)
            print("  RING_BOX 左右 = %d..%d   中行扫描 = %s"
                  % (RING_BOX[0], RING_BOX[2], meas))

    if not os.path.isdir(ICON_DIR):
        os.makedirs(ICON_DIR, exist_ok=True)

    n = 0
    for s in SIZES:
        out = fn(im, s)
        p = os.path.join(ICON_DIR, "%d.png" % s)
        out.save(p)
        n += 1
        if verbose:
            print("  write icons/%-8s %dx%d  %d bytes" % ("%d.png" % s, s, s, os.path.getsize(p)))
    return n


def build_preview():
    """真实尺寸 + 4 倍放大的对照图，用于人工核验小尺寸可读性。"""
    PANEL = 128
    GAP = 14
    sheet = Image.new("RGB", (GAP + len(SIZES) * (PANEL + GAP),
                              GAP + 20 + PANEL + GAP + 18), (250, 250, 250))
    d = ImageDraw.Draw(sheet)
    y0 = GAP + 20
    for i, s in enumerate(SIZES):
        img = Image.open(os.path.join(ICON_DIR, "%d.png" % s)).convert("RGBA")
        x = GAP + i * (PANEL + GAP)
        for yy in range(0, PANEL, 12):      # 棋盘格底，便于看透明区
            for xx in range(0, PANEL, 12):
                c = (225, 225, 225) if ((xx // 12 + yy // 12) % 2 == 0) else (245, 245, 245)
                d.rectangle([x + xx, y0 + yy, x + xx + 11, y0 + yy + 11], fill=c)
        sheet.paste(img.resize((PANEL, PANEL), Image.NEAREST), (x, y0),
                    img.resize((PANEL, PANEL), Image.NEAREST))
        sheet.paste(img, (x + 2, y0 + 2), img)
        d.text((x + 2, y0 + PANEL + 4), "%dpx  (x4 shown)" % s, fill=(60, 60, 60))
    if not os.path.isdir(os.path.dirname(PREVIEW)):
        os.makedirs(os.path.dirname(PREVIEW), exist_ok=True)
    sheet.save(PREVIEW)
    print("preview -> %s %s" % (PREVIEW, sheet.size))


def main():
    mode = "medallion" if "--medallion" in sys.argv else "whole"
    build_all(mode=mode)
    if "--preview" in sys.argv:
        build_preview()


if __name__ == "__main__":
    main()

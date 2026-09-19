# -*- coding: utf-8 -*-
"""生成扩展图标：深色圆角底 + 橙色渐变 + 白色卡片符号，多尺寸输出 PNG。"""
import os
from PIL import Image, ImageDraw

OUT = r"D:\2workspace\codex\juejin-boom\extension\icons"
os.makedirs(OUT, exist_ok=True)

BASE = 512


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make(size):
    # 以 4 倍超采样再缩小，边缘更干净
    S = BASE
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角方形底（深色）
    r = int(S * 0.235)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(18, 19, 23, 255))

    # 后层卡片（橙，略微旋转的观感 -> 用偏移矩形近似）
    pad = int(S * 0.20)
    d.rounded_rectangle([pad + int(S * 0.055), pad + int(S * 0.02),
                         S - pad + int(S * 0.055), S - pad + int(S * 0.02)],
                        radius=int(S * 0.075), fill=(255, 140, 60, 70))

    # 主卡片（白色）
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=int(S * 0.075),
                        fill=(255, 255, 255, 255))

    # 卡片内三条「正文线」
    lx0 = pad + int(S * 0.055)
    lx1 = S - pad - int(S * 0.055)
    ly = pad + int(S * 0.085)
    for i in range(3):
        y = ly + i * int(S * 0.055)
        w = lx1 - (lx0 if i < 2 else lx0 + int(S * 0.07))
        d.rounded_rectangle([lx0, y, lx0 + w, y + int(S * 0.028)],
                            radius=int(S * 0.014),
                            fill=(30, 32, 38, 255) if i == 0 else (170, 175, 185, 255))

    # 底部橙色渐变条（强调）
    gy0 = S - pad - int(S * 0.085)
    gy1 = S - pad - int(S * 0.045)
    band = Image.new("RGB", (lx1 - lx0, gy1 - gy0))
    bd = ImageDraw.Draw(band)
    for x in range(band.width):
        bd.line([(x, 0), (x, band.height)], fill=lerp((255, 178, 122), (255, 105, 30),
                                                      x / max(1, band.width - 1)))
    mask = Image.new("L", band.size, 255)
    img.paste(band, (lx0, gy0), mask)

    # 右上角小火花（橙色圆点）
    cx, cy, cr = int(S * 0.775), int(S * 0.225), int(S * 0.052)
    d.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=(255, 122, 47, 255))

    return img.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    make(s).save(os.path.join(OUT, "%d.png" % s))
print(sorted(os.listdir(OUT)))

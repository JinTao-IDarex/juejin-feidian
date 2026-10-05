# -*- coding: utf-8 -*-
"""把 headless Chrome 的外窗假边裁掉，只留真实视口。

⚠️ 实测（Chromium 1148 / Windows，2026-09-24）：
    `--window-size=W,H` 给的是**外窗**尺寸，真实视口是 W-16 / H-95，
    但截图 canvas 仍然是 WxH。多出来的右下一条会被**根元素背景铺满**
    （CSS 根背景会传播到 canvas），所以「非白包围盒」法在这里**无效**，
    必须先用视口探针实测，再按 (0,0,W,H) 硬裁。

    量视口（站点服务起着的时候）：
      chrome --headless --dump-dom --window-size=1936,1095 \
             http://127.0.0.1:7100/vpsize.html | grep -o "VP=[^<]*"
      → VP=1920x1000

常用对照（要什么视口 → --window-size 传什么）：
    1440x722  → 1456,817     （浮层）
    1920x1000 → 1936,1095    （站点）
    1920x960  → 1936,1055    （撑出竖滚动条，验动画用）

用法： python scripts/shot_crop.py <in.png> <out.png> <视口宽> <视口高>
"""
import sys
from PIL import Image


def main():
    if len(sys.argv) < 5:
        sys.exit(__doc__)
    src, dst, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    im = Image.open(src).convert('RGB')
    print('%s  canvas %dx%d  → 裁到视口 %dx%d' % (src, im.width, im.height, w, h))
    if im.width < w or im.height < h:
        sys.exit('✗ 截图比目标视口还小：--window-size 要传 宽+16 / 高+95')
    im.crop((0, 0, w, h)).save(dst)
    print('   →', dst)


if __name__ == '__main__':
    main()

# -*- coding: utf-8 -*-
"""按**比例**裁 headless 截图的局部区域。

⚠️ 为什么不能直接用 shot_crop.py：
   shot_crop 假设截图 canvas == 视口尺寸（1x）。但本机 Chromium 截图
   **带 1.5x DPR**（--window-size=1456,1095 出的是 2184x1643），
   按视口坐标硬裁会裁到空白区，误判「元素没渲染」。

本脚本用 **实际宽 / 传入视口宽** 求缩放比 s，再把视口坐标 × s 换算成像素坐标。
所以窗口尺寸、DPR 变了都不用改调用方式。

用法：
  python scripts/shot_crop_scale.py <in.png> <out.png> <视口宽> <视口高> \
      [x y w h]        # x y w h 都是**视口坐标**，缺省裁整个视口
"""
import sys
import struct
from PIL import Image


def read_png_size(path):
    with open(path, 'rb') as f:
        head = f.read(33)
    if head[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('not a png: ' + path)
    w, h = struct.unpack('>II', head[16:24])
    return w, h


def main():
    if len(sys.argv) < 5:
        raise SystemExit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    vw, vh = int(sys.argv[3]), int(sys.argv[4])
    aw, ah = read_png_size(src)
    s = aw / float(vw)                      # ⭐ 缩放比（DPR）
    im = Image.open(src).convert('RGB')
    # 先按 s 换成像素坐标再裁；不裁满时会自动被视口框收住
    if len(sys.argv) >= 9:
        x, y, w, h = [int(float(v) * s) for v in sys.argv[5:9]]
    else:
        x, y = 0, 0
        w, h = aw, ah
    box = (x, y, min(x + w, aw), min(y + h, ah))
    im.crop(box).save(dst)
    print('scale s=%.4f  src=%dx%d  out=%dx%d  at %s' %
          (s, aw, ah, box[2] - box[0], box[3] - box[1], box[:2]))


if __name__ == '__main__':
    main()

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""擦掉六张 char-*.png 里「烤死」的内容：
   - 左右上角的名次 / 分数（卡面版式自己会渲染，重叠 = 用户报的「切图乱」）
   - 烤在图里的赛道名（废话 / 阴阳 / 嘴硬榜 / 上榜 手写条，与 cover-name 重复）
   - c1 左缘 / c3 右缘的灰边撕纸残条（参考图截图时带进来的邻牌边）
   氛围碎片（火焰 / 问号 / 纸张 / 皇冠 / emo 气泡等）一律保留。
   原图已备份到 assets/board-cards/_bak-char/。"""
from PIL import Image
import os

ROOT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'board-cards')

# 每张图的擦除矩形：(x0, y0, x1, y1)，基于 356x292 画布 + 网格图逐张标定
ERASE = {
    'char-c1-vicious': [
        (0, 0, 50, 292),      # 左缘灰色撕纸条
        (50, 35, 96, 140),    # 撕纸条中段的右鼓包
        (92, 18, 155, 82),    # 火焰「1」
        (270, 12, 356, 74),   # 「8.5」
    ],
    'char-c2-absurd': [
        (0, 10, 84, 74),      # 黄「1 ⓪」
        (226, 10, 324, 80),   # 「8.5」
    ],
    'char-c3-passive': [
        (0, 20, 54, 94),      # 紫「11」
        (200, 20, 274, 84),   # 「7.5」
        (277, 0, 356, 156),   # 右缘灰色撕纸条（实际在 x277-330）
        (0, 178, 68, 242),    # 「阴阳」纸张（与榜名重复）
    ],
    'char-c4-stubborn': [
        (0, 0, 122, 64),      # 蓝「0」+ 盾
        (290, 0, 356, 50),    # 右上蓝条
        (94, 240, 322, 292),  # 底部手写「嘴硬榜」
    ],
    'char-c5-blah': [
        (0, 6, 102, 72),      # 灰「1」+ 对话泡
        (260, 12, 356, 72),   # 「8.5」
        (246, 148, 338, 208), # 「废话」纸张（与榜名重复）
        (88, 233, 312, 287),  # 底部手写「废话榜」
    ],
    'char-c6-emo': [
        (0, 4, 87, 72),       # 绿「1 ◇」
        (240, 12, 332, 74),   # 「8.5」
        (205, 216, 332, 292), # 底部手写「上榜」
    ],
}

for name, rects in ERASE.items():
    path = os.path.join(ROOT, name + '.png')
    im = Image.open(path).convert('RGBA')
    px = im.load()
    for (x0, y0, x1, y1) in rects:
        x1 = min(x1, im.width); y1 = min(y1, im.height)
        for y in range(y0, y1):
            for x in range(x0, x1):
                r, g, b, a = px[x, y]
                px[x, y] = (r, g, b, 0)
    # 裁掉透明边（内容包围盒）：擦除后的画布四周留白会让 contain 显示的角色
    # 比参考图小一号。裁到包围盒后角色撑满形象区，与参考图的大角色一致。
    bbox = im.getchannel('A').getbbox()
    if bbox:
        im = im.crop(bbox)
    im.save(path)
    print('erased', name, len(rects), 'rects →', im.size)
print('done')

# -*- coding: utf-8 -*-
"""榜单封面牌形象 · 素材归一化

⚠️⚠️ 当前流程**不再使用这个脚本**（2026-09-24 v0.5.0）。
   阶段二期用户明确要求「直接用我提供的那张图，字体也保持一致」，封面牌改成
   从参考图里切整张牌面 + 插画带 —— 见 `scripts/make_card_faces.py`。
   本脚本服务于「用 miora 生成 6 张 AI 插画，再归一化进形象区」那条路，
   那条路已废弃；留着是为了万一要回到 AI 出图时能直接用。
   （注意：它依赖 assets/board-cards/_raw/ 里的 AI 原图，那些图现在也没在用了。）

---- 以下为原说明 ----
为什么需要这一步（实测数据）：
  6 张 AI 出图的「非白内容包围盒」只占源图 47%~67% 宽、64%~77% 高，
  而且各张差异很大（毒舌 67% 宽 vs emo 47% 宽）。直接 background:cover
  铺进封面形象区，会同时出现「显得太小」和「六张大小不齐」两个问题。

做法：
  1) 量出每张的非白包围盒；
  2) 统一把「内容高度」缩放到输出高的 90%（人眼判断"角色大小"看的是高度，
     不是宽度——涂鸦向左右发散的程度天然不同，不该据此缩放）；
  3) 按输出宽高比居中裁切，内容两侧各留 5% 白边。

输出 A = 760/600 = 1.2667，与封面形象区（180 x 142）完全同比，
所以在封面里 `contain` 就是无缝铺满；在大牌里 `contain` 的留白因为
插画本身是白底，同样看不出来。

用法：
  python scripts/normalize_board_cards.py            # 就地重写 assets/board-cards/cN-*.png
  python scripts/normalize_board_cards.py --check    # 只量不改
"""
import argparse
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, 'assets', 'board-cards')
RAW = os.path.join(CARDS, '_raw')

OUT_W, OUT_H = 760, 600          # A = 1.2667，与封面形象区同比
CONTENT_H_PCT = 0.90             # 内容高度占输出高的比例
WHITE = 246                      # 非白判据（>= 该值算白底）
NAMES = ['c1-vicious', 'c2-absurd', 'c3-passive', 'c4-stubborn', 'c5-blah', 'c6-emo']


def content_bbox(im, thresh=WHITE, step=2):
    """非白像素包围盒。step=2 抽样，画稿这种大面积色块足够准。"""
    w, h = im.size
    px = im.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(0, h, step):
        hit = False
        for x in range(0, w, step):
            r, g, b = px[x, y][:3]
            if r < thresh or g < thresh or b < thresh:
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                hit = True
        if hit:
            if y < miny:
                miny = y
            maxy = y
    if maxx < 0:
        raise ValueError('整张全白，量不到内容')
    return minx, miny, maxx, maxy


def normalize(src, dst, aspect=OUT_W / float(OUT_H)):
    from PIL import Image
    im = Image.open(src).convert('RGB')
    x0, y0, x1, y1 = content_bbox(im)
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0

    # 内容高度 → 输出高的 CONTENT_H_PCT，等比缩放
    s = (OUT_H * CONTENT_H_PCT) / ch
    crop_w, crop_h = OUT_W / s, OUT_H / s

    if crop_w > im.width or crop_h > im.height:
        raise ValueError('裁切框 %.0fx%.0f 超出源图 %dx%d' % (crop_w, crop_h, im.width, im.height))

    left = cx - crop_w / 2.0
    top = cy - crop_h / 2.0
    # 越界时平移回来（而不是裁掉内容）
    left = min(max(0.0, left), im.width - crop_w)
    top = min(max(0.0, top), im.height - crop_h)

    box = (int(round(left)), int(round(top)),
           int(round(left + crop_w)), int(round(top + crop_h)))
    out = im.crop(box).resize((OUT_W, OUT_H), Image.LANCZOS)
    # 扁平色块插画 → 128 色足够，体积能压掉四分之三
    out = out.convert('P', palette=Image.ADAPTIVE, colors=128)
    out.save(dst, 'PNG', optimize=True)

    return {
        'cw': cw, 'ch': ch, 'box': box, 'scale': s,
        'out_w_pct': cw * s / OUT_W, 'out_h_pct': ch * s / OUT_H,
        'bytes': os.path.getsize(dst),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只量不改')
    args = ap.parse_args()

    try:
        import PIL  # noqa: F401
    except ImportError:
        sys.exit('缺 Pillow。用 venv 解释器：\n'
                 '  C:\\Users\\apple\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe '
                 'scripts/normalize_board_cards.py')

    if not args.check:
        os.makedirs(RAW, exist_ok=True)

    print('源 → %dx%d (A=%.4f)  内容高目标 %.0f%%' % (OUT_W, OUT_H, OUT_W / float(OUT_H), CONTENT_H_PCT * 100))
    for n in NAMES:
        src = os.path.join(CARDS, n + '.png')
        if not os.path.exists(src):
            print('  %-12s 缺失' % n)
            continue
        if args.check:
            from PIL import Image
            im = Image.open(src).convert('RGB')
            x0, y0, x1, y1 = content_bbox(im)
            print('  %-12s 内容 %dx%d  占宽 %.0f%%  占高 %.0f%%'
                  % (n, x1 - x0 + 1, y1 - y0 + 1,
                     (x1 - x0 + 1) * 100.0 / im.width, (y1 - y0 + 1) * 100.0 / im.height))
            continue

        # 首次运行时把 AI 原图留档到 _raw/（脚本可重跑，不重复留档）
        raw = os.path.join(RAW, n + '.png')
        if not os.path.exists(raw):
            shutil.copyfile(src, raw)
        r = normalize(raw, src)
        print('  %-12s 内容 %dx%d → 输出占宽 %2.0f%% / 占高 %2.0f%%  %5.0f KB'
              % (n, r['cw'], r['ch'], r['out_w_pct'] * 100, r['out_h_pct'] * 100,
                 r['bytes'] / 1024.0))

    if not args.check:
        print('\n原图留档 → assets/board-cards/_raw/')


if __name__ == '__main__':
    main()

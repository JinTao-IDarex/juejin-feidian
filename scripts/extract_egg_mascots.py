# extract_egg_mascots.py — 从用户新参考图（AI 生成圆蛋吉祥物卡）抠出六只角色
#
# 口径沿用 v0.6.0 的定论：版式归版式、素材归素材 —— 只抠角色当插画，
# 卡面上的名次/分数/赛道名/定义/入口仍是活 DOM（board.js coverHTML）。
#
# 参考图：1536x1024，六张卡 3x2 网格（每格 512x512），角色在卡面上半部。
# 抠法：格内先按「亮度高 + 饱和度低」软键掉白卡底/浅灰云雾/工作室底，
# 再按剩余不透明像素的包围盒裁切（含道具：三叉戟/放大镜/纸堆/灯…），
# contain 到 CHAR_W x CHAR_H（356x292，check_extension.py 的尺寸契约）。
#
# 用法：
#   python scripts/extract_egg_mascots.py <参考图路径> [--out assets/board-cards] [--preview]
import argparse
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 与 check_extension.py 的 CHAR_W/CHAR_H、make_card_faces.py 的 CHAR_OUT_* 同口径
CHAR_W, CHAR_H = 356, 292

# 六张卡在参考图里的位置 = 赛道顺序（与 board.js TRACKS 一致）
CELLS = [
    ("c1-vicious", 0, 0), ("c2-absurd", 1, 0), ("c3-passive", 2, 0),
    ("c4-stubborn", 0, 1), ("c5-blah", 1, 1), ("c6-emo", 2, 1),
]


def key_cell(cell: Image.Image) -> Image.Image:
    """白卡底/浅灰云 → 透明。亮度高且饱和低的像素软键掉（云雾保留一点残影是刻意的）。"""
    rgba = cell.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            mx, mn = max(r, g, b), min(r, g, b)
            sat = (mx - mn) / 255.0
            bright = mx / 255.0
            # 低饱和且高亮（白卡底/浅灰云雾/工作室底）→ 透明，0.74→0.86 软 ramp：
            # 云雾(≥0.88)全键掉，白纸/气泡的白色也被键掉但**描边(偏暗)存活** ——
            # 目标底色本就是白卡面，白纸键掉后视觉不变。
            if sat < 0.14 and bright > 0.74:
                t = min(1.0, (bright - 0.74) / 0.12)
                px[x, y] = (r, g, b, int(a * (1.0 - t)))
    return rgba


def trim_alpha(im: Image.Image, thr: 40, pad: int = 6):
    """裁到不透明包围盒（含 pad）。全透明 → 返回 None。"""
    bbox = im.getbbox()  # 非零像素包围盒（alpha 阈值粗略）
    if not bbox:
        return None
    # 严格按 alpha>thr 收紧
    a = im.split()[3]
    strict = a.point(lambda v: 255 if v > thr else 0)
    bb = strict.getbbox()
    if not bb:
        return None
    l, t, r, b = bb
    l = max(0, l - pad); t = max(0, t - pad)
    r = min(im.width, r + pad); b = min(im.height, b + pad)
    return im.crop((l, t, r, b))


def fit_contract(im: Image.Image) -> Image.Image:
    """contain 到 356x292，且至少一边撑满（±0 —— 严格 contain 就满足）。"""
    scale = min(CHAR_W / im.width, CHAR_H / im.height)
    w, h = round(im.width * scale), round(im.height * scale)
    im = im.resize((w, h), Image.LANCZOS)
    canvas = Image.new("RGBA", (CHAR_W, CHAR_H), (0, 0, 0, 0))
    canvas.paste(im, ((CHAR_W - w) // 2, (CHAR_H - h) // 2), im)
    return canvas


# 角色带：只取卡面上部（顶部名次条之下、赛道名之上）。
# 参考图里角色占卡面高度的 ~45%，上下各让一点给道具（三叉戟举高/影子偏低）。
BAND_Y0, BAND_Y1 = 0.10, 0.62
BAND_X0, BAND_X1 = 0.06, 0.94


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", default=os.path.join(ROOT, "assets", "board-cards"))
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()

    src = Image.open(args.src).convert("RGB")
    W, H = src.size
    cw, ch = W // 3, H // 2

    previews = []
    for name, cx, cy in CELLS:
        cell = src.crop((cx * cw, cy * ch, (cx + 1) * cw, (cy + 1) * ch))
        # 先裁角色带：把顶部的名次/分数、中下的标题/副题/胶囊全切掉
        band = cell.crop((round(cell.width * BAND_X0), round(cell.height * BAND_Y0),
                          round(cell.width * BAND_X1), round(cell.height * BAND_Y1)))
        keyed = key_cell(band)
        cut = trim_alpha(keyed, thr=40, pad=6)
        if cut is None:
            print("!! %s 没抠到东西" % name)
            continue
        final = fit_contract(cut)
        out_path = os.path.join(args.out, "char-%s.png" % name)
        final.save(out_path)
        print("%s -> %s  (%dx%d)" % (name, out_path, final.width, final.height))
        if args.preview:
            pv = Image.new("RGBA", (CHAR_W + 16, CHAR_H + 16), (255, 220, 90, 255))
            pv.paste(final, (8, 8), final)
            previews.append((name, pv))

    if previews and args.preview:
        sheet = Image.new("RGB", ((CHAR_W + 16) * 3, (CHAR_H + 16) * 2), "white")
        d = None
        for i, (name, pv) in enumerate(previews):
            x = (i % 3) * (CHAR_W + 16); y = (i // 3) * (CHAR_H + 16)
            sheet.paste(pv, (x, y))
            d = ImageDraw.Draw(sheet)
            d.text((x + 10, y + 4), name, fill="black")
        pv_path = os.path.join(ROOT, "output", "egg-mascots-preview.png")
        os.makedirs(os.path.dirname(pv_path), exist_ok=True)
        sheet.convert("RGB").save(pv_path)
        print("preview ->", pv_path)


if __name__ == "__main__":
    main()

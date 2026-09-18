# -*- coding: utf-8 -*-
"""生成「主卡插画变体」预览板：A 矢量重绘 8 款 / B 照片抠图 3 款"""
import os, sys, base64, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from illustrations import SVGS

HERE = os.path.dirname(os.path.abspath(__file__))

META = [
    ("monitor_saturn",  "大头显示器 + 土星虫", "复古 CRT 摆在正中，虫子在右上角探出头"),
    ("crt_pet_inside",  "老式 CRT + 虫子在屏里", "圆润后壳 + 扫描线，虫子住在屏幕中央"),
    ("keyboard_saturn", "键盘 + 土星虫",       "虫子坐在键盘上，两个键帽点亮成蓝"),
    ("keyboard_drop",   "键盘 + 水滴鱼",       "水滴鱼坐在键帽上抱着星星"),
    ("screen_gem",      "显示器 + 晶石",       "屏幕里三张沸点卡，晶石从右上角探头"),
    ("all_pets",        "三只宠物合影",         "一台显示器，三只宠物并排从屏顶探出来"),
    ("saturn_hero",     "土星虫主视角",         "虫子坐在散开的牌堆上，光环最大"),
    ("drop_hero",       "水滴鱼主视角",         "抱星星许愿，背后放射光"),
]

PHOTO = [
    ("photo_monitor",  "大头显示器 + 土星虫", "原图宠物直接抠出来贴在显示器边"),
    ("photo_keyboard", "键盘 + 水滴鱼",       "原图水滴鱼坐在键盘上"),
    ("photo_all",      "三只宠物合影",         "三只原图宠物从屏顶并排探出"),
]


def photo_svg(pets):
    """pets: list of (relpath, x, y, h) —— 换算成 220x150 画布里的绝对位置"""
    out = ['<svg viewBox="0 0 220 150" fill="none" xmlns="http://www.w3.org/2000/svg">']
    # 显示器
    out.append('<rect x="34" y="34" width="120" height="84" rx="10" fill="#FFFFFF" stroke="#1A1D21" stroke-width="2.4"/>')
    out.append('<rect x="45" y="45" width="98" height="54" rx="6" fill="#EAF2FF" stroke="#1A1D21" stroke-width="1.9"/>')
    out.append('<path d="M57 58h50M57 69h66M57 80h38M57 91h58" stroke="#1E80FF" stroke-width="2.6" stroke-linecap="round" opacity="0.45"/>')
    out.append('<path d="M84 118v8M70 126h28" stroke="#1A1D21" stroke-width="2.2" stroke-linecap="round"/>')
    out.append('<circle cx="94" cy="110" r="2.6" fill="#1E80FF"/>')
    for rel, w, x, y, h in pets:
        p = os.path.join(HERE, rel)
        with open(p, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        out.append(f'<image x="{x}" y="{y}" width="{w}" height="{h}" '
                   f'href="data:image/png;base64,{b64}" preserveAspectRatio="xMidYMid meet"/>')
    out.append('</svg>')
    return "".join(out)

def keyboard_only(bg_svg):
    return bg_svg


def cell(no, name, tag, desc, svg, fname):
    return f'''<div class="cell">
<div class="hd"><span class="no">{no}</span><span class="nm">{name}</span><span class="tg">{tag}</span><span class="ds">{desc}</span></div>
<div class="cardbox"><div class="stage">{svg}</div></div>
<div class="kk">{fname}</div>
</div>'''


# 照片版 1：显示器 + 土星虫（贴在右侧，压在显示器边外）
photo_monitor = photo_svg([("png/saturn.png", 62, 150, 40, 62)])
# 照片版 2：键盘 + 水滴鱼（键盘单独画）
_kb = ('<svg viewBox="0 0 220 150" fill="none" xmlns="http://www.w3.org/2000/svg">'
       '<path d="M22 112l12-54 152 0 12 54Z" fill="#FFFFFF" stroke="#1A1D21" stroke-width="2.4" stroke-linejoin="round"/>'
       '<path d="M46 66l8-0M78 66h8M110 66h8M142 66h8M56 84h8M88 84h8M120 84h8M48 102h8M80 102h8M112 102h8M144 102h8" stroke="#1A1D21" stroke-width="7" stroke-linecap="round"/>'
       '</svg>')
_b64 = base64.b64encode(open(os.path.join(HERE, "png/drop.png"), "rb").read()).decode()
photo_keyboard = _kb[:-6] + f'<image x="86" y="32" width="46" height="66" href="data:image/png;base64,{_b64}" preserveAspectRatio="xMidYMid meet"/></svg>'
# 照片版 3：三只宠物合影
photo_all = photo_svg([("png/saturn.png", 42, 38, 2, 40), ("png/drop.png", 34, 82, -2, 40), ("png/gem.png", 38, 124, 0, 38)])


cells_a = "".join(cell(i + 1, n, "矢量重绘", d, SVGS[k], k + ".svg") for i, (k, n, d) in enumerate(META))
cells_b = "".join(cell(i + 1, n, "照片抠图", d, sv, fname)
                  for i, ((fname, n, d), sv) in enumerate(zip(PHOTO, [photo_monitor, photo_keyboard, photo_all])))

html = f'''<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>主卡插画变体 · 8+3 款</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#fff;font:400 13px/1.5 "Inter","PingFang SC","Microsoft YaHei",sans-serif;color:#16181D;padding:24px}}
h2{{font:700 16px/1.4 inherit;margin:0 0 4px}}
.sec{{max-width:1010px;margin:0 auto 30px}}
.sub{{color:#8A9099;font-size:12px;margin-bottom:14px}}
.grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}}
.cell{{border:1px solid #E5E7EA;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 8px 22px rgba(30,89,191,.07)}}
.hd{{display:flex;align-items:center;gap:8px;padding:9px 13px;border-bottom:1px solid #EEF0F2;background:#FAFBFC}}
.no{{width:21px;height:21px;border-radius:6px;background:#EAF2FF;color:#1E80FF;font-weight:700;font-size:12px;display:grid;place-items:center;flex:0 0 auto}}
.nm{{font-weight:600;font-size:12.5px;white-space:nowrap}}
.tg{{font-size:10.5px;padding:2px 7px;border-radius:5px;background:#F0F2F5;color:#7A828C;flex:0 0 auto}}
.tg.b{{background:#EAF2FF;color:#1E80FF}}
.ds{{color:#8A9099;font-size:11px;margin-left:auto;white-space:nowrap}}
.cardbox{{padding:12px;background:#F7F8FA}}
.stage{{height:172px;display:grid;place-items:center;background:#fff;border-radius:10px;border:1px solid #EDEFF2}}
.stage svg{{width:220px;height:150px;display:block}}
.kk{{font:11px/1 ui-monospace,Menlo,monospace;color:#C3C9D1;padding:0 13px 8px;background:#F7F8FA}}
</style></head><body>

<div class="sec"><h2>A · 矢量重绘宠物（与主卡线稿同一笔法）</h2>
<div class="sub">宠物按你给的原图 SVG 重画：2.4px 黑描边 + 双色蓝(#1E80FF / #EAF2FF)，和设计稿插画同一种语言，混排不打架、可无损缩放。</div>
<div class="grid">{cells_a}</div></div>

<div class="sec"><h2>B · 照片抠图宠物（你提供的原图直接用）</h2>
<div class="sub">黑底已抠成透明，保留原始配色与笔触，100% 还原你给的形象；代价是与线稿插画不是一套笔法，小尺寸下会更"实"。</div>
<div class="grid">{cells_b}</div></div>

</body></html>'''

with open(os.path.join(HERE, "插画变体预览.html"), "w", encoding="utf-8") as f:
    f.write(html)
print("ok", len(html))

# -*- coding: utf-8 -*-
"""
主卡插画 SVG 变体 —— 220x150 画布，与设计稿 7:2 同尺寸。
线稿语言：2.4px 描边 #1A1D21 + 蓝色点缀 #1E80FF / 浅蓝 #EAF2FF + 白填充。

每张都以「掘金宠物」为主角。宠物用矢量重绘（不是贴照片），
这样和主卡线稿插画语言一致；同时另外出一版「照片宠物」做对比。
"""

STROKE = "#1A1D21"
BLUE = "#1E80FF"
LIGHT = "#EAF2FF"
MID = "#D6E8FF"
GHOST = "#A8C7FF"
PAPER = "#FFFFFF"
SW = 2.4

# 宠物固有色
ORANGE = "#FF7A1A"
ORANGE_BODY = "#F97316"
RING_BACK = "#EFC21E"
RING_FRONT = "#FFD93B"
BODY_DARK = "#3A1F00"
GREEN = "#5FD9B4"
HORN = "#C9CEC9"
PINK = "#FF9BB0"
SKIN = "#F4D7C0"
STAR = "#FFD93B"

SVGS = {}


def saturn(cx, cy, r, ring_front=True, eyes=True):
    """橙色土星虫。
    cx,cy = 身体中心；r = 身体半宽。

    参照原图的三段结构（自上而下）：
      1) 圆头尖顶的橙色身体（上半占大头）
      2) 黄色光环横穿**腰部偏下**，明显宽出身体
      3) 四条**细长**的腿垂在光环下方，必须露出来

    画法：光环后半（整椭圆）→ 身体 → 腿 → 光环前半（下弧）。
    这样光环的前弧压在身体和腿的上端，形成"环穿过身体"的正确遮挡。
    """
    bw = r * 1.0            # 身体半宽
    bh = r * 1.30           # 身体半高
    ring_ry = r * 0.30      # 光环竖直半径（扁）
    ring_rx = r * 1.62      # 光环水平半径（宽出身体）
    ry = cy + bh * 0.44     # 光环纵向位置：腰部偏下（原图约在身体 2/3 处）
    rsw = max(3.4, r * 0.30)   # 光环粗细

    body = (
        f'<path d="M{cx-bw:.1f} {cy+bh*0.34:.1f}'
        f'C{cx-bw:.1f} {cy-bh*0.58:.1f} {cx-bw*0.66:.1f} {cy-bh:.1f} {cx:.1f} {cy-bh:.1f}'
        f'C{cx+bw*0.66:.1f} {cy-bh:.1f} {cx+bw:.1f} {cy-bh*0.58:.1f} {cx+bw:.1f} {cy+bh*0.34:.1f}'
        f'L{cx+bw:.1f} {cy+bh*0.76:.1f}'
        f'C{cx+bw:.1f} {cy+bh*1.02:.1f} {cx+bw*0.66:.1f} {cy+bh*1.14:.1f} {cx:.1f} {cy+bh*1.14:.1f}'
        f'C{cx-bw*0.66:.1f} {cy+bh*1.14:.1f} {cx-bw:.1f} {cy+bh*1.02:.1f} {cx-bw:.1f} {cy+bh*0.76:.1f}Z"'
        f' fill="{ORANGE}" stroke="{STROKE}" stroke-width="1.9"/>'
    )

    # 四条细长腿：从身体底部长出来，长度足以露出光环之下
    legs = ""
    if r >= 11:
        lw = max(2.8, r * 0.22)
        leg_top = cy + bh * 1.02
        leg_len = r * 0.72
        for i in (-1.5, -0.5, 0.5, 1.5):
            lx = cx + i * r * 0.42
            legs += (f'<path d="M{lx:.1f} {leg_top:.1f}v{leg_len:.1f}"'
                     f' stroke="{ORANGE}" stroke-width="{lw:.1f}" stroke-linecap="round"/>')

    # 光环后半：完整椭圆（被身体压住）
    ring_back = (f'<ellipse cx="{cx:.1f}" cy="{ry:.1f}" rx="{ring_rx:.1f}" ry="{ring_ry:.1f}"'
                 f' fill="none" stroke="{RING_BACK}" stroke-width="{rsw:.1f}"/>')
    # 光环前半：下半弧，覆盖身体与腿的上端
    ring_front_s = (
        f'<path d="M{cx-ring_rx:.1f} {ry:.1f}'
        f'A{ring_rx:.1f} {ring_ry:.1f} 0 0 0 {cx+ring_rx:.1f} {ry:.1f}"'
        f' fill="none" stroke="{RING_FRONT}" stroke-width="{rsw:.1f}" stroke-linecap="round"/>'
    ) if ring_front else ""

    # 眯眼「U」：位于光环上方、身体中上部
    eye = ""
    if eyes:
        ew = max(2.8, r * 0.20)
        eh = max(3.6, r * 0.28)
        ex = r * 0.27
        ey = cy - bh * 0.24
        eye = (f'<path d="M{cx-ex-ew/2:.1f} {ey:.1f}v{eh:.1f}'
               f'M{cx-ex-ew/2:.1f} {ey:.1f}h{ew:.1f}v{eh:.1f}'
               f'M{cx+ex-ew/2:.1f} {ey:.1f}v{eh:.1f}'
               f'M{cx+ex-ew/2:.1f} {ey:.1f}h{ew:.1f}v{eh:.1f}"'
               f' stroke="{BODY_DARK}" stroke-width="{max(1.7, r*0.13):.1f}"'
               f' stroke-linecap="round" stroke-linejoin="round" fill="none"/>')

    return f'<g>{ring_back}{body}{legs}{ring_front_s}{eye}</g>'


def drop(cx, cy, r, star=True):
    """蓝色水滴鱼：上尖下圆的梨形，细长腿 + 蓝鞋，抱一颗黄星。
    原图特征：身体是**水滴**（顶尖、下宽圆），眼睛是两道下弯的弧（笑眯眯），
    腿很细很长（占身体高度近一半），鞋子是两条蓝色短横。
    """
    bh = r * 1.42
    body = (
        f'<path d="M{cx:.1f} {cy-bh:.1f}'
        f'C{cx+r*0.74:.1f} {cy-bh*0.66:.1f} {cx+r:.1f} {cy-bh*0.10:.1f} {cx+r:.1f} {cy+bh*0.22:.1f}'
        f'C{cx+r:.1f} {cy+bh*0.74:.1f} {cx+r*0.56:.1f} {cy+bh:.1f} {cx:.1f} {cy+bh:.1f}'
        f'C{cx-r*0.56:.1f} {cy+bh:.1f} {cx-r:.1f} {cy+bh*0.74:.1f} {cx-r:.1f} {cy+bh*0.22:.1f}'
        f'C{cx-r:.1f} {cy-bh*0.10:.1f} {cx-r*0.74:.1f} {cy-bh*0.66:.1f} {cx:.1f} {cy-bh:.1f}Z"'
        f' fill="{BLUE}" stroke="{STROKE}" stroke-width="1.9"/>'
    )
    # 细长腿：从身体下部垂下，长度约身体高的 40%
    leg_top = cy + bh * 0.86
    leg_h = r * 0.78
    lw = max(2.8, r * 0.26)
    legs = (f'<g>'
            f'<path d="M{cx-r*0.36:.1f} {leg_top:.1f}v{leg_h:.1f}'
            f'M{cx+r*0.36:.1f} {leg_top:.1f}v{leg_h:.1f}"'
            f' stroke="{SKIN}" stroke-width="{lw:.1f}" stroke-linecap="round"/>'
            f'<path d="M{cx-r*0.36-r*0.22:.1f} {leg_top+leg_h:.1f}h{r*0.44:.1f}'
            f'M{cx+r*0.36-r*0.22:.1f} {leg_top+leg_h:.1f}h{r*0.44:.1f}"'
            f' stroke="{BLUE}" stroke-width="{max(3.0,r*0.28):.1f}" stroke-linecap="round"/>'
            f'</g>')
    # 笑眯眯的下弯弧（原图是两道向下的弧）
    ey = cy - bh * 0.30
    aw = r * 0.40
    sm = max(1.7, r * 0.14)
    eyes = (f'<path d="M{cx-r*0.52:.1f} {ey:.1f}'
            f'c{r*0.10:.1f} -{r*0.24:.1f} {r*0.30:.1f} -{r*0.24:.1f} {r*0.40:.1f} 0'
            f'M{cx+r*0.12:.1f} {ey:.1f}'
            f'c{r*0.10:.1f} -{r*0.24:.1f} {r*0.30:.1f} -{r*0.24:.1f} {r*0.40:.1f} 0"'
            f' stroke="{STROKE}" stroke-width="{sm:.1f}" stroke-linecap="round" fill="none"/>')
    st = ""
    if star:
        sy = cy + bh * 0.20
        st = (f'<path d="M{cx:.1f} {sy-r*0.36:.1f}'
              f'l{r*0.20:.1f} {r*0.44:.1f} {r*0.48:.1f} {r*0.05:.1f}'
              f'-{r*0.35:.1f} {r*0.33:.1f} {r*0.09:.1f} {r*0.47:.1f}'
              f'-{r*0.42:.1f} -{r*0.24:.1f} -{r*0.42:.1f} {r*0.24:.1f}'
              f'{r*0.09:.1f} -{r*0.47:.1f} -{r*0.35:.1f} -{r*0.33:.1f}'
              f'{r*0.48:.1f} -{r*0.05:.1f}Z"'
              f' fill="{STAR}" stroke="{STROKE}" stroke-width="1.5" stroke-linejoin="round"/>')
    return f'<g>{legs}{body}{eyes}{st}</g>'


def gem(cx, cy, r):
    """晶石（严格对着用户原图重画）：绿松石斜切水滴形身体，
    顶部两枚灰白圆顶犄角、右侧大珊瑚红圆点眼（内白圈+黑瞳）、
    左侧一道弧形纹、左下角带一个斜切缺口。"""
    # 身体轮廓：右上尖 -> 右缘外扩 -> 底圆 -> 左下斜切缺口 -> 左侧尖
    body = (f'M{cx-0.78*r:.1f} {cy-0.52*r:.1f}'
            f'C{cx-0.40*r:.1f} {cy-1.06*r:.1f} {cx+0.20*r:.1f} {cy-1.14*r:.1f} {cx+0.46*r:.1f} {cy-0.92*r:.1f}'
            f'C{cx+0.96*r:.1f} {cy-0.50*r:.1f} {cx+1.04*r:.1f} {cy+0.24*r:.1f} {cx+0.78*r:.1f} {cy+0.60*r:.1f}'
            f'C{cx+0.52*r:.1f} {cy+0.98*r:.1f} {cx-0.10*r:.1f} {cy+1.06*r:.1f} {cx-0.46*r:.1f} {cy+0.86*r:.1f}'
            f'C{cx-0.72*r:.1f} {cy+0.72*r:.1f} {cx-0.90*r:.1f} {cy+0.30*r:.1f} {cx-0.86*r:.1f} {cy-0.10*r:.1f}'
            f'C{cx-0.84*r:.1f} {cy-0.30*r:.1f} {cx-0.82*r:.1f} {cy-0.42*r:.1f} {cx-0.78*r:.1f} {cy-0.52*r:.1f}Z')
    body_el = (f'<path d="{body}" fill="{GREEN}" stroke="{STROKE}" stroke-width="1.9"'
               f' stroke-linejoin="round"/>')
    # 顶部两枚犄角（灰白圆顶，中间一道竖凹槽）
    horns = ""
    for hx, hw in ((cx - 0.30 * r, 0.34), (cx + 0.02 * r, 0.34)):
        horns += (f'<path d="M{hx-hw*r/2:.1f} {cy-0.86*r:.1f}'
                  f'C{hx-hw*r/2:.1f} {cy-1.30*r:.1f} {hx+hw*r/2:.1f} {cy-1.30*r:.1f}'
                  f' {hx+hw*r/2:.1f} {cy-0.86*r:.1f}Z"'
                  f' fill="{HORN}" stroke="{STROKE}" stroke-width="1.4" stroke-linejoin="round"/>'
                  f'<path d="M{hx:.1f} {cy-1.13*r:.1f}v{0.25*r:.1f}"'
                  f' stroke="{STROKE}" stroke-width="1.1" opacity="0.55"/>')
    # 右眼：大珊瑚红圆 + 内层白圈 + 黑瞳
    ex, ey = cx + 0.44 * r, cy - 0.38 * r
    eye = (f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="{r*0.26:.1f}"'
           f' fill="{PINK}" stroke="{STROKE}" stroke-width="1.4"/>'
           f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="{r*0.11:.1f}"'
           f' fill="{PAPER}" stroke="{STROKE}" stroke-width="1.1"/>'
           f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="{r*0.05:.1f}" fill="{STROKE}"/>')
    # 左侧弧形纹
    arc = (f'<path d="M{cx-0.52*r:.1f} {cy-0.10*r:.1f}'
           f'C{cx-0.34*r:.1f} {cy+0.34*r:.1f} {cx-0.02*r:.1f} {cy+0.44*r:.1f}'
           f' {cx+0.16*r:.1f} {cy+0.26*r:.1f}"'
           f' stroke="{STROKE}" stroke-width="1.5" fill="none" stroke-linecap="round"/>')
    return f'<g>{body_el}{horns}{eye}{arc}</g>'

def star4(x, y, s, fill=BLUE):
    return (f'<path d="M{x:.1f} {y-s:.1f}l{s*0.32:.1f} {s*0.68:.1f} {s*0.68:.1f} {s*0.32:.1f}'
            f'-{s*0.68:.1f} {s*0.32:.1f}-{s*0.32:.1f} {s*0.68:.1f}'
            f'-{s*0.32:.1f}-{s*0.68:.1f}-{s*0.68:.1f}-{s*0.32:.1f}'
            f'{s*0.68:.1f}-{s*0.32:.1f}Z" fill="{fill}"/>')

# ---------------------------------------------------------------- 插画变体（用组件拼装）

def _svg(inner):
    return ('<svg viewBox="0 0 220 150" fill="none" xmlns="http://www.w3.org/2000/svg">'
            + inner + '</svg>')


# ---------------------------------------------------------------- 1. 大头显示器 + 土星虫
# 复古 CRT 显示器摆在正中，屏幕里跑代码行，橙色土星虫从右上角探出来
SVGS["monitor_saturn"] = _svg(
    f'<rect x="30" y="30" width="126" height="90" rx="11" fill="{PAPER}" stroke="{STROKE}" stroke-width="{SW}"/>'
    + f'<rect x="42" y="42" width="102" height="58" rx="7" fill="{LIGHT}" stroke="{STROKE}" stroke-width="1.9"/>'
    + f'<path d="M54 56h56M54 68h74M54 80h42M54 92h64" stroke="{BLUE}" stroke-width="2.6" stroke-linecap="round" opacity="0.5"/>'
    + f'<path d="M54 56h34M54 80h26" stroke="{BLUE}" stroke-width="2.6" stroke-linecap="round"/>'
    + f'<path d="M82 120v9M68 129h32" stroke="{STROKE}" stroke-width="2.2" stroke-linecap="round"/>'
    + f'<circle cx="93" cy="112" r="2.6" fill="{BLUE}"/>'
    + saturn(172, 46, 25)
)

# ---------------------------------------------------------------- 2. 老式 CRT（圆壳）+ 土星虫在屏里
SVGS["crt_pet_inside"] = _svg(
    f'<path d="M26 32c0-7 5.6-12.6 12.6-12.6h142.8c7 0 12.6 5.6 12.6 12.6v64'
    f'c0 7-5.6 12.6-12.6 12.6H38.6C31.6 108.6 26 103 26 96z"'
    f' fill="{PAPER}" stroke="{STROKE}" stroke-width="{SW}"/>'
    + f'<rect x="40" y="34" width="140" height="62" rx="10" fill="{LIGHT}" stroke="{STROKE}" stroke-width="2.1"/>'
    + saturn(110, 64, 26)
    + f'<g stroke="{BLUE}" opacity="0.10">'
      f'<path d="M40 46h140M40 58h140M40 70h140M40 82h140" stroke-width="5"/></g>'
    + f'<path d="M50 40h20l-14 20H42z" fill="{PAPER}" opacity="0.6"/>'
    + f'<path d="M96 109v10h28v-10" fill="{PAPER}" stroke="{STROKE}" stroke-width="2.1" stroke-linejoin="round"/>'
    + f'<path d="M72 124h76" stroke="{STROKE}" stroke-width="2.6" stroke-linecap="round"/>'
    + f'<path d="M54 114v8M64 114v8M156 114v8M166 114v8" stroke="{STROKE}" stroke-width="1.6" opacity="0.3" stroke-linecap="round"/>'
    + f'<circle cx="110" cy="117" r="2.8" fill="{BLUE}"/>'
)

# ---------------------------------------------------------------- 3. 键盘 + 土星虫
SVGS["keyboard_saturn"] = _svg(
    f'<path d="M22 128l19-56h138l19 56z" fill="{LIGHT}" stroke="{STROKE}" stroke-width="{SW}" stroke-linejoin="round"/>'
    + f'<g fill="{PAPER}" stroke="{STROKE}" stroke-width="1.6">'
      f'<rect x="46" y="80" width="16" height="13" rx="3.2"/><rect x="66" y="80" width="16" height="13" rx="3.2"/>'
      f'<rect x="86" y="80" width="16" height="13" rx="3.2"/><rect x="106" y="80" width="16" height="13" rx="3.2"/>'
      f'<rect x="126" y="80" width="16" height="13" rx="3.2"/><rect x="146" y="80" width="16" height="13" rx="3.2"/>'
      f'<rect x="52" y="98" width="16" height="13" rx="3.2"/><rect x="72" y="98" width="16" height="13" rx="3.2"/>'
      f'<rect x="92" y="98" width="42" height="13" rx="3.2"/><rect x="138" y="98" width="16" height="13" rx="3.2"/>'
      f'<rect x="158" y="98" width="16" height="13" rx="3.2"/>'
      f'<rect x="70" y="116" width="60" height="10" rx="3.2"/></g>'
    + f'<rect x="106" y="80" width="16" height="13" rx="3.2" fill="{BLUE}" stroke="{STROKE}" stroke-width="1.6"/>'
    + f'<rect x="92" y="98" width="42" height="13" rx="3.2" fill="{MID}" stroke="{STROKE}" stroke-width="1.6"/>'
    + saturn(110, 58, 30)
    + star4(176, 44, 11)
)

# ---------------------------------------------------------------- 4. 键盘 + 水滴鱼
SVGS["keyboard_drop"] = _svg(
    f'<path d="M22 128l19-56h138l19 56z" fill="{LIGHT}" stroke="{STROKE}" stroke-width="{SW}" stroke-linejoin="round"/>'
    + f'<g fill="{PAPER}" stroke="{STROKE}" stroke-width="1.6">'
      f'<rect x="46" y="80" width="16" height="13" rx="3.2"/><rect x="66" y="80" width="16" height="13" rx="3.2"/>'
      f'<rect x="86" y="80" width="16" height="13" rx="3.2"/><rect x="106" y="80" width="16" height="13" rx="3.2"/>'
      f'<rect x="126" y="80" width="16" height="13" rx="3.2"/><rect x="146" y="80" width="16" height="13" rx="3.2"/>'
      f'<rect x="52" y="98" width="16" height="13" rx="3.2"/><rect x="72" y="98" width="16" height="13" rx="3.2"/>'
      f'<rect x="138" y="98" width="16" height="13" rx="3.2"/><rect x="158" y="98" width="16" height="13" rx="3.2"/>'
      f'<rect x="70" y="116" width="60" height="10" rx="3.2"/></g>'
    + f'<rect x="92" y="98" width="42" height="13" rx="3.2" fill="{MID}" stroke="{STROKE}" stroke-width="1.6"/>'
    + drop(112, 62, 26)
    + star4(52, 44, 11)
)

# ---------------------------------------------------------------- 5. 显示器 + 晶石
SVGS["screen_gem"] = _svg(
    f'<rect x="20" y="26" width="152" height="98" rx="11" fill="{PAPER}" stroke="{STROKE}" stroke-width="{SW}"/>'
    + f'<rect x="30" y="36" width="132" height="78" rx="7" fill="{LIGHT}" stroke="{STROKE}" stroke-width="1.9"/>'
    + f'<rect x="40" y="45" width="54" height="30" rx="5" fill="{MID}"/>'
    + f'<rect x="101" y="45" width="54" height="30" rx="5" fill="{BLUE}"/>'
    + f'<rect x="40" y="81" width="115" height="26" rx="5" fill="{PAPER}" stroke="{STROKE}" stroke-width="1.5"/>'
    + f'<path d="M46 53h32M46 63h42M46 72h26" stroke="{BLUE}" stroke-width="2.4" stroke-linecap="round"/>'
    + f'<path d="M107 53h32M107 63h42M107 72h26" stroke="{PAPER}" stroke-width="2.4" stroke-linecap="round"/>'
    + f'<path d="M46 89h32M46 99h60" stroke="{STROKE}" stroke-width="2.2" stroke-linecap="round" opacity="0.35"/>'
    + f'<path d="M84 124v8M66 132h52" stroke="{STROKE}" stroke-width="2.2" stroke-linecap="round"/>'
    + gem(178, 44, 26)
    + star4(196, 108, 10)
)

# ---------------------------------------------------------------- 6. 三只宠物合影
SVGS["all_pets"] = _svg(
    f'<rect x="22" y="38" width="176" height="90" rx="11" fill="{PAPER}" stroke="{STROKE}" stroke-width="{SW}"/>'
    + f'<rect x="32" y="48" width="156" height="70" rx="7" fill="{LIGHT}" stroke="{STROKE}" stroke-width="1.9"/>'
    + star4(56, 72, 11)
    + f'<path d="M76 68h54M76 80h72M76 92h40" stroke="{STROKE}" stroke-width="2.4" stroke-linecap="round" opacity="0.3"/>'
    + f'<path d="M76 104h58" stroke="{BLUE}" stroke-width="2.6" stroke-linecap="round"/>'
    + f'<path d="M100 128v9M80 137h44" stroke="{STROKE}" stroke-width="2.2" stroke-linecap="round"/>'
    + saturn(64, 26, 21)
    + drop(110, 24, 20)
    + gem(158, 26, 21)
)

# ---------------------------------------------------------------- 7. 土星虫主视角
SVGS["saturn_hero"] = _svg(
    f'<g stroke="{STROKE}" stroke-width="2.1">'
    f'<rect x="30" y="94" width="84" height="52" rx="8" fill="{PAPER}" transform="rotate(-8 72 120)"/>'
    f'<rect x="52" y="94" width="84" height="52" rx="8" fill="{LIGHT}" transform="rotate(4 94 120)"/>'
    f'<rect x="74" y="94" width="84" height="52" rx="8" fill="{PAPER}" transform="rotate(14 116 120)"/></g>'
    + f'<path d="M92 112h40M92 124h24" stroke="{STROKE}" stroke-width="2.1" stroke-linecap="round"'
      f' transform="rotate(14 116 120)" opacity="0.45"/>'
    + saturn(108, 58, 34)
    + star4(170, 48, 13)
    + star4(190, 84, 8, GHOST)
    + star4(30, 60, 7, GHOST)
)

# ---------------------------------------------------------------- 8. 水滴鱼主视角
SVGS["drop_hero"] = _svg(
    f'<g stroke="{GHOST}" stroke-width="2.4" stroke-linecap="round" opacity="0.7">'
    f'<path d="M110 8v13M62 22l8 10M158 22l-8 10M36 58l11 5M184 58l-11 5"/></g>'
    + drop(110, 74, 36)
    + star4(42, 100, 11)
    + star4(178, 100, 11)
)

if __name__ == "__main__":
    import os
    out = os.path.dirname(os.path.abspath(__file__))
    for k, v in SVGS.items():
        with open(os.path.join(out, k + ".svg"), "w", encoding="utf-8") as f:
            f.write(v)
    print("wrote", len(SVGS), "svgs:", ", ".join(SVGS))

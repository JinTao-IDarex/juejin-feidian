# -*- coding: utf-8 -*-
"""check_extension.py — 扩展包的静态自检（不启动浏览器）

本机没法给 Chrome 加载未打包扩展（agent-browser 起不了 --load-extension），
所以 chrome.* 那几行胶水代码只能靠静态检查兜。这里做四件事：

  1) manifest.json 能解析，且它引用的每个文件都真实存在
  2) 每个 JS 语法可用（node --check；ESM 的复制成 .mjs 再 check）
  3) host.html 的注入顺序正确（embed.css 在 app.css 后；两个脚本必须早于 app.js）
  4) 构建补丁确实打上了（__JB_HOST__ 出现次数）

用法：  python scripts/check_extension.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = r"D:\2workspace\codex\juejin-boom"
EXT = os.path.join(ROOT, "extension")
NODE = r"C:\Users\apple\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

problems = []
notes = []


def need(rel, why):
    p = os.path.join(EXT, rel)
    if not os.path.exists(p):
        problems.append("缺失文件 %s（%s）" % (rel, why))
        return None
    return p


# ---------------- 1) manifest ----------------
mf = need("manifest.json", "扩展清单")
man = None
if mf:
    try:
        man = json.load(open(mf, encoding="utf-8"))
        notes.append("manifest 解析通过：name=%s version=%s" % (man.get("name"), man.get("version")))
    except Exception as e:
        problems.append("manifest.json 不是合法 JSON：%r" % (e,))

if man:
    for k, v in (man.get("icons") or {}).items():
        need(v, "图标 %s" % k)
    for cs in man.get("content_scripts", []):
        for f in cs.get("js", []):
            need(f, "content_scripts")
    bg = (man.get("background") or {}).get("service_worker")
    if bg:
        need(bg, "background service_worker")
    for war in man.get("web_accessible_resources", []):
        for r in war.get("resources", []):
            if "*" in r:
                base = r.split("*")[0].rstrip("/")
                if base and not os.path.isdir(os.path.join(EXT, base)):
                    problems.append("web_accessible_resources 通配目录不存在：%s" % r)
            else:
                need(r, "web_accessible_resources")
    notes.append("manifest 引用的文件全部存在")

# ---------------- 2) JS 语法 ----------------
tmpdir = tempfile.mkdtemp(prefix="jbchk_")
for name in ("content.js", "api-shim.js", "embed-boot.js", "background.js", "api.mjs",
             "board.js", "board-core.mjs"):
    src = os.path.join(EXT, name)
    if not os.path.exists(src):
        problems.append("缺失文件 %s" % name)
        continue
    # .js 里带 import/export 的按 ESM 解析（extension/ 下没有 package.json）
    text = open(src, encoding="utf-8").read()
    is_esm = re.search(r"^\s*(import|export)\s", text, re.M) is not None
    if is_esm and name.endswith(".mjs"):
        target = src
    elif is_esm:
        target = os.path.join(tmpdir, name.replace(".js", ".mjs"))
        shutil.copyfile(src, target)
    else:
        target = src
    r = subprocess.run([NODE, "--check", target], capture_output=True, text=True)
    if r.returncode != 0:
        problems.append("语法错误 %s：%s" % (name, (r.stderr or "").strip().splitlines()[:3]))
    else:
        notes.append("语法通过 %-14s %s" % (name, "ESM" if is_esm else "CJS"))

# ---------------- 3) host.html 注入顺序 ----------------
host = need("host.html", "扩展页面")
if host:
    h = open(host, encoding="utf-8").read()
    order = ["app.css", "embed.css", "embed-boot.js", "api-shim.js", "data.js", "app.js"]
    pos = {}
    for name in order:
        # 必须按标签找，不能按裸文件名找：host.html 第 175 行的注释里就出现过
        # "卡牌由 app.js 按 STYLES 预设生成"，按裸名找会把注释位置当成脚本位置，
        # 从而误判成「data.js 排在 app.js 后面」。
        tag = ('src="%s"' % name) if name.endswith(".js") else ('href="%s"' % name)
        i = h.find(tag)
        pos[name] = i
        if i < 0:
            problems.append("host.html 里找不到 %s" % tag)
    if all(pos[n] >= 0 for n in order):
        if not (pos["app.css"] < pos["embed.css"]):
            problems.append("embed.css 必须在 app.css 之后（靠层叠覆盖）")
        for must_early in ("embed-boot.js", "api-shim.js"):
            if not (pos[must_early] < pos["data.js"] < pos["app.js"]):
                problems.append("%s 必须早于 data.js / app.js" % must_early)
        notes.append("host.html 注入顺序正确：" + " < ".join(order))

# ---------------- 3b) board.html 注入顺序 ----------------
# ⚠️ 与 host.html 的约束**相反**：board.css 顶部那条 `html.embed { --k: 1 !important }`
#    要压过 embed.css 的 `--k: var(--jb-k,1) !important`，同优先级下后写的赢 ——
#    所以 embed.css 必须排在 board.css **之后**。写反了浮层会按宿主的 k 缩放，版式错位。
board = need("board.html", "扩展里的魔鬼榜单页")
if board:
    b = open(board, encoding="utf-8").read()
    border = ["board.css", "embed.css", "embed-boot.js", "api-shim.js", "board.js"]
    bpos = {}
    for name in border:
        tag = ('src="%s"' % name) if name.endswith(".js") else ('href="%s"' % name)
        i = b.find(tag)
        bpos[name] = i
        if i < 0:
            problems.append("board.html 里找不到 %s" % tag)
    if all(bpos[n] >= 0 for n in border):
        if not (bpos["board.css"] < bpos["embed.css"]):
            problems.append("embed.css 必须排在 board.css 之后（board.css 的 html.embed 要压过它）")
        for must_early in ("embed-boot.js", "api-shim.js"):
            if not (bpos[must_early] < bpos["board.js"]):
                problems.append("board.html：%s 必须早于 board.js" % must_early)
        for forbidden in ('href="app.css"', 'src="app.js"', 'src="data.js"'):
            if forbidden in b:
                problems.append("board.html 不该引 %s（榜单是独立一套版式，不共用抽卡页）" % forbidden)
        notes.append("board.html 注入顺序正确：" + " < ".join(border))

# ---------------- 3b2) 榜期卡（v0.7.0）与 peek 只读链路 ----------------
# ⚠️ 这几条断言对应的都是**不抛异常**的坑，静态检查是唯一的网：
#   ① peek 漏转发 → 前端以为在只读、实际走 ensure() → 翻 45 页 + 烧 token
#   ② peerCache 读写两个 key → 对面列永远「尚未生成」，界面看着像没数据
#   ③ html.embed 档位被架空 → 浮层里 210×34 的紧凑版式静默失效（不报错，只是变松）
bj = need("board.js", "扩展里的榜单脚本")
site_board = os.path.join(ROOT, "site", "board.js")
peek_sites = []
for rel in ("site/serve.mjs", "extension/api.mjs", "extension/background.js"):
    p = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.exists(p):
        problems.append("缺 %s —— 接口层必须与站点同步（项目硬约定）" % rel)
        continue
    s = open(p, encoding="utf-8").read()
    if re.search(r"peek", s):
        peek_sites.append(rel)
    else:
        problems.append("%s 里没有 peek —— 展开榜期卡会静默触发一次真评分" % rel)

if bj and os.path.exists(site_board):
    j = open(bj, encoding="utf-8").read()
    js2 = open(site_board, encoding="utf-8").read()
    if j != js2:
        problems.append("extension/board.js 与 site/board.js 不一致 —— 改前端只改 site/ 再重建")
    # 榜期卡的三段结构在 **HTML** 里，JS 只按 id 取
    if os.path.exists(board):
        bh = open(board, encoding="utf-8").read()
        for need_id in ('id="rngCard"', 'id="rngRows"', 'id="rngSum"'):
            if need_id not in bh:
                problems.append("board.html 里没有 %s（榜期卡面板结构缺一块）" % need_id)
    for f, s2 in (("extension/board.js", j), ("site/board.js", js2)):
        if 'id="seg"' in s2 or 'class="seg' in s2:
            problems.append("%s 还留着旧的分段控件 .seg（v0.7.0 已换成榜期卡 .rng）" % f)
    if "peek=1" not in j:
        problems.append("board.js 的 loadPeer() 没带 peek=1 —— 「看一眼周榜」会变成一次真评分")
    # ⭐ 读写 key 必须一致：paintRangePop 只能按对面档 id 取。
    #    只看**代码**，别匹配注释（注释里就写着这个反例，当判据会永远误报）。
    #    ⚠️ 剥离块注释要用跨行模式；逐行 re.S 是无效的（块注释本来就跨行）。
    code = re.sub(r"/\*.*?\*/", "", j, flags=re.S)
    code = re.sub(r"//[^\n]*", "", code)
    if re.search(r"peerCache\[\s*S\.range\s*\]", code):
        problems.append("paintRangePop 读了 peerCache[S.range]（当前档），"
                        "而 loadPeer 写的是 peerCache[peer.id]（对面档）→ 对面列永远是「尚未生成」")
    if "peerBusy" not in code:
        problems.append("在途标记还挂在 RANGES[].busy 上（换档会串味），应用独立的 peerBusy")
    # 空榜 ≠ 未生成：两套文案必须在
    for kw in ("尚未生成", "空榜"):
        if kw not in j:
            problems.append("差异文案缺「%s」—— 未生成与空榜必须区分（0 张会被误读成空榜）" % kw)

# embed 档位可达性：board.css 里的 html.embed 规则只有在 embed-boot.js 打了类之后才有意义
bcss = os.path.join(EXT, "board.css")
eboot = os.path.join(EXT, "embed-boot.js")
if os.path.exists(bcss) and os.path.exists(eboot) and os.path.exists(board):
    css = open(bcss, encoding="utf-8").read()
    boot = open(eboot, encoding="utf-8").read()
    b = open(board, encoding="utf-8").read()
    n_rng_embed = len(re.findall(r"html\.embed \.rng", css))
    if n_rng_embed == 0:
        problems.append("board.css 没有 html.embed 的榜期卡档位 —— 浮层里会用站点版的 236×44 松散尺寸")
    if "classList.add('embed')" not in boot and 'classList.add("embed")' not in boot:
        problems.append("embed-boot.js 不再给 <html> 打 embed 类 —— 浮层全部 html.embed 档位会静默失效")
    if "embed-boot.js" not in b:
        problems.append("board.html 不引 embed-boot.js —— 浮层里 html.embed 永远打不上")
    if "embed.css" not in b:
        problems.append("board.html 不引 embed.css")
    if n_rng_embed and os.path.exists(os.path.join(EXT, "board.js")):
        notes.append("榜期卡浮层档位齐全：board.css 有 %d 条 html.embed .rng 规则，"
                     "embed-boot.js 打 embed 类，board.html 两个都引了" % n_rng_embed)
if peek_sites:
    notes.append("peek 只读链路三处齐全（%s）—— 展开榜期卡不会触发真评分" % "、".join(peek_sites))

# ---------------- 3c) 榜单卡牌形象 ----------------
cards_dir = os.path.join(EXT, "cards")
got = []
if not os.path.isdir(cards_dir):
    problems.append("缺失目录 cards/（board.js 里按 cards/xxx.png 取形象）")
else:
    got = sorted(x for x in os.listdir(cards_dir) if x.endswith(".png"))
    # 期望值从 board.js 的两张表反推 —— 别在这里写死文件名，否则改了素材命名
    # 自检就会静默失效（v0.5.0 踩过：旧名 c1-*.png 被换成 face-*/art-*，
    # 而这里还在查旧名，靠残留的废图碰巧全绿）。
    js = open(os.path.join(EXT, "board.js"), encoding="utf-8").read()
    want = []
    for table in ("CARD_CHAR", "CARD_ART"):
        blk = re.search(table + r"\s*=\s*\{(.*?)\}", js, re.S)
        if not blk:
            problems.append("board.js 里找不到 %s 表" % table)
            continue
        want += sorted(set(re.findall(r"'([A-Za-z0-9_\-]+)'", blk.group(1))))
    # 表里既有 key（venom…）也有 value（char-c1-vicious…），只保留像文件名的
    want = sorted(set(x for x in want if re.match(r"^(char|art)-", x)))
    missing = [w + ".png" for w in want if w + ".png" not in got]
    extra = [g for g in got if g[:-4] not in want]
    if missing:
        problems.append("cards/ 缺 %s" % ", ".join(missing))
    if extra:
        problems.append("cards/ 多出 %s（源码里已不用，构建的第 5 步应清理）"
                        % ", ".join(extra))
    if not missing and not extra:
        notes.append("cards/ 与 board.js 表格一致：%d 张" % len(got))

# ---------------- 3d) 封面牌尺寸契约（素材像素 ↔ CSS 变量 ↔ JS 常量） ----------------
# ⭐ v0.6.0 起封面牌回到 **1:1.4 纸牌比例**（202x283），形象区里贴的是从参考图里
#    **抠出来的角色**（透明底 contain）。这几处必须同时改，少改一处就会出现
#    「角色被拉伸」或「发牌落位对不上」—— 而这两种错都不会报错，只能靠眼睛看出来。
#    为什么不用截图反推：compare/量尺那套对透明角色图不适用，直接在源码层断言更可靠。


def _png_size(path):
    """读 PNG 的 IHDR，不依赖 Pillow —— 自检要在没装 PIL 时也能跑。"""
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return (int.from_bytes(head[16:20], "big"),
            int.from_bytes(head[20:24], "big"))


_css = open(os.path.join(EXT, "board.css"), encoding="utf-8").read()
_js = open(os.path.join(EXT, "board.js"), encoding="utf-8").read()

# ⚠️ 这两个值必须与 scripts/make_card_faces.py 的 CHAR_OUT_W / CHAR_OUT_H 一致
#    （= 封面牌形象区 178x146 的 2 倍图）。自检只读 extension/，读不到那个脚本。
CHAR_W, CHAR_H = 356, 292


def _cssnum(name):
    m = re.search(re.escape(name) + r"\s*:\s*(\d+)px", _css)
    return int(m.group(1)) if m else None


def _jsnum(name):
    m = re.search(re.escape(name) + r"\s*=\s*(\d+)", _js)
    return int(m.group(1)) if m else None


cw_css, ch_css, sh_css = (_cssnum("--cover-w"), _cssnum("--cover-h"), _cssnum("--stack-h"))
cw_js, ch_js = _jsnum("COVER_W"), _jsnum("COVER_H")

if None in (cw_css, ch_css, sh_css, cw_js, ch_js):
    problems.append("board.css / board.js 里找不到封面牌尺寸变量"
                    "（--cover-w / --cover-h / --stack-h、COVER_W / COVER_H）")
else:
    if (cw_css, ch_css) != (cw_js, ch_js):
        problems.append("封面牌尺寸不同步：board.css 是 %dx%d，board.js 的 COVER_* 是 %dx%d"
                        "（发牌飞行层按 board.js 渲染，不同步会落位对不上）"
                        % (cw_css, ch_css, cw_js, ch_js))
    if sh_css != ch_css + 18:
        problems.append("--stack-h(%d) 应等于 --cover-h(%d) + 18（底牌各错开 9px）"
                        % (sh_css, ch_css))
    # 封面牌必须与详情大牌同比例，否则发牌的单轴等比缩放会落位对不上
    big_w, big_h = _cssnum("--card-w"), _cssnum("--card-h")
    if big_w and big_h:
        if abs(ch_css / float(cw_css) - big_h / float(big_w)) > 0.005:
            problems.append("封面牌比例(%.4f)与详情大牌(%.4f)不一致 —— "
                            "发牌动画按单轴等比缩放写，两者必须同为 1:1.4"
                            % (ch_css / float(cw_css), big_h / float(big_w)))
        else:
            notes.append("封面牌 %dx%d 与详情大牌 %dx%d 同为 1:%.2f（发牌单轴缩放成立）"
                         % (cw_css, ch_css, big_w, big_h, big_h / float(big_w)))

    chars = [g for g in got if g.startswith("char-")]
    bad = []
    for f in chars:
        sz = _png_size(os.path.join(cards_dir, f))
        if not sz:
            bad.append("%s 不是合法 PNG" % f)
            continue
        w, h = sz
        # 出图口径 = 「contain 到 CHAR_W x CHAR_H」→ 至少一边撑满、两边都不超。
        # 这条能抓住「比例被改坏 / 尺寸被改坏」，又不需要写死每张的宽高。
        if w > CHAR_W or h > CHAR_H or abs(max(w / float(CHAR_W), h / float(CHAR_H)) - 1) > 0.02:
            bad.append("%s 是 %dx%d，应 contain 到 %dx%d 内且至少一边撑满"
                       % (f, w, h, CHAR_W, CHAR_H))
    if bad:
        problems.append("角色素材尺寸不对：%s" % "；".join(bad))
    elif chars:
        notes.append("角色素材契约一致：%d 张 char-*.png 都 contain 在 %dx%d 内，"
                     "对应封面牌 %dx%d（比例 1:%.2f）"
                     % (len(chars), CHAR_W, CHAR_H, cw_css, ch_css, ch_css / float(cw_css)))
    if len(chars) != 6:
        problems.append("char-*.png 应有 6 张，实际 %d 张" % len(chars))

# ---------------- 4) 补丁 ----------------
aj = os.path.join(EXT, "app.js")
if os.path.exists(aj):
    a = open(aj, encoding="utf-8").read()
    n = a.count("__JB_HOST__")
    if n != 3:
        problems.append("app.js 的 __JB_HOST__ 应出现 3 次（boot + refreshDeck + isExtHost），实际 %d 次" % n)
    else:
        notes.append("app.js 补丁正确：__JB_HOST__ 3 处（boot 实时拉取闸门 + refreshDeck 洗牌闸门 + isExtHost 登录探测）")
    if "build_extension.py" in a[:400]:
        notes.append("app.js 带「由构建生成」头注释")
    else:
        problems.append("app.js 缺「由构建生成」头注释，可能是被直接改过")

# ---------------- 汇总 ----------------
print("\n".join(notes))
print("")
if problems:
    print("发现问题 %d 个：" % len(problems))
    for p in problems:
        print("  ✗ " + p)
    shutil.rmtree(tmpdir, ignore_errors=True)
    sys.exit(1)
print("全部通过 ✓")
shutil.rmtree(tmpdir, ignore_errors=True)

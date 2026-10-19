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
# ⚠️ 不要写死版本号带 build 号的路径（22.22.2-3 / -6 换着来）。
# 踩过：managed node 目录名带 build 号、会随更新变，写死就FileNotFoundError。
# 这里现 ls 一次取实际存在的那个。
def _find_node():
    base = os.path.join(os.path.expanduser("~"), ".workbuddy", "binaries", "node", "versions")
    try:
        for name in sorted(os.listdir(base), reverse=True):
            exe = os.path.join(base, name, "node.exe")
            if os.path.exists(exe):
                return exe
    except Exception:
        pass
    return shutil.which("node") or "node"


NODE = _find_node()

problems = []
notes = []


def _read(path):
    """读文本文件，失败返回空串 —— 让断言能优雅降级而不是整个脚本炸掉。"""
    try:
        return open(path, encoding="utf-8").read()
    except Exception:
        return ""


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

# ---------------- 3a) 抽卡页顶部「魔鬼榜单」入口 ----------------
# v0.8.0：site/index.html 左上角加了一条导航 pill 跳 board.html。
# 为什么值得断言：它是**唯一**从抽卡页进榜单的路（首页原先零个 board 字样），
# 而它挂在 Hero 里 —— embed.css 有 `html.embed .hero{display:none}`，
# 哪天有人为了「让浮层也显示入口」去动 Hero 的 display，这里要能立刻发现
# 入口在浮层里根本不出现（浮层的进榜入口另走 content.js，不靠这条）。
_nav_site = os.path.join(ROOT, "site", "index.html")
if os.path.exists(_nav_site):
    _ih = open(_nav_site, encoding="utf-8").read()
    _m = re.search(r'<a class="nav-board"[^>]*href="([^"]+)"', _ih)
    if not _m:
        problems.append("site/index.html 没有 .nav-board 入口 —— 抽卡页进不去榜单"
                        "（href 用属性顺序敏感的写法匹配：class 必须在 href 之前）")
    elif _m.group(1) != "board.html":
        problems.append("抽卡页入口 href 是 %r，应为 board.html" % _m.group(1))
    elif host and 'class="nav-board"' not in h:
        problems.append("extension/host.html 里没有 .nav-board（构建产物未同步）")
    else:
        _acss = _read(os.path.join(ROOT, "site", "app.css"))
        if ".nav-board" not in _acss:
            problems.append("app.css 缺 .nav-board —— 入口会变成无样式的裸链接")
        if host and _m:
            notes.append("抽卡页 → 榜单入口在位：site/index.html 与 host.html 均含 "
                         ".nav-board（href=board.html，app.css 有样式）")

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
        problems.append("%s 里没有 peek —— API 面就不完整了（hold 内部还要用它）" % rel)
    # v1.3.1 hold/stop、v1.3.3 cancel 与 peek 同一种坑（三处漏一处 = 静默烧 token / 停不下来）：
    #   hold 漏转发 → 周榜首拉变成自动评分；
    #   stop 漏转发 → 「提前结束」按钮变成又一次 ensure，根本停不下来；
    #   cancel 漏转发 → 「取消本次评分」变成又一次 ensure，撤销不成反而重启一轮
    #                  （最糟的一种：用户明确说不要，却触发了完整的一次评分，还白烧 token）。
    for flag in ("hold", "stop", "cancel"):
        if not re.search(r"\b%s\b" % flag, s):
            problems.append("%s 里没有 %s —— 周榜不自动评 / 提前结束会静默失效" % (rel, flag))

if bj and os.path.exists(site_board):
    j = open(bj, encoding="utf-8").read()
    js2 = open(site_board, encoding="utf-8").read()
    if j != js2:
        problems.append("extension/board.js 与 site/board.js 不一致 —— 改前端只改 site/ 再重建")
    # 榜期切换（v1.3.2 直切分段）的结构在 **HTML** 里，JS 只按 id 取
    if os.path.exists(board):
        bh = open(board, encoding="utf-8").read()
        for need_id in ('id="rngSeg"', 'id="rngCap"',
                        'data-range="day"', 'data-range="week"'):
            if need_id not in bh:
                problems.append("board.html 里没有 %s（榜期切换分段按钮结构缺一块）" % need_id)
    for f, s2 in (("extension/board.js", j), ("site/board.js", js2)):
        if 'id="seg"' in s2 or 'class="seg' in s2:
            problems.append("%s 还留着旧的分段控件 .seg" % f)
    # v1.3.1/1.3.3 前端契约：周榜不自动评（hold）+ 提前结束（stop）+ 撤销（cancel）
    #
    # ⚠️ 两条规矩：
    #   ① **只认代码、不认注释** —— 匹配前先剥掉 /* */ 块注释。
    #      否则谁在注释里写一句「请求走 api/board?…&cancel=1」就能让断言假绿，
    #      而真正发请求的那个调用还没接上时全绿是真的假绿。
    #      （v1.4 第一天就撞上：cancelBoard 的注释写全了，fetch 还没捞到。）
    #   ② **认调用点、不认字面量** —— v1.4 起 stop/cancel 两个命令共用
    #      cmdBoard(cmd)，`'&' + cmd + '=1'` 是拼出来的，源码里没有 `&stop=1`
    #      这个字面量了。认字面量会误报，认调用点两种情况都罩得住。
    j_code = re.sub(r"/\*.*?\*/", "", j, flags=re.S)
    if "&hold=1" not in j_code:
        problems.append("board.js 的 fetchBoard 没带 &hold=1 —— 周榜首拉会自动开评分")
    for cmd, why in (("stop", "「提前结束」按钮停不下来"),
                     ("cancel", "「取消本次评分」停不下来")):
        # 两种写法都认：写死的字面量（v1.4 的 cmdBoard('&stop=1', …) 调用点）
        # 或传命令名由 cmdBoard 自己拼 '&'+cmd+'=1' —— 只要参数真的能出现在 URL 上就算数。
        _sent = ("&%s=1" % cmd) in j_code or re.search(r"cmdBoard\(\s*['\"]%s['\"]" % cmd, j_code)
        if not _sent:
            problems.append("board.js 没有把 %s 发到服务端（源码里既找不到 &%s=1 字面量、"
                            "也没有 cmdBoard('%s') 调用点）—— %s" % (cmd, cmd, cmd, why))
    # v1.3.2 换直切分段后，榜期卡那套（卡片/面板/loadPeer/peerCache）必须拔干净，
    # 留着 = 死代码 + 误导后人（历史坑的断言随之退役）
    for legacy in ("rngCard", "rngPop", "loadPeer", "peerCache", "toggleRangePop"):
        if legacy in j:
            problems.append("board.js 还留着旧榜期卡机制 %r —— v1.3.2 直切分段后这是死代码" % legacy)

# embed 档位可达性：board.css 里的 html.embed 规则只有在 embed-boot.js 打了类之后才有意义
bcss = os.path.join(EXT, "board.css")
eboot = os.path.join(EXT, "embed-boot.js")
if os.path.exists(bcss) and os.path.exists(eboot) and os.path.exists(board):
    css = open(bcss, encoding="utf-8").read()
    boot = open(eboot, encoding="utf-8").read()
    b = open(board, encoding="utf-8").read()
    n_rng_embed = len(re.findall(r"html\.embed \.rng", css))
    if n_rng_embed == 0:
        problems.append("board.css 没有 html.embed 的榜期切换档位 —— 浮层里会用站点版的松散尺寸")
    if "classList.add('embed')" not in boot and 'classList.add("embed")' not in boot:
        problems.append("embed-boot.js 不再给 <html> 打 embed 类 —— 浮层全部 html.embed 档位会静默失效")
    if "embed-boot.js" not in b:
        problems.append("board.html 不引 embed-boot.js —— 浮层里 html.embed 永远打不上")
    if "embed.css" not in b:
        problems.append("board.html 不引 embed.css")
    if n_rng_embed and os.path.exists(os.path.join(EXT, "board.js")):
        notes.append("榜期切换浮层档位齐全：board.css 有 %d 条 html.embed .rng 规则，"
                     "embed-boot.js 打 embed 类，board.html 两个都引了" % n_rng_embed)
if peek_sites:
    notes.append("peek/hold/stop/cancel 命令链路三处齐全（%s）—— "
                 "周榜不自动评、提前结束与撤销都不会被 ensure 兜底" % "、".join(peek_sites))

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

# ---------------- 5) 评分中发牌（v0.8.0） ----------------
# 这一屏最容易「改了站点忘了扩展」或「改了 CSS 忘了 HTML」，
# 而两种情况都**不报错**（发牌视图只是少一块 / 少一个 id）。
# 所以逐项断言：HTML 有视图与各 id、CSS 有两档变量、JS 有渲染与重置、
# 内核有 dealt 契约、前端 TRACKS 副本与内核 TRACKS 一致。
bh = os.path.join(EXT, "board.html")
bc = os.path.join(EXT, "board.css")
bj = os.path.join(EXT, "board.js")
bk = os.path.join(EXT, "board-core.mjs")
bhtml = _read(bh)
bcss = _read(bc)
bjs = _read(bj)
bcore = _read(bk)

for token, why in [('id="viewScoring"', "发牌视图容器"),
                   ('id="scPhase"', "四步阶段条"),
                   ('id="scDeck"', "六摞容器"),
                   ('id="scHall"', "发牌台"),
                   ('id="scHand"', "待发手牌"),
                   ('id="scHallNow"', "正在落位提示")]:
    if token not in bhtml:
        problems.append("board.html 缺 %s（%s）—— 评分中发牌整块不会渲染" % (token, why))
if 'id="viewScoring"' in bhtml and 'id="scHallNow"' in bhtml:
    notes.append("发牌视图骨架齐全：viewScoring + 阶段条 + 六摞 + 发牌台 + 手牌 + 落位提示")

# --sc-w / --sc-card-h 两档都要有，且卡牌必须仍是 1:1.4
scw = _cssnum("--sc-w")
if scw:
    notes.append("发牌牌宽 --sc-w = %dpx，卡高按 1:1.4 跟出（%.0fpx）"
                 % (scw, scw * 1.4))
else:
    problems.append("board.css 缺 --sc-w（发牌视图的牌宽）")
if "html.embed" in bcss and "--sc-w:" in bcss:
    notes.append("浮层档位 --sc-w 已收窄（board.css 的 html.embed 块里）")
else:
    problems.append("board.css 的 html.embed 块里没有 --sc-w —— 浮层 722 会溢出")

for cls in [".sc-phase", ".sc-deck", ".sc-pile", ".sc-card", ".sc-hall", ".sc-hand", ".sc-meta"]:
    if cls not in bcss:
        problems.append("board.css 缺样式 %s" % cls)

for fn in ["paintScoring", "showScoring", "scReset", "tintOf"]:
    if ("function " + fn) not in bjs and ("var " + fn) not in bjs:
        problems.append("board.js 缺发牌相关函数 %s" % fn)
if "Math.min(m, SC_FAN_MAX)" not in bjs:
    problems.append("board.js 的牌堆错开量没封顶（SC_FAN_MAX）—— "
                    "牌多了会压到赛道名上，且不报错")
if "scSeen" in bjs and "load(false, true)" not in bjs:
    problems.append("board.js 的轮询没带 isPoll —— 每 1.3s 会把六摞清空一次")
else:
    notes.append("发牌去重与轮询续期正确：scReset 只在非轮询的 load() 里调")

if "dealt: dealtLog.slice()" not in bcore:
    problems.append("board-core.mjs 的 progress 没带累积的 dealt —— "
                    "轮询只能看到最后一批，中间发出的牌会凭空消失")
else:
    notes.append("内核 dealt 契约在位：progress.dealt 累积每批分配结果")
if "export function assignTrack" not in bcore:
    problems.append("board-core.mjs 没导出 assignTrack —— 发牌时无法在中途判归属")
# mock 路径的 dealt 必须走 assignTrack：写死 ranked:true 会让演示时
# 「六摞里有 8 张、成品榜里找不到」—— 数字对不上，且不报错。
if "mockScore" in bcore:
    mblk = bcore.split("async function mockScore", 1)[1].split("\nasync function", 1)[0] \
        if "async function mockScore" in bcore else ""
    if "assignTrack" not in (mblk or bcore[:4000]):
        problems.append("mockScore 的 dealt 没走 assignTrack —— 写死 ranked:true 会让"
                        "发牌归榜数与成品榜张数不一致（演示模式下必现，且不报错）")
    else:
        notes.append("mock 发牌与真打分同一判定：mockScore 的 dealt 走 assignTrack")

# ---------------- 5b) 切牌动画（v1.3 抽牌）----------------
# ⭐ 机制：三张牌叠成「摞」—— cur 在顶（z:3），prev/next 缩在底下（--under .96）。
#   切换 = .fly + data-dir：顶牌飞行（±56% 相对牌宽，两档自动适配）+ 淡出，
#   方向底牌 --under→1 接位；拖拽跟手 = JS 逐帧写 --px/--pr/--under。
# 为什么钉「拖拽中过渡全关」：v0.8.1 修过「opacity 挂过渡 → 橡皮筋」；
#   v1.3 起 transform 也逐帧变（--px/--pr 跟手），任何挂着的过渡都会让牌
#   追手指半拍。抽走时的 opacity 1→0 是一次性目标（不逐帧 retarget），
#   挂过渡安全 —— 旧断言「opacity 禁过渡」已随胶片机制一起退役。
_cx = re.search(r"\.cx(?:\s*,\s*\.fx)?\s*\{([^}]*)\}", bcss)
if not _cx:
    problems.append("board.css 找不到 .cx 规则（切牌的三张卡）")
else:
    _decl = _cx.group(1)
    if not re.search(r"transition\s*:[^;]*transform", _decl):
        problems.append("board.css 的 .cx 没给 transform 挂过渡 —— "
                        "抽牌/弹回会变成瞬跳")
if not re.search(r"\.slot\.dragging \.cx\s*\{[^}]*transition\s*:\s*none", bcss):
    problems.append("board.css 缺 .slot.dragging .cx { transition:none } —— "
                    "拖拽跟手会挂着 .32s 过渡追手指半拍（橡皮筋）")
else:
    notes.append("拖拽跟手：.dragging 下 .cx 过渡全关（v0.8.1 约束的延续）")
# 两个方向的飞行终态都得在（缺一个 = 那个方向瞬跳）
_fly_n = '.slot.fly[data-dir="next"] .cx[data-pos="cur"]' in bcss
_fly_p = '.slot.fly[data-dir="prev"] .cx[data-pos="cur"]' in bcss
if not (_fly_n and _fly_p):
    problems.append("board.css 缺 .fly 的顶牌飞行规则（next:%s prev:%s）—— "
                    "缺的那个方向抽牌会瞬跳" % (_fly_n, _fly_p))
else:
    notes.append("抽牌：两个方向的飞行终态都在（%相对牌宽，站点/浮层自动适配）")
# 方向底牌抬 z：两张底牌同轴同缩放，不抬 z 的话 DOM 靠后的 next 永远压着
# prev ——「往回抽」时露脸/接位的会是错的那张。静态看不出来，只能靠断言。
if ('.slot[data-dir="next"] .cx[data-pos="next"]' not in bcss
        or '.slot[data-dir="prev"] .cx[data-pos="prev"]' not in bcss):
    problems.append("board.css 缺方向底牌抬 z 的规则 —— 往回抽时接位的会是"
                    "错的那张牌（next 永远压着 prev）")
else:
    notes.append("底牌 z 分层在位：行进方向那张先抬到 z:2 再长上来")
# 底牌接位变量（缺了 = 抽走后牌台空一格再重建）
if "--under" not in bcss:
    problems.append("board.css 缺 --under —— 底牌不会放大接位，"
                    "抽走瞬间牌台会空一格")
# JS 侧：旧胶片机制必须拔干净（留着 = 死代码 + 误导后人）
for _legacy in ("function slideTo", "function setDx"):
    if _legacy in bjs:
        problems.append("board.js 还留着旧胶片机制 %r —— v1.3 抽牌后这是死代码"
                        % _legacy)
_fl = bjs.find("function flyTo")
if _fl < 0:
    problems.append("board.js 找不到 flyTo（v1.3 抽牌的入口）")
else:
    _fblk = bjs[_fl:_fl + 700]
    if "classList.add('fly')" not in _fblk:
        problems.append("flyTo 没挂 .fly —— 顶牌不会飞，只有数据在换")
    if "endPullState()" not in _fblk:
        problems.append("flyTo 收尾没调 endPullState —— 拖拽中途抽走后，"
                        "下一手牌会带着上一根手指的 --px/--pr 偏移起手")
    else:
        notes.append("抽牌：flyTo 挂 .fly 起播、endPullState 收尾清现场")
# 拖拽过阈值必须与箭头同一条 flyTo（旧版对应「两路共用 slideTo 的距离」）
_dg = bjs.find("Math.abs(dx) >= th")
if _dg > 0:
    _dblk = bjs[_dg:_dg + 500]
    if "flyTo" not in _dblk:
        problems.append("拖动过阈值那条路没走 flyTo —— 拖拽抽牌与点箭头"
                        "会是两套动画")
    else:
        notes.append("拖拽过阈值与点箭头共用 flyTo（同一套飞行）")
# 跟手变量与 CSS 的配对：JS 写 --px/--pr + 挂 .dragging，CSS 关过渡 ——
# 缺一半就是「样式在、不跟手」或「跟手但挂着过渡追半拍」。
_pm = bjs.find("bindSwipe")
if _pm > 0:
    _pblk = bjs[_pm:_pm + 3500]
    if "setProperty('--px'" not in _pblk or "setProperty('--pr'" not in _pblk:
        problems.append("bindSwipe 没写 --px/--pr —— 顶牌不会跟手平移/微旋")
    if "classList.add('dragging')" not in _pblk:
        problems.append("bindSwipe 没给 .slot 加 .dragging —— CSS 那条 "
                        "transition:none 永远不生效（橡皮筋）")
    else:
        notes.append("拖拽跟手：--px/--pr 逐帧写 + .dragging 关过渡（与 CSS 配对）")

# ---------------- 5c) 发牌入场的飞行内容（v0.8.2）----------------
# ⭐ 为什么值得断言：飞的内容是 `.cover` 还是 `.bigcard` 的克隆，
#   **只有冻到中途帧才看得出** —— 落位后两者都是同一张牌，终态永远正确。
#   回归表现：整个 320ms 里用户看到一张写着「XX榜 / 点击进入 →」的封面小牌在放大，
#   落位后突然内容全变（名次/分数/判词/看原文），而且「点击进入」按钮飞到了详情页。
if ".flyer > .cover" in bcss and ".flyer > .bigcard" not in bcss:
    problems.append("board.css 的 .flyer 圆角只覆盖 .cover —— v0.8.2 起飞的是 "
                    ".bigcard 克隆，不写这条的话飞出来是直角")
_ot = bjs.find("function openTrack")
if _ot > 0:
    # v0.9.0 起 openTrack 前置了「按 trackId 找赛道 + 对齐 fidx」几步，
    # 窗口从 1600 放宽到 2800 才罩得住 fclone 那几行
    _oblk = bjs[_ot:_ot + 2800]
    if "makeFlyer(cover" in _oblk or "makeFlyer(cover," in _oblk:
        problems.append("openTrack 还在飞封面牌（makeFlyer(cover…)）—— "
                        "用户会看到「点击进入 →」飞到详情页，落位时内容突变一次")
    elif "makeFlyer(big" not in _oblk:
        problems.append("openTrack 的 makeFlyer 既不是 cover 也不是 big —— "
                        "飞行内容不确定，看一眼")
    elif "fclone.style.opacity = ''" not in _oblk:
        problems.append("openTrack 没清掉克隆带来的行内 opacity —— "
                        "被克隆的 .bigcard 此刻 opacity:0，飞出来会是张空牌")
    else:
        notes.append("发牌入场飞的是 .bigcard 克隆（v0.8.2）：全程内容一致，"
                     "落位时 flyer 与真大牌同为383x536，无突变")
# 返回路径必须与入场配对，否则「飞回去」又变回封面
_cd = bjs.find("function closeDetail")
if _cd > 0:
    _cblk = bjs[_cd:_cd + 1400]
    if "makeFlyer(stack.querySelector('.cover')" in _cblk:
        problems.append("closeDetail 还在飞封面牌 —— 返回时看到的是一张"
                        "「点击进入」的牌缩回去，与入场不一致")
    elif "makeFlyer(big" not in _cblk:
        problems.append("closeDetail 的 makeFlyer 既不是 cover 也不是 big")
# 被点的摞不该被豁免淡出：豁免会让它比另外五摞多留 100ms，
# 而那100ms 里它的 cover 已淡出、只剩 stack-face + 标题字 → 画面两个焦点
_leave = re.search(r"\.deck\.leaving\s+\.stack\.press\s*\{[^}]*\}", bcss)
if _leave and re.search(r"opacity\s*:\s*1", _leave.group(0)):
    problems.append("board.css 的 .deck.leaving .stack.press 又豁免成 opacity:1 —— "
                    "被点的摞会比另外五摞多留 100ms，画面出现两个焦点")
elif _leave:
    notes.append("发牌入场：六摞一起淡出（含被点的那摞），飞行层是唯一焦点")

# 前端 TRACKS 副本必须与内核一致（board.js 是普通 script，不能 import）
def _tracks(js):
    """抽出 (id, name, def, color) 四元组。

    ⚠️ 正则必须**逐字段独立匹配**（用 [^}]*? 跳过 symbol/dims/anchors）——
       不能假设四个字段连在一起：内核那份里 name 后面还跟着 def/color/symbol，
       字段顺序与空格也跟前端副本不一致。"""
    out = []
    for m in re.finditer(r"\{\s*id:\s*'([a-z]+)',(.*?)\}", js, re.S):
        body = m.group(2)
        name = re.search(r"name:\s*'([^']+)'", body)
        df = re.search(r"def:\s*'([^']+)'", body)
        col = re.search(r"color:\s*'(#[0-9A-Fa-f]{3,8})'", body)
        if name and df and col:
            out.append((m.group(1), name.group(1), df.group(1), col.group(1)))
    return out


t_js = _tracks(bjs)
t_core = _tracks(bcore)
if len(t_core) != 6:
    problems.append("board-core.mjs 的 TRACKS 应 6 条，正则只认出 %d 条 —— 断言本身失效了" % len(t_core))
if not t_js:
    problems.append("board.js 里找不到前端 TRACKS 副本（发牌视图要靠它摆六摞）")
elif len(t_js) != 6:
    problems.append("前端 TRACKS 副本应 6 条，实际 %d 条" % len(t_js))
elif t_js != t_core:
    problems.append("前端 TRACKS 副本与 board-core.mjs 的 TRACKS 不一致：\n    前端 %s\n    内核 %s"
                    % (t_js, t_core))
else:
    notes.append("赛道元数据两处一致：board.js 的 TRACKS 副本 == board-core.mjs 的 TRACKS（6 条）")

# ---------------- 5d) 撤销必须是「静止态」（v1.3.3）----------------
# 这两条分别盯住实现里最容易退化回去的两处，全都是**不报错**的静默 bug：
#   ① cancelRestore 又改成 jobs.delete(range) → 日榜（会 ensure 自启的那档）
#      下次刷新/切榜期回来会**自动再跑一轮 45 页**，而用户点撤销的意思是「别算了」；
#   ② boardResponse 少了 cancelled 分支 → idle/cancelled 掉进 building 兜底 →
#      前端「只在 ready/failed/none 时停轮询」永不落定：转圈永久转、按钮永久 disabled。
if "state = 'cancelled'" not in bcore:
    problems.append("board-core.mjs 的 cancelRestore 不再留 state:'cancelled' 空壳 —— "
                    "日榜撤销后下一次 ensure() 会自动重跑一轮（违背撤销语义）")
elif "status === 'cancelled'" not in bcore:
    problems.append("boardResponse 没有 cancelled 分支 —— 撤销落定时会伪装成 building，"
                    "前端轮询永不终止、重新评分按钮永久 disabled")
else:
    notes.append("撤销是静止态：空壳 state:'cancelled' 拦住自动重跑，"
                 "boardResponse 有独立 cancelled 分支（不会伪装成 building）")

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

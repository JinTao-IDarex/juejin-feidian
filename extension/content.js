/* content.js — 在 juejin.cn 页面上悬浮一块「沸点抽卡」面板
 *
 * 设计取舍：面板内容**不是重新实现的**，而是把站点自己的 host.html
 * （= site/index.html）放进一个 iframe 里加载。理由有三：
 *   1) 真复用：牌面、样式、翻牌动效、AI 弹窗全部是站点那一份，改站点即改扩展；
 *   2) 隔离：iframe 是 chrome-extension:// 源，掘金页面的任何 CSS（含 *{} 重置、
 *      :root 变量、!important）都碰不到里面的牌面；
 *   3) 可靠：站点 CSS 依赖 :root 自定义属性，放进 Shadow DOM 会整片失效
 *      （:root 在 shadow tree 里匹配不到任何元素），用 iframe 才是真隔离。
 *
 * 两态（v0.2）：
 *   · 收起 —— 右上角一张缩略卡（站点自己的 dock 卡），点一下展开；
 *             **不贴角**：卡右缘距视口右 98px、顶边距视口顶 86px
 *             （v0.2.3 定 188/86，v0.2.7 按要求右移 90 → 98/86，见 FOLD_* 常量）
 *   · 展开 —— 牌阵 + HUD，**水平垂直居中落在页面正中**，底下铺一层全屏遮罩
 *             （半透明底 + 背景虚化），点遮罩收起。
 *   展开态是「把站点那一整段版式端到页面中间」，所以主卡正好在正中 ——
 *   窗口宽取舞台整宽 1440（详见 embed.css 顶部注释：v0.1 裁掉左侧 424 留白，
 *   把牌阵中心从 720 挪到了 296，主卡就偏左了）。
 *
 * ⚠️ 落位逻辑见 place()。这里踩过很隐蔽的坑（「点开缩略卡后主卡跑到页面右边、
 * 半个屏幕外」），根因和修法都写在 place() 的注释里，别改回去。
 */
(() => {
  const HOST_ID = 'juejin-pin-gacha-host';
  const MASK_ID = 'juejin-pin-gacha-mask';
  const DESIGN_W = 1440;   // 窗口宽 = 舞台整宽（牌阵中心 720 = 窗口中心）
  const DESIGN_H = 722;    // 舞台 620 + 间隔 16 + HUD 86
  const FOLD_W = 196, FOLD_H = 236;
  const MARGIN = 12;
  /* 收起态停在哪：右上角，但**不贴角**（v0.2.3 按用户标注的红框改）。
   *
   * 口径说明：缩略卡是站点自己的 .dock，在 196x236 的 iframe 里 `top:20; right:24`，
   * 尺寸 148x196 —— 所以「缩略卡距视口右 188」换算到宿主盒子要**减去**那 24：
   *   宿主右缘距视口右 = 卡右缘距视口右 - 24
   *   宿主顶边距视口顶 = 卡顶边距视口顶 - 20
   * 反过来说，**要挪卡就改这两个常量**，`+90` 是"往右挪 90"（宿主 inset 要**减小** 90）。
   *
   * 164 / 66 怎么来的：用户在自己的浏览器（视口 clientWidth≈1898）上画了红框
   * x[1560,1714] y[79,278]，而截图里缩略卡当时在 x[1715,1862]、顶边 y=27
   * （= 原来的 MARGIN 12 + dock 的 24 / 20，模型对得上）。
   * 把 148x196 的卡摆进红框 → 卡右缘距视口右 188、顶边距顶 86，即相对原位置
   * **左移 152、下移 54**（原值 12 → 164）。
   *
   * v0.2.7：用户要求「再向右移 90px」→ 卡右缘距视口右 188 → 98，
   * 宿主 164 → **74**（垂直不动，仍 66）。
   * ⚠️ 往右是可以压到"贴角"的：v0.2.3 之所以从 12 挪开，就是因为贴角会压在
   *    掘金头部右上角的图标 / 悬浮工具条上。现在 98 还留着近一屏 1/10 的余量，
   *    但**再往右就该先看一眼真站头部**（卡在 iframe 里，挡住的点击是静默失效的）。 */
  const FOLD_INSET_RIGHT = 74;
  const FOLD_INSET_TOP = 66;
  const Z = 2147483000;
  const MOVE_MS = 280;     // 面板在「右上角 ⇄ 页面正中」之间滑动的时长
  /* 遮罩观感：半透明深色底 + 背景虚化。
   * 底色的浓淡是唯一需要调的旋钮 —— 太浅（比如 .55 的白色）整屏会和面板糊成
   * 一片白，看不出"遮罩"，面板也浮不起来；这里取中等深度，让白色卡面立住。 */
  const MASK_ALPHA = 0.28;
  const MASK_BLUR = 'blur(12px) saturate(115%)';
  /* 收起态缩略卡的投影 —— 写在**父页面**这层（挂在 iframe 上），不写在卡上。
   *
   * 站点把这份投影做在 .dock 自己身上（app.css `body.folded .dock{box-shadow:0 14px 36px …}`），
   * 而 .dock 是在 196x236 的 iframe 里 `top:20; right:24` —— 卡外只剩 24/20px 余量，
   * 36px 模糊的投影根本铺不下，会在 iframe 的**矩形边界**上被硬切一刀。
   * 白底页实测那条边上的台阶：左 4 / 右 3 / 上 1 / **下 12**
   * （rgb 243,246,251 → 255,255,255，肉眼就是卡片下方横着一条突然消失的蓝灰带）。
   * 用户报的「缩略卡四周和主页面有割裂感」就是它 —— 不是底色，是**被切掉的投影**。
   *
   * 所以这里改挂 `filter: drop-shadow(...)`：它沿 iframe 内容的 **alpha 轮廓**
   * （= 那张 148x196 圆角卡，收起态 iframe 里除了它没别的实体）投影，不受 iframe
   * 盒子约束，能像正常投影那样溢出到页面上平滑衰减。实测同一张白底页：
   * 四条边台阶 1/1/1/**0**，且卡外 30/44/60px 仍有 Δ6→Δ4→Δ2 的自然衰减。
   *
   * ⚠️ 和 embed.css 第 5 节那条 `box-shadow: none` 是**同一个投影的两半**，必须成对改：
   *    只关不挂 = 卡没投影；只挂不关 = iframe 里那份被切的 + 父页面这份，双投影。
   * ⚠️ 两个值要和 app.css 一一对得上：基线对 `body.folded .dock`，
   *    hover 对 `body.folded .dock:hover`。改 app.css 就要同步改这里。 */
  const FOLD_SHADOW = 'drop-shadow(0 14px 36px rgba(30, 89, 191, .14))';
  const FOLD_SHADOW_HOVER = 'drop-shadow(0 20px 44px rgba(30, 89, 191, .20))';
  /* 一打开 juejin.cn 时先给哪一态？
   * true  = 缩略卡（右上角那张竖版纸牌），点一下展开 —— 默认。
   * false = 直接铺开整块牌阵。
   * 想改成默认展开，把这里翻成 false 即可。 */
  const START_FOLDED = true;

  if (window.__JB_CONTENT__) return;
  window.__JB_CONTENT__ = true;

  let host = null, frame = null, mask = null;
  let maskTimer = null;
  let cur = { w: 0, h: 0, folded: START_FOLDED };
  let hovered = false;     // 指针是否在 iframe 上（收起态的投影为此分两档，见 paintShadow）
  let useFixed = true;

  /* 展开态停在哪：'center'（默认，主卡落在页面正中）| 'topright'。
   * 收起态**永远**是右上角的缩略卡，与这里无关。
   * 本地预览可用 ?jb-anchor=topright 覆盖，方便对比两种构图。 */
  const ANCHOR = (() => {
    try {
      const m = /[?&]jb-anchor=([a-z]+)/.exec(location.search);
      if (m) return m[1] === 'topright' ? 'topright' : 'center';
    } catch (e) { /* ignore */ }
    return 'center';
  })();

  /* 宿主的不变量样式（尺寸与落位由 place() 单独写）。
   * 注意：样式**逐条** setProperty + important，
   * 不能拼成一整串再补一个 !important（浏览器会把整块判为非法而全部丢弃）。 */
  const HOST_BASE = {
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    'min-width': '0',
    'min-height': '0',
    'max-width': 'none',
    'max-height': 'none',
    'z-index': String(Z),
    'pointer-events': 'auto',
    opacity: '1',
    visibility: 'visible',
    transform: 'none',
    filter: 'none',
    'box-sizing': 'border-box',
    /* 位移+尺寸一起过渡：left 和 width 同步线性变化 ⇒ 右缘 = left+width
     * 也是线性的，缩略卡（贴在窗口右上角）就会平滑地滑过去而不是瞬移。
     * 只过渡 left 不过渡 width 的话，展开瞬间右缘会先跳出去 1244px 再滑回来。 */
    transition: 'left ' + MOVE_MS + 'ms ease, top ' + MOVE_MS + 'ms ease, ' +
                'width ' + MOVE_MS + 'ms ease, height ' + MOVE_MS + 'ms ease'
  };

  /* ⚠️ iframe 必须钉在宿主的**右上角**（right:0 / top:0），不能留在默认的左上角。
   *
   * 原因（v0.2.2 修的坑，用户报「切到缩略卡时会闪一下，然后从左边闪到最终位置」）：
   * 缩略卡是站点自己的 .dock，`position:fixed; top:20; right:24` —— 它钉的是
   * **iframe 视口的右缘**。而宿主收起时是「left 233→1697 且 width 1440→196」一起过渡的，
   * 于是 iframe 视口右缘 = 宿主右缘 = left+width，本来是一条平滑的 220px 位移。
   * 但 iframe 是左上角对齐的静态流，`resize()` 又把它的 width **一帧内**改成 196
   * → iframe 右缘当帧从 1673 掉到 233+196=429 → 缩略卡一帧内被瞬移到左边 1244px，
   * 随后宿主 left 的过渡再把整块（含那张卡）横穿面板扫回右边 1464px。
   * 实测逐帧确实如此：t=461ms 卡在 x=1501，t=494ms 跳到 x=257，t=773ms 才回到 1721。
   *
   * 钉右上角之后，iframe 右缘 == 宿主右缘，尺寸瞬变的瞬间右缘**不动**
   * （宿主此时还停在展开态，右缘 = 1673），缩略卡原地不动、再跟着宿主右缘平滑滑到 1893。
   * 顺带把展开方向也修了：原来是「面板从屏幕右外侧 1464px 冲进来」，
   * 现在变成 220px 的落位位移。
   *
   * 左上是 absolute 的默认对齐方向，这里必须显式写 left:auto，否则会和 right:0 打架。 */
  const FRAME_BASE = {
    position: 'absolute',
    right: '0',
    top: '0',
    left: 'auto',
    display: 'block',
    border: '0',
    background: 'transparent',
    'color-scheme': 'light'
  };

  const MASK_BASE = {
    position: 'fixed',
    left: '0', top: '0', right: '0', bottom: '0',
    width: 'auto', height: 'auto',
    margin: '0', padding: '0', border: '0',
    'z-index': String(Z - 1),
    /* 遮罩 = 半透明底 + 背景虚化。虚化必须做在**父页面**这一层：
     * iframe 自己内部是拿不到父页面内容的，backdrop-filter 在 iframe 里
     * 只能糊到 iframe 自己的（透明的）画布，什么也糊不着。 */
    background: 'rgba(17,21,28,' + MASK_ALPHA + ')',
    'backdrop-filter': MASK_BLUR,
    '-webkit-backdrop-filter': MASK_BLUR,
    opacity: '0',
    display: 'none',
    'pointer-events': 'none',
    transition: 'opacity ' + MOVE_MS + 'ms ease'
  };

  function setCss(el, css) {
    Object.keys(css).forEach((k) => el.style.setProperty(k, css[k], 'important'));
  }

  /* 视口尺寸。**必须用 clientWidth / clientHeight，不能用 window.innerWidth**：
   * innerWidth 把竖向滚动条也算进去（本机 Chrome 实测 15px），而 fixed 元素的
   * 包含块是「不含滚动条的视口」—— 拿 innerWidth 去比，面板右缘永远"差 15px"，
   * 容差设成 2px 就必然误判。这是 v0.1 跑偏的第一层原因。 */
  function viewport() {
    const de = document.documentElement;
    return {
      w: de.clientWidth || window.innerWidth,
      h: de.clientHeight || window.innerHeight
    };
  }

  /* 展开态尺寸：按视口算一个克制的比例，k 由设计尺寸反推，且不放大超过 1:1 */
  function geometry() {
    const vp = viewport();
    const k = Math.min(1, (vp.w - 2 * MARGIN) / DESIGN_W, (vp.h - 2 * MARGIN) / DESIGN_H);
    const kk = Math.max(0.4, Math.round(k * 1000) / 1000);
    return { k: kk, w: Math.ceil(DESIGN_W * kk), h: Math.ceil(DESIGN_H * kk) };
  }

  /* position:fixed 的包含块就是视口 —— 除非 <html> 上挂了会创建包含块的属性。
   * 宿主是 documentElement 的直接子节点，所以它的祖先只有 <html>（body 是兄弟，
   * 挂 transform 也影响不到它），查一处就够。实测掘金 html 上三项全是 none。
   * v0.1 是「摆好之后量一次右缘」来判断，结果被滚动条的 15px 差骗了；
   * 直接查属性没有这种歧义。 */
  function fixedIsSafe() {
    try {
      const de = getComputedStyle(document.documentElement);
      return de.transform === 'none' && de.filter === 'none' &&
             de.perspective === 'none' &&
             (de.willChange === 'auto' || de.willChange.indexOf('transform') < 0);
    } catch (e) { return true; }
  }

  /* 落位：唯一入口。任何尺寸 / 状态变化都必须走这里。
   *
   * v0.1 的坑（用户实测：点开缩略卡，主卡跑到页面右边、大半个屏幕外）：
   *   1) 自检拿 window.innerWidth 当基准 → 有滚动条就"差 15px" → 误判成跑偏；
   *   2) 误判后退到 absolute，而 left 是按**收起态宽度 196** 算死的
   *      （left = innerWidth - 12 - 196）。展开成 1016 只改 width 不重算 left，
   *      于是右缘长到 innerWidth + 808，只剩最左边一条露在屏幕内；
   *   3) 退路里还多减了一次 documentElement 的 rect 偏移。文档滚动时
   *      html.getBoundingClientRect().top 本身就等于 -scrollY，再减一遍
   *      等于把滚动量算了两遍，面板还会往下掉。
   * 现在：fixed 是否可用在挂载时**查属性**判定一次（fixedIsSafe），
   * 之后 left/top 每次都按当前尺寸和当前视口重算，没有"算死"的路径。 */
  function place(w, h, folded) {
    if (!host) return;
    const vp = viewport();
    const center = !folded && ANCHOR === 'center';
    /* fixed → 视口坐标；absolute → 文档坐标（加滚动量） */
    const ox = useFixed ? 0 : window.scrollX;
    const oy = useFixed ? 0 : window.scrollY;
    /* 收起态用 FOLD_INSET_*（右上角内缩），展开态居中。
     * 两边都要 Math.max(MARGIN, …) 兜底：视口太窄/太矮时别把面板挤到看不见。
     * 收起态的 top 还要再跟 vp.h - MARGIN - h 取小，否则矮视口下缩略卡会掉出下边界。 */
    const left = center
      ? Math.max(MARGIN, Math.round((vp.w - w) / 2))
      : Math.max(MARGIN, vp.w - FOLD_INSET_RIGHT - w);
    const top = center
      ? Math.max(MARGIN, Math.round((vp.h - h) / 2))
      : Math.max(MARGIN, Math.min(FOLD_INSET_TOP, vp.h - MARGIN - h));

    setCss(host, {
      position: useFixed ? 'fixed' : 'absolute',
      left: (ox + left) + 'px',
      top: (oy + top) + 'px',
      right: 'auto',
      bottom: 'auto',
      width: w + 'px',
      height: h + 'px'
    });
  }

  /* ---- 全屏遮罩（只在展开态出现）---- */
  function ensureMask() {
    if (mask && document.documentElement.contains(mask)) return mask;
    mask = document.createElement('div');
    mask.id = MASK_ID;
    mask.setAttribute('data-juejin-pin-gacha', '1');
    setCss(mask, MASK_BASE);
    mask.addEventListener('click', () => {
      /* 点遮罩 = 收起，等价于点站点自己的 dock 按钮。
       * 遮罩同时负责拦住误触 —— 不然点空处会点到下面的掘金页面。 */
      if (frame) frame.contentWindow.postMessage({ t: 'jb-dock-click' }, '*');
    }, false);
    document.documentElement.appendChild(mask);
    return mask;
  }

  function showMask(on) {
    /* 收起态且从来没创建过 → 干脆不建。遮罩挂着 backdrop-filter 会常驻一个合成层，
     * 而绝大多数时间用户是收起状态，没必要为此一直付开销。 */
    if (!on && !mask) return;
    const m = ensureMask();
    clearTimeout(maskTimer);
    if (on) {
      m.style.setProperty('display', 'block', 'important');
      /* 下一帧再写 opacity：刚 display:block 的元素如果同帧就把 opacity 写到位，
       * 过渡没有"起始态"可插值，会直接跳出来。 */
      requestAnimationFrame(() => {
        m.style.setProperty('opacity', '1', 'important');
        m.style.setProperty('pointer-events', 'auto', 'important');
      });
    } else {
      m.style.setProperty('opacity', '0', 'important');
      m.style.setProperty('pointer-events', 'none', 'important');
      /* 淡出播完再彻底摘掉，免得留着一层常驻的虚化 */
      maskTimer = setTimeout(() => {
        m.style.setProperty('display', 'none', 'important');
      }, MOVE_MS + 80);
    }
  }

  /* ---- 收起态缩略卡的外投影（挂在 iframe 上，理由见 FOLD_SHADOW 注释）----
   * 只在收起态挂：展开态 iframe 铺满整块面板，再挂 filter 等于给整个面板套一圈
   * 外发光（而且那么大的面积让浏览器白掏一次 drop-shadow，很贵）。
   *
   * cur.folded 天然就是「折叠动画已经播完」的态：iframe 报告收起态时，站点那边
   * 已经等满了 .45s 动画（embed-boot.js 的 FOLD_MS 才 report），所以 embed.css
   * 撤掉卡上那份投影、和这里挂上父页面这份，是**同一时刻**换手，不会出现
   * 「两头都没投影」或「两份投影叠着」的中间帧。 */
  function paintShadow() {
    if (!frame) return;
    let v = 'none';
    if (cur.folded) v = hovered ? FOLD_SHADOW_HOVER : FOLD_SHADOW;
    setCss(frame, { filter: v });
  }

  function resize(w, h, folded) {
    if (!host || !frame) return;
    cur = { w: w, h: h, folded: folded };
    setCss(frame, { width: w + 'px', height: h + 'px' });
    place(w, h, folded);
    showMask(!folded);
    paintShadow();
  }

  function mount() {
    if (host && document.documentElement.contains(host)) return;
    useFixed = fixedIsSafe();

    const g = geometry();
    /* 首帧就按目标态定尺，避免"先铺一大块白的再缩成一个角"的闪动 */
    const w0 = START_FOLDED ? FOLD_W : g.w;
    const h0 = START_FOLDED ? FOLD_H : g.h;
    cur = { w: w0, h: h0, folded: START_FOLDED };

    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-juejin-pin-gacha', '1');
    host.setAttribute('data-jb-folded', START_FOLDED ? '1' : '0');
    setCss(host, HOST_BASE);
    /* 落位放在插入文档**之前**：此时没有前一个计算值，
     * transition 不会从头播一遍（否则首帧会看到面板从左上角滑过来）。 */
    place(w0, h0, START_FOLDED);

    frame = document.createElement('iframe');
    frame.setAttribute('title', '沸点抽卡');
    frame.setAttribute('allowtransparency', 'true');
    setCss(frame, Object.assign({}, FRAME_BASE, {
      width: w0 + 'px',
      height: h0 + 'px'
    }));
    /* 投影在挂载时就摆好：否则为首帧就是收起态时，卡会先"光秃秃"地闪一下
     * （embed.css 已经把卡自己那份投影关了，父页面这份必须同帧到位）。 */
    paintShadow();

    /* 指针进出 iframe 换一档投影 —— 顶上的是站点 `.dock:hover` 那条「投影加深」：
     * 它写在 .dock 上，被 embed.css 一起关掉了，所以在父页面补这一档。
     * hover 的另一半（translateY(-3px) 上浮）不受影响，而且 drop-shadow 会跟着
     * 卡一起动，比原来"卡动、影子不动"更贴。
     * ⚠️ 颗粒度是 iframe 的 196x236，不是那张 148x196 的卡 —— 卡外那 24/20px 余量
     *    也算"卡上"，指针扫过就会提前一档。这点误差不值得再搭一套坐标换算。 */
    frame.addEventListener('mouseenter', () => { hovered = true; paintShadow(); }, false);
    frame.addEventListener('mouseleave', () => { hovered = false; paintShadow(); }, false);

    host.appendChild(frame);
    document.documentElement.appendChild(host);
    showMask(!START_FOLDED);

    frame.src = chrome.runtime.getURL('host.html') + '?embed=1&k=' + g.k +
      (START_FOLDED ? '&folded=1' : '');
  }

  /* ---- iframe 报尺寸 ---- */
  window.addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d) return;
    if (d.t === 'jb-size' && d.w > 0 && d.h > 0) {
      const folded = !!d.folded;
      host.setAttribute('data-jb-folded', folded ? '1' : '0');
      resize(d.w, d.h, folded);
    }
    /* 站点自己的「一键评论 / 打开原文」有时要开新标签，交给这里做 */
    if (d.t === 'jb-open' && d.url) window.open(d.url, '_blank', 'noopener');
  }, false);

  /* ---- 视口变化 ---- */
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (!frame || !host) return;
      const folded = host.getAttribute('data-jb-folded') === '1';
      /* 位置永远重算 —— 收起态也得跟住视口，
       * 否则改一次窗口大小，缩略卡就悬在半路了 */
      if (folded) { place(cur.w, cur.h, true); return; }
      const g = geometry();
      if (g.w === cur.w && g.h === cur.h) { place(cur.w, cur.h, false); return; }
      /* 尺寸要变：交给 iframe 重新报一次尺寸，回来后 resize() 会落位 */
      frame.contentWindow.postMessage({ t: 'jb-k', k: g.k }, '*');
    }, 140);
  });

  /* ---- 在页面上下文里代发请求（带上用户登录态）----
   * 为什么不让 background 直接发：掘金接口要登录 Cookie，
   * 而这个 content script 跑在 juejin.cn 的源上，fetch 自带 Cookie，
   * 于是「一键评论」不用再让用户手贴 Cookie。 */
  function pageFetch(msg) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), msg.timeoutMs || 15000);
    return fetch(msg.url, {
      method: msg.method || 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, msg.headers || {}),
      body: msg.payload ? JSON.stringify(msg.payload) : undefined,
      credentials: 'include',
      signal: ctl.signal
    }).then((r) => r.text().then((txt) => {
      let body;
      try { body = JSON.parse(txt); } catch (e) { body = { err_no: -1, err_msg: String(txt).slice(0, 300) }; }
      return { http: r.status, body };
    })).catch((e) => ({
      http: 0, body: { err_no: -1, err_msg: String((e && e.message) || e) }
    })).then((out) => { clearTimeout(timer); return out; });
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return false;
      /* 工具栏图标：等价于点站点自己的 dock 按钮（展开 ⇄ 缩略卡） */
      if (msg.type === 'jb-toggle') {
        if (frame) frame.contentWindow.postMessage({ t: 'jb-dock-click' }, '*');
        return false;
      }
      if (msg.type === 'jb-page-fetch') {
        pageFetch(msg).then(sendResponse);
        return true; // 异步响应
      }
      return false;
    });
  } catch (err) { /* 扩展被重载后 runtime 会失效，忽略 */ }

  /* ---- SPA：掘金换路由时可能整块替换页面，宿主被摘掉就补回来 ---- */
  new MutationObserver(() => {
    if (host && !document.documentElement.contains(host)) {
      document.documentElement.appendChild(host);
      place(cur.w, cur.h, cur.folded);
    }
    if (mask && !document.documentElement.contains(mask)) {
      document.documentElement.appendChild(mask);
    }
  }).observe(document.documentElement, { childList: true });

  mount();
})();

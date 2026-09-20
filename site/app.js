/* app.js — 沸点抽卡 · 磨砂玻璃版
 * 数据：启动时经同源 /api/pins（serve.mjs 代理掘金 recommend 接口）拉实时沸点，
 * 失败回退到 data.js 内置牌堆（60 条 0917 真实沸点 + 配对点评）。
 *
 * 设计稿（file 727057985392898，帧 3:1）的落地模型：
 *   坐标系固定 1440 x 1000，所有元素按设计稿像素绝对定位；
 *   视口放不下时整组按 --k 等比缩（transform-origin: center top）。
 *   坐标零换算、居中零计算，响应式只需要一个 k。
 *
 * 交互对齐设计稿：层叠轮播主舞台 + 右侧 AI 点评卡 + 喜欢/复制点评。
 * 不做登录、不上传、不代发。
 */
(function () {
  'use strict';

  var DATA = window.PINS_DATA || {};
  var PINS = (DATA.pins || []).slice();
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  var LKEY = 'juejin-gacha-glass';

  var S = { order: [], pos: 0, liked: {}, seen: {}, muted: true };

  /* 预览覆写：?motion=full 时忽略系统的「减少动态效果」设置。
   * 用途：作者预览/调试动画——有的预览环境（或系统级开了减动效的机器）
   * 会让 prefers-reduced-motion 命中，整站只剩 130ms 淡入，看不出动效。
   * 默认（不带参数）仍完整尊重 prefers-reduced-motion。 */
  if (/[?&]motion=full\b/.test(location.search)) {
    document.documentElement.classList.add('motion-full');
  }

  /* ---------------- 本地进度 ---------------- */
  function loadLocal() {
    try {
      var raw = localStorage.getItem(LKEY);
      if (!raw) return;
      var v = JSON.parse(raw);
      S.liked = v.liked || {};
      S.seen = v.seen || {};
      /* 默认静音：只有用户显式按过 M 取消静音（存了 false）才开声音 */
      S.muted = v.muted !== false;
      setMuted(S.muted);
    } catch (e) { /* 隐私模式 / 数据损坏：静默降级 */ }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LKEY, JSON.stringify({ liked: S.liked, seen: S.seen, muted: S.muted }));
    } catch (e) { /* 配额满：不影响抽卡 */ }
  }

  /* ---------------- 工具 ---------------- */
  var toastTimer;
  /* 离场层的兜底移除定时器（见 render()） */
  var outTimer;
  /* AI 卡翻转动画中点换内容的定时器（见 render()） */
  var aiSwapTimer;
  /* 实时点评的出发防抖：翻牌后 700ms 内再次翻牌则取消上一个待发请求，
   * 只有「落定」的牌才真正打 AI 接口——快速翻牌不会给厂商堆并发（见 render()） */
  var roastKickTimer;
  /* 批量生成进度：批量请求中为 {id,total,start}；兜底串行时多 done/serial。
   * null 表示空闲。存在期间单条 maybeRoast 不再发请求，由批量统一驱动。 */
  var batchCtl = null;
  var batchSeq = 0;
  var batchTicker = null;

  /* ---------------- AI 实时点评配置 ----------------
   * 配置存在 localStorage（只存本机浏览器）：OpenAI 兼容接口三要素。
   * 配了之后翻牌时经同源 /api/roast（serve.mjs 转发，避免 CORS）实时生成点评；
   * 没配就用 data.js 里的手写点评兜底。 */
  var AI_CFG_KEY = 'juejin-boom:ai-cfg';
  /* 掘金登录态 Cookie（一键评论用）：可存浏览器 localStorage，
   * 也可写进服务端 site/.ai-config.json 的 jjCookie 字段（不进浏览器） */
  var JJ_COOKIE_KEY = 'juejin-boom:jj-cookie';
  var aiCfg = loadAiCfg();
  /* 已生成的点评按沸点 id 缓存，来回翻牌不重复打接口（改配置时清空） */
  var roastCache = {};
  /* 失败负缓存：30s 内翻回同一张不重复打接口（避免服务商限流时被反复撞击） */
  var roastFail = {};
  /* 进行中的生成请求：翻下一张时 abort 掉，避免慢响应错配到新卡上 */
  var roastAbort = null;
  function loadAiCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(AI_CFG_KEY) || 'null');
      /* token 允许为空：空 token 时由服务端 .ai-config.json 补上（Key 不进浏览器） */
      return (c && c.baseUrl && c.model) ? c : null;
    } catch (e) { return null; }
  }

  /* ---------------- 点评风格预设 ----------------
   * 每张风格牌 = 名字 + 示例 + 完整提示词；提示词随 /api/roast 请求发给模型。
   * 第一张「毒舌」就是原本的默认提示词；选择存 localStorage，改风格时清空点评缓存。 */
  var STYLE_KEY = 'juejin-boom:ai-style';
  var STYLES = [
    {
      id: 'toxic', name: '毒舌点评', demo: '毒的是现象，不是你。',
      prompt: '你是掘金沸点的毒舌评论员。针对用户给的沸点内容写一句点评：' +
        '口语化、犀利幽默、一针见血，可以调侃现象，但不攻击作者本人。' +
        '不超过 60 字，只输出点评本身，不要引号、不要解释、不要前缀。',
    },
    {
      id: 'warm', name: '温柔治愈', demo: '先给你一个抱抱，剩下的慢慢来。',
      prompt: '你是掘金沸点的暖心评论员。针对用户给的沸点内容写一句点评：' +
        '温柔善意，先共情再给一点小鼓励，像朋友递过来一杯热茶。' +
        '不超过 60 字，只输出点评本身，不要引号、不要解释、不要前缀。',
    },
    {
      id: 'logic', name: '理性拆解', demo: '情绪很满，信息量很低。',
      prompt: '你是掘金沸点的理性评论员。针对用户给的沸点内容写一句点评：' +
        '冷静客观，直接点出事情的本质或逻辑漏洞，不带情绪，不落俗套。' +
        '不超过 60 字，只输出点评本身，不要引号、不要解释、不要前缀。',
    },
    {
      id: 'melon', name: '吃瓜群众', demo: '搬好小板凳，就等后续了。',
      prompt: '你是掘金沸点的吃瓜评论员。针对用户给的沸点内容写一句点评：' +
        '围观群众视角，看热闹不嫌事大，轻松调侃，可以用网络梗但不低俗。' +
        '不超过 60 字，只输出点评本身，不要引号、不要解释、不要前缀。',
    },
    {
      id: 'poet', name: '文青感慨', demo: '风把日子吹皱了，也算是种动静。',
      prompt: '你是掘金沸点的文艺评论员。针对用户给的沸点内容写一句点评：' +
        '感性细腻，带点诗意和画面感，像一句随手写下的随笔。' +
        '不超过 60 字，只输出点评本身，不要引号、不要解释、不要前缀。',
    },
  ];
  function currentStyle() {
    var id = localStorage.getItem(STYLE_KEY) || 'toxic';
    for (var i = 0; i < STYLES.length; i++) if (STYLES[i].id === id) return STYLES[i];
    return STYLES[0];
  }
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2000);
  }

  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(txt).catch(function () { fallbackCopy(txt); });
    }
    fallbackCopy(txt);
    return Promise.resolve();
  }
  function fallbackCopy(txt) {
    var a = document.createElement('textarea');
    a.value = txt;
    a.setAttribute('readonly', '');
    a.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(a);
    a.select();
    try { document.execCommand('copy'); } catch (e) { /* 极老浏览器 */ }
    a.remove();
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function likedCount() {
    return Object.keys(S.liked).filter(function (k) { return S.liked[k]; }).length;
  }
  function seenCount() {
    return Object.keys(S.seen).filter(function (k) { return S.seen[k]; }).length;
  }
  var isFav = function (id) { return !!S.liked[id]; };

  /* ---------------- 排序 ---------------- */
  function rebuild() {
    S.order = PINS.map(function (_, i) { return i; });
    S.pos = 0;
  }
  function shuffleOrder() {
    for (var i = S.order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = S.order[i]; S.order[i] = S.order[j]; S.order[j] = t;
    }
  }

  /* ---------------- 标题 / 正文拆分 ----------------
   * 数据现状：60 条里绝大多数 topic 是「沸点」（掘金默认占位），没信息量。
   * 主卡是固定高度的纸牌，若把一句短话当标题、正文留空，中段会出现一大片
   * 留白。所以只有「内容够长、需要分两层读」时才拆标题：
   *   有真话题             → 标题=话题，正文=全文
   *   无话题、内容 < 34 字  → 不拆，整条当导语（正文升格为主体）
   *   无话题、内容 ≥ 34 字  → 首句 ≤20 字时当标题，其余作正文
   */
  function splitTitleBody(p) {
    var raw = String(p.content || '').replace(/\n{2,}/g, '\n').trim();
    var hasTopic = p.topic && p.topic !== '沸点';
    if (hasTopic) return { title: p.topic.trim(), body: raw };
    if (raw.length < 34) return { title: '', body: raw };
    var lines = raw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (lines.length > 1 && lines[0].length <= 20) {
      return { title: lines[0], body: lines.slice(1).join('\n') };
    }
    return { title: '', body: raw };
  }

  /* 主卡线稿插画：土星虫（掘金宠物）坐在散开的牌堆上 —— 220x150 画布。
   * 变体 A · 土星虫主视角，与 pets/illustrations.py 的 saturn_hero() 同源：
   *   底：三张散开的牌（-8° / 4° / 14°），中间那张填充浅蓝并带两条书写线；
   *   上：土星虫（身体 + 四条细腿 + 横幅光环 + 眯眼）+ 三颗大小不一的蓝色四角星。
   * 光环的遮挡顺序必须是「后半整椭圆 → 身体 → 腿 → 前半下弧」，
   * 这样才有"环穿过身体"的正确层次；只画一段弧会看成张开双臂。
   */
  /* 主卡线稿插画 —— 220x150 画布，两版随机展示。
   *
   * ILLUS_A  · 变体 A「土星虫主视角」，与 pets/illustrations.py 的 saturn_hero() 同源：
   *   底：三张散开的牌（-8° / 4° / 14°），中间那张填充浅蓝并带两条书写线；
   *   上：土星虫（身体 + 四条细腿 + 横幅光环 + 眯眼）+ 三颗大小不一的蓝色四角星。
   *   光环的遮挡顺序必须是「后半整椭圆 → 身体 → 腿 → 前半下弧」，
   *   这样才有"环穿过身体"的正确层次；只画一段弧会看成张开双臂。
   *
   * ILLUS_V1 · 初版：两张斜叠的牌（后牌空心描边、前牌浅蓝底 + 三条书写线）
   *   + 左上蓝色四角星 + 右下白描边对话泡（内含两条蓝线）。
   *
   * 选取规则见 pickIllus()：每次渲染主卡时独立随机，用 Math.random() < 0.5 抛硬币。
   * 不做「本次页面只用一个」的缓存 —— 翻一张换一次，才有开盲盒的手感。
   */
  var ILLUS_A =
    '<svg viewBox="0 0 220 150" fill="none" aria-hidden="true">' +
      // 底：三张散开的牌
      '<g stroke="#1A1D21" stroke-width="2.1">' +
        '<rect x="30" y="94" width="84" height="52" rx="8" fill="#FFFFFF" transform="rotate(-8 72 120)"/>' +
        '<rect x="52" y="94" width="84" height="52" rx="8" fill="#EAF2FF" transform="rotate(4 94 120)"/>' +
        '<rect x="74" y="94" width="84" height="52" rx="8" fill="#FFFFFF" transform="rotate(14 116 120)"/>' +
      '</g>' +
      '<path d="M92 112h40M92 124h24" stroke="#1A1D21" stroke-width="2.1" ' +
        'stroke-linecap="round" transform="rotate(14 116 120)" opacity="0.45"/>' +
      // 土星虫：光环后半 → 身体 → 腿 → 光环前半 → 眼睛
      '<g>' +
        '<ellipse cx="108" cy="77.4" rx="55.1" ry="10.2" fill="none" stroke="#EFC21E" stroke-width="10.2"/>' +
        '<path d="M74 73C74 32.4 85.6 13.8 108 13.8C130.4 13.8 142 32.4 142 73' +
          'L142 91.6C142 103.1 130.4 108.4 108 108.4C85.6 108.4 74 103.1 74 91.6Z" ' +
          'fill="#FF7A1A" stroke="#1A1D21" stroke-width="1.9"/>' +
        '<path d="M86.6 103.1v24.5M100.9 103.1v24.5M115.1 103.1v24.5M129.4 103.1v24.5" ' +
          'stroke="#FF7A1A" stroke-width="7.5" stroke-linecap="round"/>' +
        '<path d="M52.9 77.4A55.1 10.2 0 0 0 163.1 77.4" fill="none" ' +
          'stroke="#FFD93B" stroke-width="10.2" stroke-linecap="round"/>' +
        '<path d="M95.4 47.4v9.5M95.4 47.4h6.8v9.5M113.8 47.4v9.5M113.8 47.4h6.8v9.5" ' +
          'stroke="#3A1F00" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      '</g>' +
      // 蓝色四角星点缀
      '<path d="M170 35l4.2 8.8 8.8 4.2-8.8 4.2-4.2 8.8-4.2-8.8-8.8-4.2 8.8-4.2z" fill="#1E80FF"/>' +
      '<path d="M190 76l2.6 5.4 5.4 2.6-5.4 2.6-2.6 5.4-2.6-5.4-5.4-2.6 5.4-2.6z" fill="#A8C7FF"/>' +
      '<path d="M30 53l2.2 4.8 4.8 2.2-4.8 2.2-2.2 4.8-2.2-4.8-4.8-2.2 4.8-2.2z" fill="#A8C7FF"/>' +
    '</svg>';

  var ILLUS_V1 =
    '<svg viewBox="0 0 220 150" fill="none" aria-hidden="true">' +
      '<rect x="40" y="34" width="92" height="62" rx="9" transform="rotate(-9 86 65)" ' +
        'stroke="#1A1D21" stroke-width="2.4"/>' +
      '<g transform="rotate(7 120 80)">' +
        '<rect x="74" y="50" width="92" height="62" rx="9" fill="#EAF2FF" ' +
          'stroke="#1A1D21" stroke-width="2.4"/>' +
        '<line x1="90" y1="68" x2="150" y2="68" stroke="#1A1D21" stroke-width="2.4" stroke-linecap="round"/>' +
        '<line x1="90" y1="81" x2="136" y2="81" stroke="#1A1D21" stroke-width="2.4" stroke-linecap="round"/>' +
        '<line x1="90" y1="94" x2="144" y2="94" stroke="#1A1D21" stroke-width="2.4" stroke-linecap="round"/>' +
      '</g>' +
      '<path d="M52 22l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#1E80FF"/>' +
      '<path d="M162 112c0-6.6 5.4-12 12-12h8c6.6 0 12 5.4 12 12s-5.4 12-12 12h-4l-7 6v-6h3c-6.6 0-12-5.4-12-12z" ' +
        'stroke="#1A1D21" stroke-width="2.4" fill="#FFFFFF"/>' +
      '<line x1="172" y1="110" x2="184" y2="110" stroke="#1E80FF" stroke-width="2.4" stroke-linecap="round"/>' +
      '<line x1="172" y1="117" x2="181" y2="117" stroke="#1E80FF" stroke-width="2.4" stroke-linecap="round"/>' +
    '</svg>';

  /* 主卡插画随机选取：每次渲染主卡独立抛硬币，翻一张换一次。 */
  function pickIllus() { return Math.random() < 0.5 ? ILLUS_A : ILLUS_V1; }

  var ICON_USER =
    '<svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">' +
      '<circle cx="8.5" cy="5.9" r="2.7" stroke="#A8AEB8" stroke-width="1.3"/>' +
      '<path d="M3.4 14.1c0-2.3 2.3-4.1 5.1-4.1s5.1 1.8 5.1 4.1" stroke="#A8AEB8" stroke-width="1.3" stroke-linecap="round"/>' +
    '</svg>';

  var ICON_BOLT = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
    '<path d="M5.8 0.4L1.2 5.8h3.4L4.2 9.6l4.6-5.4H5.4L5.8 0.4z" fill="#fff"/></svg>';

  var ICON_BOLT_BLUE = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
    '<path d="M5.8 0.4L1.2 5.8h3.4L4.2 9.6l4.6-5.4H5.4L5.8 0.4z" fill="#1E80FF"/></svg>';

  var ICON_COPY = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">' +
    '<rect x="4.2" y="1.2" width="7.6" height="8.4" rx="1.6" stroke="#fff" stroke-width="1.3"/>' +
    '<path d="M8.8 11.8H2.8c-.8 0-1.4-.6-1.4-1.4V4.4" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/></svg>';

  /* ---------------- 邻卡 ----------------
   * 设计稿里邻卡只有「标签 + 标题 + 正文」三块，按 272 宽排版。
   * 形状与主卡不同：这里不拆导语档，统一走「标题 + 正文」，
   * 无话题时把正文压成单段填满，避免半张卡空着。
   */
  function ghostCard(p, side, anim) {
    var cls = 'ghost ' + side + (anim ? ' anim-' + (side === 'left' ? 'l' : 'r') : '');
    if (!p) return '<article class="' + cls + '"></article>';
    var sb = splitTitleBody(p);
    var body = (sb.body || p.content || '').replace(/\n+/g, ' ').trim();
    if (!sb.title) {
      return '<article class="' + cls + '">' +
        '<span class="tag">沸点</span>' +
        '<h3 class="asbody">' + esc(body.slice(0, 96)) + '</h3>' +
      '</article>';
    }
    return '<article class="' + cls + '">' +
      '<span class="tag">沸点</span>' +
      '<h3>' + esc(sb.title) + '</h3>' +
      '<p>' + esc(body.slice(0, 130)) + '</p>' +
    '</article>';
  }

  /* ---------------- 主卡 ---------------- */
  function mainCard(p, idx, anim) {
    var av = p.avatar
      ? '<img src="' + esc(p.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : ICON_USER;
    var on = isFav(p.id);
    var tb = splitTitleBody(p);
    // 极短沸点（无话题且 ≤ 16 字）：正文居中放大撑住卡片中段
    var short = !tb.title && tb.body.length <= 16;
    var bodyHTML = tb.body
      ? '<div class="body' + (tb.title ? '' : ' lead') + (short ? ' xs' : '') + '">' + esc(tb.body) + '</div>'
      : '';
    return '' +
      '<article class="main' + (anim ? ' anim-in' : '') + (on ? ' liked' : '') + '">' +
        '<div class="chead">' +
          '<span class="tag">' + ICON_BOLT_BLUE + '沸点</span>' +
          '<span class="time">' + esc(fmtTime(p.ctime)) + '</span>' +
        '</div>' +
        (tb.title ? '<h2>' + esc(tb.title) + '</h2>' : '') +
        bodyHTML +
        '<div class="illus">' + pickIllus() + '</div>' +
        '<div class="spacer"></div>' +
        '<div class="cfoot">' +
          '<span class="bignum">' + pad(idx + 1) + '</span>' +
          '<span class="dash"></span>' +
          '<div class="who">' +
            '<div class="line1">' +
              '<span class="av">' + av + '</span>' +
              '<span class="name">' + esc(p.user) + '</span>' +
            '</div>' +
            '<span class="meta">' + (p.digg || 0) + ' 赞 · ' + (p.cmt || 0) + ' 评论</span>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  /* ---------------- AI 点评卡 ----------------
   * 外壳 <aside class="ai"> 写在 index.html 里（它在卡片容器之外、单独定位），
   * 这里只返回卡内内容。注意别再套一层 .ai——套了会嵌套两层 absolute 直接被推出卡外。
   */
  function aiCard(p) {
    var r = roastFor(p);
    var body = r.loading
      ? (batchCtl
        ? (batchCtl.serial
          ? '<span class="ai-loading"><i class="spin"></i>AI 批量点评中 ' +
            batchCtl.done + '/' + batchCtl.total +
            '（' + Math.round(batchCtl.done / batchCtl.total * 100) + '%）</span>'
          : '<span class="ai-loading"><i class="spin"></i>AI 正在一次性点评 ' +
            batchCtl.total + ' 条 · 已等 ' +
            Math.round((Date.now() - batchCtl.start) / 1000) + 's</span>')
        : '<span class="ai-loading"><i class="dot"></i><i class="dot"></i><i class="dot"></i>AI 正在看这条沸点…</span>')
      : '<span' + (r.live ? ' class="roast-live"' : '') + '>' + esc(r.text) + '</span>';
    return '' +
      '<span class="badge">' + ICON_BOLT + 'AI 点评</span>' +
      '<div class="roast">' + body + '</div>' +
      '<button class="copy" id="btnCopy">' + ICON_COPY + '一键评论</button>' +
      '<div class="note">毒的是现象，不是你。</div>';
  }

  /* 当前这条该显示什么点评：
   * 配了 AI 接口 → 优先实时生成（命中缓存直接用，否则先显示加载态）；
   * 没配 → 手写点评或占位文案。 */
  function roastFor(p) {
    if (aiCfg) {
      if (roastCache[p.id]) return { text: roastCache[p.id], live: true };
      /* 刚失败过的牌显示回退文案，不无限转圈 */
      if (roastFail[p.id] && Date.now() - roastFail[p.id] < 30000) {
        return { text: p.roast || '（生成失败，稍后再翻回来重试）', live: false };
      }
      return { loading: true };
    }
    return { text: p.roast || '（这条还没配点评）', live: false };
  }

  /* /api/roast 响应解析：旧版预览服务没有该路由时会返回纯文本 404，
   * 直接 r.json() 会抛出谁也看不懂的语法错误——转成可操作的提示。 */
  function parseRoastRes(r) {
    return r.text().then(function (t) {
      var d = null;
      try { d = JSON.parse(t); } catch (e) { /* 非 JSON：多半是旧服务的 404 纯文本 */ }
      if (!d) {
        throw new Error(r.status === 404
          ? '预览服务还是旧版（缺 /api/roast），请关掉预览卡片重新打开'
          : '服务返回异常（HTTP ' + r.status + '）');
      }
      return { ok: r.ok, d: d };
    });
  }

  /* 经 /api/roast 实时生成本条点评。生成回来后若页面还停在这条，
   * 就地重建 AI 卡内容；失败则回退手写点评/占位并提示原因。 */
  function maybeRoast(p) {
    if (!aiCfg || roastCache[p.id]) return;
    /* 批量进行时不重复发单条，只把卡片刷成进度态 */
    if (batchCtl) { refreshAiCard(); return; }
    if (roastFail[p.id] && Date.now() - roastFail[p.id] < 30000) return; // 30s 负缓存
    if (roastAbort) roastAbort.abort();
    var ctl = roastAbort = new AbortController();
    fetch('/api/roast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: aiCfg.baseUrl, token: aiCfg.token, model: aiCfg.model,
        content: p.content, topic: p.topic,
        prompt: currentStyle().prompt,
      }),
      signal: ctl.signal,
    })
      .then(parseRoastRes)
      .then(function (res) {
        if (roastAbort === ctl) roastAbort = null;
        if (!res.ok || !res.d.roast) throw new Error((res.d && res.d.error) || 'AI 接口异常');
        roastCache[p.id] = res.d.roast;
        var cur = PINS[S.order[S.pos]];
        if (cur && cur.id === p.id) {
          var ai = $('#ai');
          if (ai) { ai.innerHTML = aiCard(cur); bindAI(); }
        }
      })
      .catch(function (e) {
        if (roastAbort === ctl) roastAbort = null;
        if (e && e.name === 'AbortError') return; // 被更新的翻牌打断，安静丢弃
        roastFail[p.id] = Date.now(); // 记失败时间，30s 内不再重试
        var cur = PINS[S.order[S.pos]];
        if (cur && cur.id === p.id) {
          var ai = $('#ai');
          var s = ai && ai.querySelector('.roast span');
          if (s) {
            s.className = '';
            s.textContent = p.roast || '（生成失败：' + ((e && e.message) || e) + '）';
          }
        }
        toast('AI 点评生成失败：' + ((e && e.message) || e));
      });
  }

  /* ---------------- 批量点评 ----------------
   * 一次动作把当前所有还没点评过的牌全部生成完（启动 / 洗牌 / 换配置 /
   * 换风格后自动触发）。主路径是【单次请求】：整副牌打包发给 /api/roast，
   * 服务端拼成一次上游调用、JSON 数组一次拿回——彻底不触发并发限流。
   * 批量请求失败时退化为逐条串行（间隔 300ms，限流退避 2.5s）把队列跑完。
   */

  /* 单条生成的 Promise 版（兜底串行用）：成功写缓存、失败记 30s 负缓存，
   * 无论成败都 resolve（队列不因一条失败而中断）。
   * 命中限流类错误时返回 'throttled'，由调用方决定额外退避。 */
  function roastOne(p) {
    return fetch('/api/roast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: aiCfg.baseUrl, token: aiCfg.token, model: aiCfg.model,
        content: p.content, topic: p.topic,
        prompt: currentStyle().prompt,
      }),
    })
      .then(parseRoastRes)
      .then(function (res) {
        if (!res.ok || !res.d.roast) throw new Error((res.d && res.d.error) || 'AI 接口异常');
        roastCache[p.id] = res.d.roast;
        delete roastFail[p.id];
        return 'ok';
      })
      .catch(function (e) {
        roastFail[p.id] = Date.now();
        var msg = (e && e.message) || String(e);
        return /quota|限流|429|concurrency/i.test(msg) ? 'throttled' : 'fail';
      });
  }

  /* 就地刷新 AI 卡内容（进度变化 / 当前卡点评已生成时）。
   * 翻转动画播放期间不动内容：中点换内容由 render 的 aiSwapTimer 负责。 */
  function refreshAiCard() {
    var p = PINS[S.order[S.pos]];
    var ai = $('#ai');
    if (!p || !ai || ai.classList.contains('anim-in')) return;
    ai.innerHTML = aiCard(p);
    bindAI();
  }

  function stopBatch() {
    batchCtl = null;
    if (batchTicker) { clearInterval(batchTicker); batchTicker = null; }
  }

  /* 兜底：逐条串行把队列跑完（批量请求失败时启用） */
  function runSerial(queue, myId) {
    batchCtl = { id: myId, total: queue.length, done: 0, serial: true };
    refreshAiCard();
    (function step() {
      if (!batchCtl || batchCtl.id !== myId || batchCtl.done >= queue.length) {
        stopBatch();
        refreshAiCard();
        return;
      }
      roastOne(queue[batchCtl.done]).then(function (r) {
        if (!batchCtl || batchCtl.id !== myId) return; // 中途被取消
        batchCtl.done++;
        refreshAiCard();
        /* 限流信号：额外退避 2.5s，给上游并发额度回口气 */
        setTimeout(step, r === 'throttled' ? 2800 : 300);
      });
    })();
  }

  function startBatch() {
    if (!aiCfg || batchCtl) return;
    var queue = [];
    for (var i = 0; i < S.order.length; i++) {
      var p = PINS[S.order[i]];
      if (!p || roastCache[p.id]) continue;
      if (roastFail[p.id] && Date.now() - roastFail[p.id] < 30000) continue;
      queue.push(p);
    }
    if (!queue.length) return;
    var myId = ++batchSeq;
    batchCtl = { id: myId, total: queue.length, start: Date.now() };
    refreshAiCard();
    /* 单次请求可能等十几秒，每秒刷一次「已等 Xs」让等待可感知 */
    batchTicker = setInterval(function () {
      if (batchCtl && batchCtl.id === myId && !batchCtl.serial) refreshAiCard();
    }, 1000);
    fetch('/api/roast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: aiCfg.baseUrl, token: aiCfg.token, model: aiCfg.model,
        prompt: currentStyle().prompt,
        items: queue.map(function (p) { return { id: p.id, content: p.content, topic: p.topic }; }),
      }),
    })
      .then(parseRoastRes)
      .then(function (res) {
        if (!batchCtl || batchCtl.id !== myId) return; // 已被取消/替换
        if (!res.ok || !res.d.roasts) throw new Error((res.d && res.d.error) || 'AI 接口异常');
        var got = res.d.roasts;
        var okCount = 0;
        for (var i = 0; i < queue.length; i++) {
          var p = queue[i];
          if (got[p.id]) { roastCache[p.id] = got[p.id]; delete roastFail[p.id]; okCount++; }
          else roastFail[p.id] = Date.now(); // 模型漏答的记负缓存，30s 后可重试
        }
        stopBatch();
        refreshAiCard();
        toast('AI 批量点评完成 · ' + okCount + '/' + queue.length + ' 条');
      })
      .catch(function (e) {
        if (!batchCtl || batchCtl.id !== myId) return;
        /* 单次批量失败（超时/模型不吐 JSON 等）→ 退化为逐条串行，仍然跑完 */
        toast('批量点评未成功（' + ((e && e.message) || e) + '），改为逐条生成');
        runSerial(queue, myId);
      });
  }

  /* ---------------- 渲染 ----------------
   * 离场层交叉淡化模型（见 app.css 动效章节）：
   * dir 只在翻页时有意义：+1 前进、−1 后退，落到 #cards 的 .fwd/.bwd 类上。
   * 翻页时先把当前三张卡原样搬进 .out-layer（旧主卡滑向行进后侧的邻卡位
   * 并淡出，旧邻卡快速淡出），再写入新卡；新主卡从对应侧邻卡位滑入、
   * 焦点由糊到清，新邻卡在卡位上淡入。新旧在交接点交叉淡化，
   * 掩盖「邻卡版式 → 主卡版式」的内容跳变。首屏渲染传 (false, 0)，不播动画。
   */
  function render(anim, dir) {
    var host = $('#cards');
    var ai = $('#ai');
    if (!S.order.length) {
      host.innerHTML = '<div class="empty"><b>牌堆是空的</b>' +
        '<span>把 site/data.js 放进来就有牌了。</span></div>';
      if (ai) ai.innerHTML = '';
      updateHud();
      return;
    }

    host.classList.toggle('fwd', dir > 0);
    host.classList.toggle('bwd', dir < 0);

    var idx = S.order[S.pos];
    var p = PINS[idx];
    var prev = S.order[S.pos - 1] != null ? PINS[S.order[S.pos - 1]] : null;
    var next = S.order[S.pos + 1] != null ? PINS[S.order[S.pos + 1]] : null;
    if (!prev && S.order.length > 1) prev = PINS[S.order[S.order.length - 1]];
    if (!next && S.order.length > 1) next = PINS[S.order[0]];

    /* 离场层：必须先移动节点再写 innerHTML，否则旧卡随 innerHTML 一起销毁。
     * 快速连翻时先清掉上一轮还没播完的离场层，避免无限堆叠。 */
    clearTimeout(outTimer);
    var stale = host.querySelector('.out-layer');
    if (stale) stale.remove();
    var out = null;
    if (anim && host.querySelector('.main')) {
      out = document.createElement('div');
      out.className = 'out-layer';
      Array.prototype.slice.call(host.children).forEach(function (el) {
        /* 摘掉上一轮的入场类：其动画停在结束帧（fill:both），
         * 不摘会与 .out-layer 的离场动画争抢同一属性。 */
        el.classList.remove('anim-in', 'anim-l', 'anim-r');
        out.appendChild(el);
      });
    }

    host.innerHTML = ghostCard(prev, 'left', anim) + mainCard(p, idx, anim) + ghostCard(next, 'right', anim);
    if (out) {
      host.appendChild(out);
      /* 离场动画最长 440ms；定时器兜底移除，不依赖 animationend（连翻时可能漏事件） */
      outTimer = setTimeout(function () { out.remove(); }, 700);
    }
    if (ai) {
      /* #ai 是常驻元素（不是像卡片那样随 innerHTML 重建），
       * 如果只是 classList.toggle('anim-in', true)，类名已经在身上，
       * 动画不会被重新触发——从第二次翻页开始 AI 卡就静止了。
       * 必须先摘掉类、强制 reflow、再加回，才能让动画每次都重新起跑。 */
      ai.classList.remove('anim-in');
      clearTimeout(aiSwapTimer);
      if (anim) {
        void ai.offsetWidth;
        ai.classList.add('anim-in');
        /* 翻转动画在 50%（60ms 延迟 + 480ms×50% ≈ 300ms）处处于立边不可见，
         * 此刻换掉卡内内容，人眼看到的是「翻过去旧点评、翻过来新点评」。
         * 系统开启减少动态且未强制 ?motion=full 时动画被降级，立即换内容。 */
        var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
          !document.documentElement.classList.contains('motion-full');
        aiSwapTimer = setTimeout(function () {
          ai.innerHTML = aiCard(p);
          bindAI();
        }, reduced ? 0 : 300);
      } else {
        ai.innerHTML = aiCard(p);
        bindAI();
      }
    }

    S.seen[p.id] = true;
    saveLocal();
    updateHud();
    syncDock(p, idx);
    /* 配了 AI 接口就实时生成本条点评（未命中缓存时），
     * 生成回来后由 maybeRoast 自己就地更新卡片。
     * 700ms 防抖：只有停下来的牌才发请求，翻牌路过的中间卡不打接口。 */
    clearTimeout(roastKickTimer);
    roastKickTimer = setTimeout(function () { maybeRoast(p); }, 700);
  }

  /* 迷你卡片（dock）内容同步：牌号与主卡左下角大数字一致（原始序号），
   * 纸牌式布局有左上/右下两个牌号角，一起更新；
   * 标题沿用主卡的拆分逻辑——有话题取话题，无话题取正文开头。
   * 收起状态下盲翻时给卡面一个短促的 tick 反馈，提示牌面已换。 */
  function syncDock(p, idx) {
    /* 牌角改为纸牌的「点数 + 花色」：按牌序映射到 A~K × ♠♥♣♦，
     * 一副 52 张排完自动进入下一副；红桃/方块为红色，黑桃/梅花为黑色 */
    var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    var SUITS = ['♠', '♥', '♣', '♦'];
    var suit = SUITS[Math.floor(idx / 13) % 4];
    var red = suit === '♥' || suit === '♦';
    var corners = document.querySelectorAll('.dock .dc-corner');
    for (var i = 0; i < corners.length; i++) {
      var n = corners[i].querySelector('.dc-num');
      var s = corners[i].querySelector('.dc-suit');
      if (n) n.textContent = RANKS[idx % 13];
      if (s) s.textContent = suit;
      corners[i].classList.toggle('red', red);
    }
    var dt = $('#dockTitle');
    if (dt) {
      var tb = splitTitleBody(p);
      dt.textContent = (tb.title || tb.body || '（空沸点）').replace(/\n+/g, ' ').slice(0, 32);
    }
    if (document.body.classList.contains('folded')) {
      var dc = document.querySelector('.dock .dock-card');
      if (dc) { dc.classList.remove('tick'); void dc.offsetWidth; dc.classList.add('tick'); }
    }
  }

  /* 「一键评论」：把当前点评直接发到这条沸点的评论区（经 /api/comment 转发）。
   * 关键：render() 每次都把 #ai 的 innerHTML 整个换掉，旧按钮随旧 DOM 一起销毁，
   * 所以必须在每次 render 之后重新绑一次——只绑一次的话，翻第二张按钮就失效了。
   * 未配置掘金 Cookie 时自动退化为「复制文案」，按钮任何时候都有用。 */
  function bindAI() {
    var cp = $('#btnCopy');
    if (!cp) return;
    cp.onclick = function () {
      var p = PINS[S.order[S.pos]];
      if (!p) return;
      /* 优先发实时生成的点评，其次手写点评 */
      var text = roastCache[p.id] || p.roast;
      if (!text) { toast(aiCfg ? '点评还在生成中…' : '这条还没配点评'); return; }
      var btn = this;
      btn.disabled = true;
      var oldHtml = btn.innerHTML;
      btn.textContent = '评论中…';
      fetch('/api/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pinId: p.id,
          content: text,
          cookie: localStorage.getItem(JJ_COOKIE_KEY) || '',
        }),
      })
        .then(parseRoastRes)
        .then(function (res) {
          if (res.ok && res.d.ok) {
            btn.textContent = '已评论 ✓';
            toast('已评论到这条沸点 ✓');
            return;
          }
          var msg = (res.d && res.d.error) || '评论失败';
          /* 没配 Cookie：不报错，退化为复制文案 */
          if (/未配置掘金 Cookie/.test(msg)) {
            copyText(text).then(function () {
              toast('未配置掘金 Cookie，已复制文案，去评论区粘贴即可');
            });
          } else {
            toast('评论失败：' + msg);
          }
          btn.innerHTML = oldHtml;
          btn.disabled = false;
        })
        .catch(function (e) {
          toast('评论失败：' + ((e && e.message) || e));
          btn.innerHTML = oldHtml;
          btn.disabled = false;
        });
    };
  }

  function updateHud() {
    var total = S.order.length;
    $('#progText').textContent = total
      ? '第 ' + (S.pos + 1) + ' / ' + total + ' 张 · 已看 ' + seenCount() + ' · 喜欢 ' + likedCount()
      : '第 0 / 0 张 · 已看 0 · 喜欢 0';
    /* 迷你卡片（收起态）里的进度同步：竖版纸牌宽度有限，
     * 只保留「第 N / M 张」，喜欢数由下方 HUD 完整展示 */
    var dp = $('#dockProg');
    if (dp) dp.textContent = total
      ? '第 ' + (S.pos + 1) + ' / ' + total + ' 张'
      : '牌堆是空的';
    $('#btnPrev').disabled = total === 0 || S.pos === 0;
    $('#btnNext').disabled = total === 0;
  }

  /* ---------------- 翻牌音效 ----------------
   * Web Audio 现场合成纸牌「咔哒」声：带通噪声脉冲（纸面摩擦）
   * + 三角波低频短促下扫（牌落桌面的"嗒"）。无音频文件、零加载。
   * 中心频率带随机抖动，连续翻牌不会显得机械。 */
  var audioCtx = null;
  function playFlip() {
    if (S.muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;
      var dur = 0.09;
      var buf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * dur), audioCtx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < data.length; i++) {
        var x = i / data.length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - x, 2.2);
      }
      var noise = audioCtx.createBufferSource();
      noise.buffer = buf;
      var bp = audioCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200 + Math.random() * 700;
      bp.Q.value = 0.9;
      var g = audioCtx.createGain();
      g.gain.setValueAtTime(0.32, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      noise.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
      noise.start(t);

      var osc = audioCtx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, t);
      osc.frequency.exponentialRampToValueAtTime(140, t + 0.07);
      var g2 = audioCtx.createGain();
      g2.gain.setValueAtTime(0.16, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      osc.connect(g2); g2.connect(audioCtx.destination);
      osc.start(t); osc.stop(t + 0.09);
    } catch (e) { /* 无音频环境：静默降级 */ }
  }

  function setMuted(on) {
    S.muted = on;
    saveLocal();
    var b = $('#btnMute');
    if (b) {
      b.classList.toggle('muted', on);
      b.setAttribute('aria-label', on ? '取消静音' : '静音');
      b.setAttribute('aria-pressed', String(on));
    }
  }

  /* ---------------- 翻牌 ---------------- */
  function go(delta) {
    if (!S.order.length) return;
    var n = S.pos + delta;
    if (n < 0) { toast('已经是第一张了'); return; }
    playFlip();
    if (n >= S.order.length) {
      shuffleOrder(); S.pos = 0; render(true, 1);
      toast('这副牌抽完了，重新洗一副');
      return;
    }
    S.pos = n;
    render(true, delta);
  }

  /* 纯换序：牌堆本身不变，只重排顺序并回到第一张 */
  function shuffleDeck(msg) {
    if (!S.order.length) return;
    shuffleOrder();
    S.pos = 0;
    render(true, 1);
    toast(msg || '已重新洗牌');
  }

  /* 洗牌（产品语义）= 拉取最新沸点 + 重洗：
   * 绕过 /api/pins 的 180s 缓存强取上游；拉不到（离线 / 接口异常 /
   * file:// 直开）退化为纯换序——任何环境下「洗牌」都有反馈。 */
  var refreshing = false;
  function refreshDeck() {
    if (refreshing) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      shuffleDeck();
      return;
    }
    refreshing = true;
    var fab = $('#btnRefresh');
    if (fab) fab.classList.add('busy');
    function done() {
      refreshing = false;
      if (fab) fab.classList.remove('busy');
    }
    fetchLivePins(8000, true).then(function (pins) {
      done();
      if (pins && pins.length) {
        PINS = pins;
        rebuild();
        render(true, 1);
        toast('已获取最新沸点 · ' + pins.length + ' 条');
        startBatch(); // 新牌堆逐张补齐点评
      } else {
        shuffleDeck('没拉到新数据，先洗一遍手头的');
      }
    }, function () {
      done();
      shuffleDeck('获取失败，先洗一遍手头的');
    });
  }

  function toggleLike() {
    if (!S.order.length) return;
    var p = PINS[S.order[S.pos]];
    var on = !S.liked[p.id];
    S.liked[p.id] = on;
    saveLocal();
    // 只切类名，不重绘，避免翻牌动画重放
    var card = document.querySelector('.main');
    if (card) card.classList.toggle('liked', on);
    updateHud();
    toast(on ? '已加入收藏' : '取消收藏');
  }

  /* ---------------- 舞台等比缩放 ----------------
   * 坐标系固定 1440 宽，版心放不下时整组按 --k 缩，
   * transform-origin: center top（版心居中，顶边不动），横向溢出由 .page-wrap 裁掉。
   * 只负责写 --k；布局切换（两卡 / 单列）由 CSS 断点接管，这里不插手。
   *
   * 断点 760 必须与 app.css 的 @media(max-width:760px) 保持一致：
   * 1440~760 之间走等比缩放（1080 视口 → k=0.75，字仍清晰），
   * 760 以下才交给流式布局。旧版这里写的是 1120，与 CSS 断点虽同步
   * 但时机太早，会让 1080 视口白白丢掉坐标系。
   */
  var DESIGN_W = 1440;
  var FLOW_BREAKPOINT = 760;
  function fitStage() {
    var wrap = document.querySelector('.page-wrap');
    if (!wrap) return;
    if (window.matchMedia &&
        window.matchMedia('(max-width:' + FLOW_BREAKPOINT + 'px)').matches) {
      document.documentElement.style.setProperty('--k', '1');
      return;
    }
    /* 扣除 .page-wrap 两侧的 24px 安全边距（见 app.css），
     * 否则 k<1 时缩放画布恰好撑满视口，AI 卡右缘会贴死窗口边缘 */
    var avail = wrap.clientWidth - 48;
    if (!avail || avail < 0) return;
    var k = Math.min(1, avail / DESIGN_W);
    document.documentElement.style.setProperty('--k', String(Math.round(k * 1000) / 1000));
  }

  /* ---------------- 收起 ⇄ 迷你卡片 ----------------
   * 形态切换全部由 CSS transition 完成（见 app.css dock 章节），
   * JS 只负责切 body.folded 类与无障碍标注。 */
  function setFolded(on) {
    document.body.classList.toggle('folded', on);
    var dock = $('#dock');
    dock.setAttribute('aria-expanded', String(!on));
    dock.setAttribute('aria-label', on ? '展开页面' : '收起为卡片');
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    $('#btnNext').onclick = function () { go(1); };
    $('#btnPrev').onclick = function () { go(-1); };
    $('#dock').onclick = function () {
      setFolded(!document.body.classList.contains('folded'));
    };
    var mb = $('#btnMute');
    if (mb) mb.onclick = function () { setMuted(!S.muted); };
    var sb = $('#btnShuffle');
    if (sb) sb.onclick = refreshDeck;
    var rf = $('#btnRefresh');
    if (rf) rf.onclick = refreshDeck;

    /* ---- AI 点评接口配置弹窗 ---- */
    var cfgMask = $('#aiCfgMask');
    function syncCfgBtn() {
      var b = $('#btnAiCfg');
      if (b) b.classList.toggle('on', !!aiCfg);
    }
    function openCfg() {
      $('#aiCfgBase').value = aiCfg ? aiCfg.baseUrl : '';
      $('#aiCfgToken').value = aiCfg ? aiCfg.token : '';
      $('#aiCfgModel').value = aiCfg ? aiCfg.model : '';
      $('#aiCfgCookie').value = localStorage.getItem(JJ_COOKIE_KEY) || '';
      /* 探测服务端 .ai-config.json：已配 Key / Cookie 则提示「可留空」，并预填地址/模型 */
      fetch('/api/roast/config').then(function (r) { return r.ok ? r.json() : null; })
        .then(function (c) {
          if (!c) return;
          $('#aiCfgSrvTag').hidden = !c.serverKey;
          $('#aiCfgCookieTag').hidden = !c.jjCookie;
          if (c.serverKey) {
            if (!$('#aiCfgBase').value && c.baseUrl) $('#aiCfgBase').value = c.baseUrl;
            if (!$('#aiCfgModel').value && c.model) $('#aiCfgModel').value = c.model;
          }
        })
        .catch(function () {});
      cfgMask.hidden = false;
    }
    function closeCfg() { cfgMask.hidden = true; }
    function applyCfg(next) {
      aiCfg = next;
      stopBatch(); // 换配置/清配置都先停掉进行中的批量
      if (next) localStorage.setItem(AI_CFG_KEY, JSON.stringify(next));
      else localStorage.removeItem(AI_CFG_KEY);
      /* 换接口/模型后旧缓存失效，清空并让当前卡重新生成 */
      roastCache = {};
      roastFail = {};
      syncCfgBtn();
      render(false, 0);
      startBatch();
    }
    var cb = $('#btnAiCfg');
    if (cb) cb.onclick = openCfg;
    $('#aiCfgClose').onclick = closeCfg;
    cfgMask.addEventListener('click', function (e) { if (e.target === cfgMask) closeCfg(); });
    $('#aiCfgSave').onclick = function () {
      var next = {
        baseUrl: $('#aiCfgBase').value.trim(),
        token: $('#aiCfgToken').value.trim(),
        model: $('#aiCfgModel').value.trim(),
      };
      /* 掘金 Cookie 独立保存：不参与「是否配置 AI 接口」的判断 */
      var ck = $('#aiCfgCookie').value.trim();
      if (ck) localStorage.setItem(JJ_COOKIE_KEY, ck);
      else localStorage.removeItem(JJ_COOKIE_KEY);
      if (!next.baseUrl && !next.token && !next.model) {
        applyCfg(null);
        toast('未配置 AI 接口，使用内置点评');
      } else if (!next.baseUrl || !next.model) {
        toast('接口地址和模型必填；Key 可留空（由服务端文件提供）');
        return;
      } else {
        applyCfg(next);
        toast(next.token ? '已保存，翻牌时实时生成点评' : '已保存，Key 由服务端文件提供');
      }
      closeCfg();
    };
    $('#aiCfgClear').onclick = function () {
      applyCfg(null);
      localStorage.removeItem(JJ_COOKIE_KEY);
      closeCfg();
      toast('已清除配置，回到内置点评');
    };
    $('#aiCfgTest').onclick = function () {
      var btn = this;
      var cfg = {
        baseUrl: $('#aiCfgBase').value.trim(),
        token: $('#aiCfgToken').value.trim(),
        model: $('#aiCfgModel').value.trim(),
      };
      if (!cfg.baseUrl || !cfg.model) { toast('接口地址和模型必填'); return; }
      if (!cfg.token) { toast('Key 为空，将使用服务端 .ai-config.json 里的'); }
      btn.disabled = true;
      btn.textContent = '测试中…';
      fetch('/api/roast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: cfg.baseUrl, token: cfg.token, model: cfg.model,
          content: '今天又是周一，感觉人生无望。', topic: '测试',
        }),
      })
        .then(parseRoastRes)
        .then(function (res) {
          if (!res.ok || !res.d.roast) throw new Error((res.d && res.d.error) || 'AI 接口异常');
          toast('测试成功：' + res.d.roast.slice(0, 40));
        })
        .catch(function (e) { toast('测试失败：' + ((e && e.message) || e)); })
        .finally(function () { btn.disabled = false; btn.textContent = '测试一下'; });
    };
    syncCfgBtn();

    /* ---- 点评风格弹窗：卡牌式选择 ---- */
    var styleMask = $('#styleMask');
    function syncStyleBtn() {
      var b = $('#btnStyle');
      if (b) b.classList.toggle('on', currentStyle().id !== 'toxic');
    }
    function buildStyleGrid() {
      var grid = $('#styleGrid');
      var cur = currentStyle().id;
      grid.innerHTML = STYLES.map(function (s) {
        return '<button type="button" class="style-card' + (s.id === cur ? ' on' : '') +
          '" data-style="' + s.id + '">' +
          '<b>' + esc(s.name) + '</b>' +
          '<span class="demo">' + esc(s.demo) + '</span>' +
          '<span class="prompt">' + esc(s.prompt) + '</span>' +
          '</button>';
      }).join('');
      var cards = grid.querySelectorAll('.style-card');
      for (var i = 0; i < cards.length; i++) {
        cards[i].onclick = function () {
          var id = this.getAttribute('data-style');
          localStorage.setItem(STYLE_KEY, id);
          /* 换风格后旧点评缓存全部失效，当前卡立即按新风格重新生成 */
          roastCache = {};
          roastFail = {};
          buildStyleGrid();
          syncStyleBtn();
          render(false, 0);
          toast('已换成「' + currentStyle().name + '」');
          startBatch(); // 新风格逐张补齐点评
        };
      }
    }
    function openStyle() { buildStyleGrid(); styleMask.hidden = false; }
    function closeStyle() { styleMask.hidden = true; }
    var stb = $('#btnStyle');
    if (stb) stb.onclick = openStyle;
    $('#styleClose').onclick = closeStyle;
    styleMask.addEventListener('click', function (e) { if (e.target === styleMask) closeStyle(); });
    syncStyleBtn();

    /* 启动时探测服务端 .ai-config.json：浏览器完全没配过且服务端配全了，
     * 就直接采用服务端配置——Key 全程不进浏览器（控制台/Network 都看不到）。 */
    if (!aiCfg) {
      fetch('/api/roast/config').then(function (r) { return r.ok ? r.json() : null; })
        .then(function (c) {
          if (c && c.serverKey && c.baseUrl && c.model && !aiCfg) {
            aiCfg = { baseUrl: c.baseUrl, token: '', model: c.model };
            syncCfgBtn();
            render(false, 0);
            startBatch();
          }
        })
        .catch(function () { /* 静态服务器无此路由，静默忽略 */ });
    }

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(fitStage, 80);
    });
    var mq = window.matchMedia
      ? window.matchMedia('(max-width:' + FLOW_BREAKPOINT + 'px)')
      : null;
    if (mq) {
      var onmq = function () { fitStage(); };
      if (mq.addEventListener) mq.addEventListener('change', onmq);
      else if (mq.addListener) mq.addListener(onmq);
    }
    fitStage();

    document.addEventListener('keydown', function (e) {
      /* 弹窗打开时：Esc 只关弹窗，不触发收起页面 */
      if (e.key === 'Escape') {
        if (!cfgMask.hidden) { closeCfg(); return; }
        if (!styleMask.hidden) { closeStyle(); return; }
      }
      var tag = (e.target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      var ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON') ae.blur();

      /* Esc 随时可收起；M 随时可切换静音；S 随时可洗牌（均含收起状态） */
      if (e.key === 'Escape') { setFolded(true); return; }
      if (e.key === 'm' || e.key === 'M') { setMuted(!S.muted); return; }
      if (e.key === 's' || e.key === 'S') { refreshDeck(); return; }
      /* 收起状态：允许 ← → / 空格 盲翻（只换数据与迷你卡，页面保持隐藏），
       * 其余键（喜欢 L / 看评论 C）仍然屏蔽 */
      if (document.body.classList.contains('folded')) {
        if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
        return;
      }

      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'l' || e.key === 'L') toggleLike();
      else if (e.key === 'c' || e.key === 'C') {
        var p = PINS[S.order[S.pos]];
        if (p) window.open(p.url, '_blank', 'noopener');
      }
    });

    // 触屏：左右滑
    var x0 = null;
    var host = $('#stageInner');
    host.addEventListener('touchstart', function (e) {
      x0 = e.changedTouches[0].clientX;
    }, { passive: true });
    host.addEventListener('touchend', function (e) {
      if (x0 == null) return;
      var dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 55) go(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  /* ---------------- 实时沸点 ----------------
   * 浏览器直连 api.juejin.cn 会被 CORS 拦截，所以经同源 /api/pins
   * （serve.mjs 的服务端代理）拉取实时沸点。失败场景
   * （离线 / file:// 直开 / 接口变动 / 超时）一律回退到 data.js
   * 的内置牌堆——页面在任何环境下都可用。 */
  function fetchLivePins(timeoutMs, fresh) {
    return new Promise(function (resolve, reject) {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('timeout'));
      }, timeoutMs || 8000);
      fetch(fresh ? 'api/pins?fresh=1' : 'api/pins', ctrl ? { signal: ctrl.signal } : {})
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (v) { clearTimeout(timer); resolve((v && v.pins) || []); })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function startDeck() {
    if (!PINS.length) {
      $('#cards').innerHTML = '<div class="empty"><b>没读到牌面数据</b>' +
        '<span>确认 site/data.js 和 index.html 在同一目录。<br>' +
        '如果直接双击打开，部分浏览器会拦截本地文件读取。</span></div>';
      updateHud();
      return;
    }
    rebuild();
    /* 首屏传 false：不播入场动画。
     * 首屏没有「从上一张翻过来」的语义，静止呈现更稳，
     * 动画只留给真正的翻页动作（go() 里始终传 true）。 */
    render(false, 0);
    /* 配了 AI 接口就顺带把整副牌未点评的都批量补齐 */
    startBatch();
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    loadLocal();
    /* file:// 直开没有代理可用，直接用内置牌堆 */
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      startDeck();
      return;
    }
    /* 加载态：HUD 的 spinner 本来就在转，补一句文案 */
    $('#progText').textContent = '正在获取实时沸点…';
    fetchLivePins(8000).then(function (pins) {
      if (pins && pins.length) {
        PINS = pins;
        startDeck();
        toast('已更新为实时沸点 · ' + pins.length + ' 条');
      } else {
        startDeck();
      }
    }, function () { startDeck(); });
  }

  bind();
  boot();
  // 首帧宽度可能还没定（DOM 刚解析完），等布局稳定再量一次；
  // 字体加载完也会改变文字宽度，所以 fonts.ready 后再补一次。
  window.addEventListener('load', fitStage);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(fitStage).catch(function () {});
  }
  requestAnimationFrame(fitStage);
})();

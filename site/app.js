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
 * 不上传、不做掘金账号体系：评论一键代发暂时下线（见 COMMENT_POST_ENABLED），
 * 下线期间按钮一律复制；恢复后扩展模式用页面自身的掘金登录态（先探测、
 * 已登录才亮按钮），站点模式用用户自配的 Cookie，均由用户亲手点发。
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

  var S = { order: [], pos: 0, liked: {}, seen: {}, muted: true, motion: 'full' };

  /* ---------------- 动效档 ----------------
   * 三档，持久化在 localStorage（S.motion）：
   *   'full'   完整    ：翻牌滑动 / 焦点吸入 / 离场层交叉淡化 / AI 卡翻转（默认档）
   *   'lite'   轻量    ：去掉位移、缩放、blur，只留 130ms 纯淡入（见 app.css）
   *   'system' 跟随系统：读 prefers-reduced-motion，命中 reduce 时按 lite 走
   *
   * 为什么默认是 full 而不是跟随系统：本站的观感主要就靠这套翻牌动效，
   * 不该因为预览环境/系统设置被静悄悄降级成「看起来没动画」。需要减少
   * 动效的用户可在底部 HUD 的「动效」钮一键切到轻量或跟随系统，选择会记住。
   *
   * CSS 侧只认 html.motion-lite / html.motion-full 两个类，媒体查询由这里解析——
   * 单一真相，避免 CSS 里再散落 @media(prefers-reduced-motion)。
   * URL 覆写（临时预览用，不落盘）：?motion=full|lite|system */
  var MOTION_MODES = ['full', 'lite', 'system'];
  var MOTION_LABEL = { full: '完整', lite: '轻量', system: '跟随系统' };
  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var urlMotion = (function () {
    var m = /[?&]motion=([a-z]+)/.exec(location.search);
    return m && MOTION_MODES.indexOf(m[1]) >= 0 ? m[1] : null;
  })();

  function resolveMotion() {
    var mode = MOTION_MODES.indexOf(S.motion) >= 0 ? S.motion : 'full';
    var lite = mode === 'lite' || (mode === 'system' && motionQuery.matches);
    var root = document.documentElement;
    root.classList.toggle('motion-lite', lite);
    root.classList.toggle('motion-full', !lite);
    var btn = $('#btnMotion');
    if (btn) {
      btn.setAttribute('aria-pressed', lite ? 'false' : 'true');
      btn.setAttribute('aria-label', '动效：' + MOTION_LABEL[mode] + (lite ? '（已降级）' : ''));
      btn.title = '动效：' + MOTION_LABEL[mode] + ' —— 点击切换';
    }
    var lab = $('#motionLabel');
    if (lab) lab.textContent = '动效 · ' + MOTION_LABEL[mode];
  }

  /* 点一下循环切换 完整 → 轻量 → 跟随系统 → 完整。
   * 显式选择后 URL 覆写作废，并把选择落盘。 */
  function cycleMotion() {
    var i = MOTION_MODES.indexOf(S.motion);
    S.motion = MOTION_MODES[(i + 1) % MOTION_MODES.length];
    urlMotion = null;
    saveLocal();
    resolveMotion();
    toast('动效：' + MOTION_LABEL[S.motion] +
      (S.motion === 'lite' ? '（只保留淡入）' : S.motion === 'system' ? '（随系统设置）' : ''));
  }

  /* 'system' 档下系统设置变化要实时跟随 */
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', resolveMotion);
  else if (motionQuery.addListener) motionQuery.addListener(resolveMotion);

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
      /* 动效档：没存过就保持默认 'full'（不跟随系统） */
      if (MOTION_MODES.indexOf(v.motion) >= 0) S.motion = v.motion;
    } catch (e) { /* 隐私模式 / 数据损坏：静默降级 */ }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LKEY, JSON.stringify({
        liked: S.liked, seen: S.seen, muted: S.muted, motion: S.motion,
      }));
    } catch (e) { /* 配额满：不影响抽卡 */ }
  }

  /* ---------------- 工具 ---------------- */
  var toastTimer;
  /* 离场层的兜底移除定时器（见 render()） */
  var outTimer;
  /* AI 卡翻转动画中点换内容的定时器（见 render()） */
  var aiSwapTimer;
  /* 右侧卡片栈（AI 点评 + 掘金评论）的状态 —— 见文件下半部分的「右侧卡片栈」章节 */
  var aiIdx = 0;          // 当前显示第几张（0 = AI 点评，1.. = 评论）
  var aiFlipUntil = 0;    // 翻牌动画窗口的结束时间戳，窗口内不要动 #ai 的内容
  var aiLateTimer = 0;    // 被动画挡住时的延后重绘定时器
  var cmtCache = {};      // pinId -> { list, hasMore, err }
  var cmtLoading = {};    // pinId -> true（请求在途）
  var cmtTimer = 0;       // 连翻时的防抖定时器
  /* 批量生成进度：非空表示「正有一批点评在跑」，值为 {id,total,start}。
   * null 表示空闲。点评只有「批量」这一条生成路径，见 startBatch()。 */
  var batchCtl = null;
  var batchSeq = 0;
  var batchTicker = null;

  /* ---------------- AI 实时点评配置 ----------------
   * 配置存在 localStorage（只存本机浏览器）。字段与 providers.resolve() 的入参一一对应：
   *   providerId  厂商 id（表在 providers.js）        可空
   *   baseUrl     接口地址                            留空时由 providerId 推出
   *   token       API Key                             留空则由服务端 / 环境变量补（不进浏览器）
   *   model       模型名                              必填
   *   api         协议覆盖 chat|responses|anthropic   留空按厂商+模型自动判定
   *   extra       额外请求参数对象                     留空不传
   * 配了之后翻牌时经同源 /api/roast（serve.mjs 转发，避免 CORS）实时生成点评；
   * 没配就用 data.js 里的手写点评兜底。
   *
   * ⚠️ 老版本只存了 baseUrl/token/model 三要素 —— 那份配置**继续可用**，
   *    协议会按 baseUrl/模型名自动判成 chat（老配置全是 OpenAI 兼容接口）。 */
  var AI_CFG_KEY = 'juejin-boom:ai-cfg';
  /* 掘金登录态 Cookie（一键评论用）：可存浏览器 localStorage，
   * 也可写进服务端 site/.ai-config.json 的 jjCookie 字段（不进浏览器） */
  var JJ_COOKIE_KEY = 'juejin-boom:jj-cookie';
  var aiCfg = loadAiCfg();
  /* 已生成的点评按沸点 id 缓存，来回翻牌不重复打接口（改配置时清空） */
  var roastCache = {};
  /* 失败负缓存：批量里「模型漏答」的牌记 30s，避免下一轮批量立刻重试同一批 */
  var roastFail = {};
  function loadAiCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(AI_CFG_KEY) || 'null');
      /* token 允许为空：空 token 时由服务端 .ai-config.json（或 JB_AI_API_KEY）补上。
       * providerId 本身能推出地址，所以「只选了个厂商」也算配置好了。 */
      return (c && (c.baseUrl || c.providerId) && c.model) ? c : null;
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

  /* 「原文」外链箭头。stroke 走 currentColor，跟着 .go 的 hover 变蓝。 */
  var ICON_GO = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
    '<path d="M2.7 7.3L7.3 2.7M3.9 2.7h3.4v3.4" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* 右侧卡片栈用的小图标：评论气泡（徽标）/ 上一条 / 下一条。
   * 气泡走 currentColor —— 评论徽标是浅底深字，白色 path 会看不见。 */
  var ICON_CHAT = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
    '<path d="M1.3 4.3c0-1.8 1.7-3.3 3.7-3.3s3.7 1.5 3.7 3.3S7 7.6 5 7.6c-.4 0-.8 0-1.2-.1' +
    'l-2.1 1.2.4-1.6C1.6 6.5 1.3 5.5 1.3 4.3z" fill="currentColor"/></svg>';

  var ICON_UP = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
    '<path d="M2.2 6.2L5 3.4l2.8 2.8" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var ICON_DOWN = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
    '<path d="M2.2 3.8L5 6.6l2.8-2.8" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

  /* 只放行 http(s)。data.js 与 /api/pins 的 url 都来自外部，
   * 万一被写成 javascript:/data: 之类，直接当没有链接处理。 */
  function safeUrl(u) {
    u = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(u) ? u : '';
  }

  /* ---------------- 主卡 ----------------
   * 整张卡就是链接：点它进掘金这条沸点的原文页。
   * 用真 <a> 而不是 JS window.open —— 悬停时状态栏给地址预览、中键/⌘点击
   * 新开标签、右键「复制链接地址」、Tab 可聚焦，这些原生行为自己写补不齐。
   * 只有一件事原生不管：拖选文字后松手会顺带触发 click，把「想选中一段字」
   * 变成「跳走了」——那一条在 bind() 里用选区判断拦掉。
   */
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
    var url = safeUrl(p.url) || (p.id ? 'https://juejin.cn/pin/' + p.id : '');
    var cls = 'main' + (anim ? ' anim-in' : '') + (on ? ' liked' : '');
    var open = url
      ? '<a class="' + cls + '" href="' + esc(url) + '" target="_blank"' +
        ' rel="noopener noreferrer" draggable="false" title="在掘金打开这条沸点">'
      : '<article class="' + cls + '">';
    var close = url ? '</a>' : '</article>';
    return '' +
      open +
        '<div class="chead">' +
          '<span class="tag">' + ICON_BOLT_BLUE + '沸点</span>' +
          '<span class="time">' + esc(fmtTime(p.ctime)) + '</span>' +
          (url ? '<span class="go" aria-hidden="true">原文' + ICON_GO + '</span>' : '') +
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
      close;
  }

  /* ================================================================
   * 右侧卡片栈（AI 点评 + 掘金评论）
   * ----------------------------------------------------------------
   * 第 1 张永远是这条沸点的 AI 点评，后面接掘金评论区的一级评论，
   * 每条评论独占一张卡，↑↓（或键盘 ↑↓）上下翻着看。
   *
   * 实现要点：钉住的头 + 裁切窗口 + 钉住的底，窗口里是一条整体上下平移的轨道。
   * 切换只改轨道的 transform —— 不重建 DOM，所以连点不会错位、
   * 评论正文的滚动位置也不会被重置。页码/按钮在钉住的那一圈里，动画期间照样能点。
   *
   * 外壳 <aside class="ai"> 写在 index.html 里（在卡片容器之外、单独定位），
   * 这里只返回卡内内容。注意别再套一层 .ai——套了会嵌套两层 absolute 直接被推出卡外。
   *
   * 评论是「一条沸点一次」的读请求，只在当前这张牌上按需拉，且带 450ms 防抖
   * + 10 分钟服务端缓存。绝不整副牌预取，见 ensureComments()。
   * ================================================================ */

  /* 这条沸点右侧一共几张卡：AI 点评 +（拉取中 / 零条 / 失败 / 每条评论 / 还有更多） */
  function aiList(p) {
    var out = [{ kind: 'ai', pin: p }];
    var c = cmtCache[p.id];
    if (!c) { out.push({ kind: 'note', mode: 'loading' }); return out; }
    if (c.err) { out.push({ kind: 'note', mode: 'error' }); return out; }
    if (!c.list.length) { out.push({ kind: 'note', mode: 'empty' }); return out; }
    for (var i = 0; i < c.list.length; i++) out.push({ kind: 'cmt', c: c.list[i] });
    if (c.hasMore) out.push({ kind: 'note', mode: 'more' });
    return out;
  }

  /* AI 点评的正文（三种状态：已生成 / 批量进行中 / 内置占位） */
  /* 批量进度圆环（SVG）：r=20 → 周长 2πr≈125.66，
   * stroke-dashoffset = 周长 ×(1-进度)，起点经 CSS rotate(-90deg) 钉在圆环顶部 */
  function ringSVG(done, total) {
    var C = 125.66;
    var pct = total > 0 ? Math.min(1, done / total) : 0;
    var off = (C * (1 - pct)).toFixed(1);
    return '<svg class="ring" viewBox="0 0 48 48" aria-hidden="true">' +
      '<circle class="ring-bg" cx="24" cy="24" r="20"/>' +
      '<circle class="ring-fg" cx="24" cy="24" r="20"' +
      ' stroke-dasharray="' + C + '" stroke-dashoffset="' + off + '"/>' +
      '</svg>';
  }

  function roastBodyHTML(p) {
    var r = roastFor(p);
    if (r.loading) {
      if (batchCtl) {
        /* 批量进度圆环：环=整体进度，环心=已评条数；
         * 限流/退避等待时环变琥珀色、提示剩余等待秒数 —— 让「卡住」变成可见的等待 */
        var waitS = batchCtl.waitingUntil
          ? Math.ceil((batchCtl.waitingUntil - Date.now()) / 1000) : 0;
        return '<span class="ai-progress' + (waitS > 0 ? ' waiting' : '') + '">' +
          '<span class="ringwrap">' + ringSVG(batchCtl.done, batchCtl.total) +
          '<b class="num">' + batchCtl.done + '<i>/' + batchCtl.total + '</i></b></span>' +
          '<span class="hint">' + (waitS > 0 ? '限流等待 ' + waitS + 's…' : 'AI 正在逐批点评…') + '</span>' +
          '</span>';
      }
      return '<span class="ai-loading"><i class="dot"></i><i class="dot"></i><i class="dot"></i>AI 正在看这条沸点…</span>';
    }
    /* 明确的失败态：这批评失败了（30s 冷却后可洗牌重试），区别于「暂无点评」 */
    if (r.failed) {
      return '<span class="ai-roast-fail"><i class="mark">!</i>这批 AI 点评失败了 · 点「洗牌」重试</span>';
    }
    return '<span' + (r.live ? ' class="roast-live"' : '') + '>' + esc(r.text) + '</span>';
  }

  function cmtAvatar(c) {
    return c.avatar
      ? '<img src="' + esc(c.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : ICON_USER;
  }

  /* 每张卡绝对定位占满窗口，靠自身 translateY(k*100%) 排到第 k 格；
   * 轨道整体上移 k*100% 时第 k 张正好落进窗口。 */
  function aiSlideHTML(s, k) {
    var off = ' style="transform:translateY(' + (k * 100) + '%)"';
    if (s.kind === 'ai') {
      return '<div class="ai-slide" data-k="ai"' + off + '>' +
        '<div class="roast">' + roastBodyHTML(s.pin) + '</div>' +
        '</div>';
    }
    if (s.kind === 'cmt') {
      var c = s.c;
      return '<div class="ai-slide cmt"' + off + '>' +
        '<div class="cmt-head">' +
          '<span class="cmt-av">' + cmtAvatar(c) + '</span>' +
          '<span class="cmt-name">' + esc(c.user) + '</span>' +
          (c.author ? '<span class="cmt-author">作者</span>' : '') +
        '</div>' +
        '<div class="cmt-body">' + (c.content ? esc(c.content) : '（图片评论）') + '</div>' +
        '<div class="cmt-meta">' + c.digg + ' 赞 · ' + c.reply + ' 回复 · ' +
          esc(fmtTime(c.ctime)) + '</div>' +
        '</div>';
    }
    var msg = s.mode === 'error' ? '评论没拉到'
      : s.mode === 'empty' ? '这条沸点还没人评论'
      : s.mode === 'more' ? '还有更多评论'
      : '正在拉评论…';
    var sub = s.mode === 'error' ? '多半是网络或接口抖了一下，点下面重试'
      : s.mode === 'empty' ? '你是第一个说话的人'
      : s.mode === 'more' ? '去原文翻完整评论区'
      : '掘金评论区';
    return '<div class="ai-slide note"' + off + '>' +
      '<div class="note-box">' +
        (s.mode === 'loading'
          ? '<span class="ai-loading"><i class="dot"></i><i class="dot"></i><i class="dot"></i>' + msg + '</span>'
          : '<b>' + msg + '</b><span>' + sub + '</span>') +
      '</div>' +
      '</div>';
  }

  /* 钉住不动的那一圈：徽标 / 页码 / 上下按钮 / 动作按钮 / 说明。
   * 只有这里随当前卡片更新，轨道本身不重建。 */
  function aiSyncChrome(p, list) {
    var s = list[aiIdx] || list[0];
    var isAI = s.kind === 'ai';
    var badge = $('#aiBadge'), num = $('#aiNum'), up = $('#aiUp'), dn = $('#aiDn');
    var cp = $('#btnCopy'), note = $('#aiNote');
    if (badge) {
      badge.className = 'badge' + (isAI ? '' : ' people');
      badge.innerHTML = isAI
        ? ICON_BOLT + (aiCfg ? 'AI 点评' : '内置点评')
        : ICON_CHAT + '评论';
    }
    if (num) num.textContent = (aiIdx + 1) + ' / ' + list.length;
    if (up) up.disabled = aiIdx <= 0;
    if (dn) dn.disabled = aiIdx >= list.length - 1;
    var n = 0;
    for (var i = 1; i < list.length; i++) if (list[i].kind === 'cmt') n++;
    if (cp) {
      /* 每张卡都恰好有一个动作 —— 底栏高度恒定，切换时不会跳。
       * 一键评论下线期间（COMMENT_POST_ENABLED=false）AI 卡一律「复制点评」；
       * 恢复后：扩展里只有确认掘金已登录才亮「一键评论」，未登录/探测中给
       * 「复制点评」；站点模式探不到登录态，维持一键评论（点击时没配 Cookie
       * 再退化成复制）。 */
      if (isAI) {
        cp.innerHTML = ICON_COPY + (COMMENT_POST_ENABLED && (jjLogin === 1 || !isExtHost())
          ? '一键评论' : '复制点评');
        cp.disabled = false;
      }
      else if (s.kind === 'cmt') { cp.innerHTML = ICON_COPY + '复制这条'; cp.disabled = false; }
      else if (s.mode === 'error') { cp.textContent = '重试'; cp.disabled = false; }
      else if (s.mode === 'empty') { cp.textContent = '去原文评论'; cp.disabled = false; }
      else if (s.mode === 'more') { cp.textContent = '去原文看全部'; cp.disabled = false; }
      else { cp.textContent = '正在拉评论…'; cp.disabled = true; }
    }
    if (note) {
      note.textContent = isAI ? '毒的是现象，不是你。'
        : s.mode === 'loading' ? '掘金评论区 · 拉取中'
        : n ? '掘金评论区 · 共 ' + n + ' 条'
        : '掘金评论区';
    }
  }

  /* 只动轨道。animate=false 用于「重建 DOM 之后把位置摆正」——
   * 不先掐掉过渡的话，插入后第一次设 transform 会演一段没人要的动画。 */
  function aiApply(i, animate) {
    var track = $('#aiTrack');
    if (!track) return;
    var y = 'translateY(-' + (i * 100) + '%)';
    if (animate) { track.style.transform = y; return; }
    track.style.transition = 'none';
    track.style.transform = y;
    void track.offsetWidth;   // 让「无过渡 + 新位置」这一帧落地
    track.style.transition = '';
  }

  function aiSet(i, animate) {
    var p = PINS[S.order[S.pos]];
    if (!p) return;
    var list = aiList(p);
    aiIdx = Math.max(0, Math.min(list.length - 1, i));
    aiApply(aiIdx, animate === true);
    aiSyncChrome(p, list);
    /* 轻量动效档没有位移，补一次 130ms 淡入，别让切换变成无感知的瞬变 */
    if (animate === true && document.documentElement.classList.contains('motion-lite')) {
      var v = $('#aiView');
      if (v) { v.classList.remove('fade'); void v.offsetWidth; v.classList.add('fade'); }
    }
  }

  function aiStep(d) { aiSet(aiIdx + d, true); }

  function aiHTML() {
    var p = PINS[S.order[S.pos]];
    var list = aiList(p);
    aiIdx = Math.max(0, Math.min(list.length - 1, aiIdx));
    var slides = '';
    for (var i = 0; i < list.length; i++) slides += aiSlideHTML(list[i], i);
    return '' +
      '<div class="ai-top">' +
        '<span class="badge" id="aiBadge"></span>' +
        '<div class="pager">' +
          '<button class="pbtn" id="aiUp" type="button" aria-label="上一条">' + ICON_UP + '</button>' +
          '<span class="pnum" id="aiNum"></span>' +
          '<button class="pbtn" id="aiDn" type="button" aria-label="下一条">' + ICON_DOWN + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="ai-view" id="aiView">' +
        '<div class="ai-track" id="aiTrack" style="transform:translateY(-' + (aiIdx * 100) + '%)">' +
          slides +
        '</div>' +
      '</div>' +
      '<div class="ai-foot">' +
        '<button class="copy" id="btnCopy" type="button"></button>' +
        '<div class="note" id="aiNote"></div>' +
      '</div>';
  }

  /* 无条件重绘整块面板。调用方自己保证时机（翻牌动画中点那一下就走这里）。 */
  function paintAI() {
    var ai = $('#ai');
    var p = PINS[S.order[S.pos]];
    if (!ai || !p) return;
    ai.innerHTML = aiHTML();
    bindAI();
    aiSet(aiIdx, false);
    ensureComments(p);
    ensureLoginCheck();   // TTL 内的复探点：登录态变了就地换按钮
  }

  /* 带时机守卫的入口：翻牌动画还在播（rotateY 立边窗口）时不换内容，
   * 延后到动画结束再画 —— 否则会看到「卡片转到一半内容变了」。 */
  function renderAI() {
    if (Date.now() < aiFlipUntil) {
      clearTimeout(aiLateTimer);
      aiLateTimer = setTimeout(renderAI, Math.max(60, aiFlipUntil - Date.now() + 40));
      return;
    }
    paintAI();
  }

  /* ---------------- 评论拉取 ----------------
   * 一条沸点一次读请求，所以必须防抖：连翻十张不该变成十次上游调用。
   * 停手 600ms 后才拉当前这张，且已经翻走就直接放弃这次。
   * 600ms 是实测过的平衡点：连点（间隔 <600ms）一次都不会发，
   * 而单次翻牌停下后约 1s 内评论就位，不至于让人盯着「正在拉评论…」等。
   * 再叠加两层缓存（本地按 pinId、服务端 10 分钟），同一张牌一辈子只打一次。 */
  function ensureComments(p) {
    if (!p || !p.id || cmtLoading[p.id]) return;
    var hit = cmtCache[p.id];
    if (hit && !hit.err) return;   // 已有结果（哪怕是「零条评论」）就不再打
    clearTimeout(cmtTimer);
    cmtTimer = setTimeout(function () {
      var cur = PINS[S.order[S.pos]];
      if (!cur || cur.id !== p.id) return;   // 已经翻走了，不浪费这次请求
      fetchComments(cur);
    }, 600);
  }

  function fetchComments(p) {
    if (cmtLoading[p.id]) return;
    cmtLoading[p.id] = true;
    fetch('api/comments?pinId=' + encodeURIComponent(p.id))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        cmtCache[p.id] = {
          list: (d && d.comments) || [],
          hasMore: !!(d && d.hasMore),
          err: (d && d.error) || '',
        };
      })
      .catch(function (e) {
        /* 失败不静默：留一条 error 卡，底栏给「重试」 */
        cmtCache[p.id] = { list: [], hasMore: false, err: String((e && e.message) || e) };
      })
      .then(function () {
        cmtLoading[p.id] = false;
        var cur = PINS[S.order[S.pos]];
        if (cur && cur.id === p.id) renderAI();   // 只刷新当前这一张
      });
  }

  /* 底栏那一个动作按钮干啥，按当前这张卡决定 */
  function onAiAction() {
    var p = PINS[S.order[S.pos]];
    if (!p) return;
    var s = aiList(p)[aiIdx];
    if (!s) return;
    if (s.kind === 'ai') { postRoastComment(p); return; }
    if (s.kind === 'cmt') {
      copyText(s.c.content).then(function () { toast('已复制这条评论'); });
      return;
    }
    if (s.mode === 'error') {
      delete cmtCache[p.id];          // 清掉负缓存，重试一次
      toast('重新拉取评论…');
      fetchComments(p);
      return;
    }
    if (p.url) window.open(p.url, '_blank', 'noopener');
  }

  /* ---------------- 掘金登录态探测（仅扩展模式） ----------------
   * 「一键评论」是把请求转到掘金页面上下文、靠登录 Cookie 代发的，
   * 页面没登录时代发必被掘金打回。所以扩展里先探测、再决定按钮亮哪个：
   *   已登录（jjLogin=1）           → 「一键评论」
   *   未登录（-1）/ 探不到（0）     → 「复制点评」，点了就复制，不代发
   * 站点模式没有页面上下文可探，维持旧行为（点击时没配 Cookie 再退化成复制）。
   * 探测本身很轻：掘金页面上下文里一次 GET，结果按 TTL 复用，不逐次打。
   *
   * ⚠️ 一键评论暂时下线（COMMENT_POST_ENABLED=false，v0.2.15 起）：掘金网关
   * 对代发请求的 CSRF 拦截还没绕稳（隔离世界被拦、主世界注入桥可通但待观察），
   * 下线期间按钮一律「复制点评」，点击只复制；恢复时把这个开关改回 true 即可，
   * 登录探测与代发链路原样保留。 */
  var COMMENT_POST_ENABLED = false;
  var jjLogin = 0;        // 0 = 还没探到, 1 = 已登录, -1 = 未登录
  var jjLoginAt = 0;      // 上次探测完成的时间戳
  var jjLoginReq = null;  // 在途探测（防并发重复打）
  var JJ_LOGIN_OK_TTL = 5 * 60 * 1000;   // 探到明确结果后的复探间隔
  var JJ_LOGIN_MISS_TTL = 30 * 1000;     // 探测失败/未知时的重试退避

  function isExtHost() { return !!window.__JB_HOST__; }

  function ensureLoginCheck() {
    if (!COMMENT_POST_ENABLED || !isExtHost()) return;
    var ttl = jjLogin === 1 ? JJ_LOGIN_OK_TTL : JJ_LOGIN_MISS_TTL;
    if (jjLoginReq || (jjLoginAt && Date.now() - jjLoginAt < ttl)) return;
    jjLoginReq = fetch('/api/login-check')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        jjLogin = (d && d.loggedIn) ? 1 : (d && d.unknown ? 0 : -1);
      })
      .catch(function () { jjLogin = 0; })
      .then(function () {
        jjLoginAt = Date.now();
        jjLoginReq = null;
        /* 结果到达时 AI 面板多半已经画出来了：只刷底栏按钮，不重建面板 */
        var p = PINS[S.order[S.pos]];
        if (p && $('#ai')) aiSyncChrome(p, aiList(p));
      });
  }

  /* 「一键评论」：把当前点评直接发到这条沸点的评论区（经 /api/comment 转发）。
   * ⚠️ COMMENT_POST_ENABLED=false 时走不到发送分支，一律复制（按钮也是复制态）。
   * 扩展模式：只有探到已登录才会从「一键评论」进来；万一发出去被打回
   * 「登录态失效」（探测之后退出了登录），就地记为未登录并退化为复制。
   * 站点模式：沿用 Cookie 配置，未配置时自动退化为「复制文案」。
   * 按钮是常驻元素（只有 paintAI() 重建面板时才换），所以这里不用重新绑定。 */
  function postRoastComment(p) {
    var btn = $('#btnCopy');
    if (!btn) return;
    /* 优先发实时生成的点评，其次手写点评 */
    var text = roastCache[p.id] || p.roast;
    if (!text) { toast(aiCfg ? '点评还在生成中…' : '这条还没配点评'); return; }
    /* 下线期间 / 扩展里没探到登录态：不发，直接复制（按钮此时就是「复制点评」） */
    if (!COMMENT_POST_ENABLED || (isExtHost() && jjLogin !== 1)) {
      copyText(text).then(function () {
        toast(COMMENT_POST_ENABLED
          ? (jjLogin === -1 ? '掘金未登录，已复制点评，登录后刷新页面可一键评论' : '已复制点评')
          : '已复制点评，去评论区粘贴即可');
      });
      return;
    }
    btn.disabled = true;
    btn.textContent = '评论中…';
    var restore = function () { aiSet(aiIdx, false); };
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
          return;                      // 停在成功态，下次切换卡片时自动复位
        }
        var msg = (res.d && res.d.error) || '评论失败';
        /* 没配 Cookie（站点）/ 登录态失效（扩展）：不报错，退化为复制文案。
         * 扩展里被打回登录失效，说明探测之后用户退出了登录 —— 就地记为
         * 未登录，restore() 重刷底栏后按钮自动变回「复制点评」。 */
        var loginDead = isExtHost() && /登录/.test(msg);
        if (/未配置掘金 Cookie/.test(msg) || loginDead) {
          if (loginDead) { jjLogin = -1; jjLoginAt = Date.now(); }
          restore();
          copyText(text).then(function () {
            toast(loginDead ? '掘金登录态已失效，已复制点评'
                            : '未配置掘金 Cookie，已复制文案，去评论区粘贴即可');
          });
        } else {
          restore();
          toast('评论失败：' + msg);
        }
      })
      .catch(function (e) {
        restore();
        toast('评论失败：' + ((e && e.message) || e));
      });
  }

  /* 当前这条该显示什么点评。配了 AI 接口时三层判定：
   *   ① 有缓存           → 直接显示（批量已经评过了）
   *   ② 有批量在跑       → 进度态转圈，等这一批一次性补齐
   *   ③ 没有批量在跑     → 回退到内置点评/占位文案，不转圈
   * 注意：任何情况下都不在这里单独打接口。点评只由 startBatch() 一次性
   * 批量生成——逐条补点评会按牌数产生 N 次请求，是限流的主要来源。 */
  function roastFor(p) {
    if (aiCfg) {
      if (roastCache[p.id] && String(roastCache[p.id]).trim()) return { text: roastCache[p.id], live: true };
      if (batchCtl) return { loading: true };
      /* 30s 内失败过 → 明确的失败态，不再和「暂无点评」混为一谈 */
      if (roastFail[p.id] && Date.now() - roastFail[p.id] < 30000) return { failed: true };
      return { text: p.roast || '（这条暂无 AI 点评，可点「洗牌」重试）', live: false };
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

  /* 单条「实时点评」已取消。
   * ----------------------------------------------------------------
   * 原实现：翻牌落定 700ms 后为当前这一张单独打一次 /api/roast。
   * 与「批量点评」并存之后，点评就有了两条来源，于是：
   *   · 批量没覆盖到的牌（批量进行中洗牌、批量失败、模型漏答）会走单条，
   *     用户一路翻下去就是 N 次单条请求——正是限流的主要触发点；
   *   · 单条与批量还会同时打同一批 id，缓存互相踩。
   * 现在收紧成一句话：【点评只有一个来源 = startBatch() 的一次性批量请求】。
   * 没评到的牌显示内置点评/占位文案，点「洗牌」即可重新批量补齐。 */

  /* ---------------- 批量点评（唯一的点评生成路径） ----------------
   * 一次动作把当前所有还没点评过的牌生成完（启动 / 洗牌 / 换配置 /
   * 换风格后自动触发）。自适应单飞流水线：
   *  · 任意时刻最多 1 个在途请求 —— 并发限流从根上不可能触发；
   *  · 批次大小自适应（AIMD）：首批 3 条快速首显，连续成功逐次加大
   *    （3→5→7→10），遇到限流/超时减半 —— 快时少请求、慢时不超时；
   *  · 限流（429）按服务端透传的 retryAfter 精确等待（指数退避兜底 +
   *    随机抖动），等待期间进度条显示「限流等待 Xs」；
   *  · 超时把该组拆半重试（后半塞回队首），拆到单条仍超时才放弃；
   *  · 同一批共用一个 session id，服务端把这些请求串成一场多轮对话，
   *    模型每轮都接着自己上一轮的格式继续，输出更稳、吃到上下文缓存；
   *  · 翻到未点评的牌 → 该牌插到队列队首（当前牌优先），见 prioritizePin。 */

  /* 逐条兜底已取消。
   * ----------------------------------------------------------------
   * 原实现：批量失败后 runSerial() 把队列逐条重打一遍 /api/roast
   * （间隔 300ms、限流退避 2.8s）。请求数等于牌数，正好踩在服务商的
   * 「短时间请求数」限流上。现在失败只记 30s 负缓存，随批自动跳过。 */

  /* 就地刷新「AI 点评」那一张的正文（批量进度变化 / 点评已生成时）。
   * 只动第 1 张的 .roast，【不重建整块面板】—— 重建会把用户正在读的
   * 评论正文滚动位置一起重置，而批量每秒 tick 一次，那样就全乱了。 */
  function refreshAiCard() {
    var p = PINS[S.order[S.pos]];
    var ai = $('#ai');
    if (!p || !ai || Date.now() < aiFlipUntil) return;
    var box = ai.querySelector('.ai-slide[data-k="ai"] .roast');
    if (!box) return;                       // 面板还没建起来
    box.innerHTML = roastBodyHTML(p);
  }

  function stopBatch() {
    batchCtl = null;
    if (batchTicker) { clearInterval(batchTicker); batchTicker = null; }
  }

  /* 翻到未点评的牌时把它插到批量队列队首 —— 用户翻牌的动作本身就是
   * 优先级信号。只在批量进行中生效；批间（batchCtl 为空）无需处理，
   * 下一批自然会带上它。 */
  function prioritizePin(pinId) {
    if (!batchCtl || !batchCtl.queue || !pinId) return;
    var q = batchCtl.queue;
    for (var i = 0; i < q.length; i++) {
      if (q[i] && q[i].id === pinId) {
        if (i > 0) q.unshift(q.splice(i, 1)[0]);
        return;
      }
    }
  }

  /* 把整副牌里「还没点评」的牌按自适应批次排队、单飞逐组发。
   * ----------------------------------------------------------------
   * 这是全站唯一的点评生成路径：不逐条、不并发。
   * force=true —— 抢占：洗牌 / 换配置 / 换风格时必须传。
   * force=false —— 幂等：同一批的重复触发直接忽略。 */
  function startBatch(force) {
    if (!aiCfg) return;
    if (batchCtl) {
      if (!force) return;
      stopBatch();
    }
    var queue = [];
    for (var i = 0; i < S.order.length; i++) {
      var p = PINS[S.order[i]];
      if (!p) continue;
      /* 已有有效点评的跳过（空字符串不算有效） */
      if (roastCache[p.id] && String(roastCache[p.id]).trim()) continue;
      /* 30 秒内失败过的也跳过，避免频繁重试打爆限流 */
      if (roastFail[p.id] && Date.now() - roastFail[p.id] < 30000) continue;
      queue.push(p);
    }
    if (!queue.length) {
      /* 全是无效空缓存就清掉重跑；否则如实告诉用户卡在哪 */
      var hasEmptyCache = false;
      for (var i = 0; i < S.order.length; i++) {
        var p = PINS[S.order[i]];
        if (p && roastCache[p.id] && !String(roastCache[p.id]).trim()) {
          delete roastCache[p.id];
          hasEmptyCache = true;
        }
      }
      if (hasEmptyCache) {
        toast('清空无效缓存，重新获取 AI 点评…');
        startBatch(true);
        return;
      }
      var cooling = false;
      for (var i = 0; i < S.order.length; i++) {
        var p = PINS[S.order[i]];
        if (p && !roastCache[p.id] && roastFail[p.id] && Date.now() - roastFail[p.id] < 30000) { cooling = true; break; }
      }
      toast(cooling ? 'AI 点评刚失败过，请等 30 秒后再点「洗牌」重试' : '所有沸点已有 AI 点评');
      return;
    }
    var myId = ++batchSeq;
    /* 本批的会话 id：服务端把同一批的多组请求串成一场多轮对话
     * （换模型/换风格时服务端会按配置另开新对话，前端无需感知） */
    var session = 'b' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    batchCtl = { id: myId, total: queue.length, done: 0, start: Date.now(), queue: queue, waitingUntil: 0 };
    refreshAiCard();
    /* 每秒刷一次进度（n/total + 等待/限流状态）让等待可感知 */
    batchTicker = setInterval(function () {
      if (batchCtl && batchCtl.id === myId) refreshAiCard();
    }, 1000);

    var okCount = 0;
    var failCount = 0;
    /* AIMD 批次：首批小（快速首显），成功 +2（上限 10），限流/超时减半 */
    var MAXB = 10, MINB = 2;
    var batchN = 3;
    /* 各类重试上限：限流等待可以久（厂商说了算），其他错误快速放弃 */
    var MAX_RATE_ATTEMPTS = 6;
    var MAX_ERR_ATTEMPTS = 2;

    function grow() { batchN = Math.min(MAXB, batchN + 2); }
    function shrink() { batchN = Math.max(MINB, Math.ceil(batchN / 2)); }
    function markFail(p) { roastFail[p.id] = Date.now(); }

    function fill(res, group) {
      var d = res.d || {};
      var got = (res.ok && d.roasts) || {};
      for (var i = 0; i < group.length; i++) {
        var p = group[i];
        if (got[p.id]) { roastCache[p.id] = got[p.id]; delete roastFail[p.id]; okCount++; }
        else { markFail(p); failCount++; } // 模型漏答记负缓存，30s 后可重试
      }
    }

    function finish(msg) {
      stopBatch();
      refreshAiCard();
      if (msg) toast(msg);
      else if (okCount) toast('AI 批量点评完成 · ' + okCount + ' 条' +
        (failCount ? ('（' + failCount + ' 条未成功，稍后洗牌可补）') : ''));
    }

    /* 队列单飞主循环：发一组 → 分类处理结果 → 成功则加大批次继续。
     * group 为空表示从队列取新一批；重试走同一 group 原样再发。 */
    (function next(group, attempt) {
      if (!batchCtl || batchCtl.id !== myId) return; // 已被抢占/清配置
      if (!group) group = queue.splice(0, batchN);
      if (!group.length) { finish(); return; }

      fetch('/api/roast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          /* providerId / api / extra 一并交给服务端：协议由 providers.js 判定，
           * 前端只负责如实上报「用户选了什么」；session 让服务端接续同一对话 */
          providerId: aiCfg.providerId || '', api: aiCfg.api || '',
          baseUrl: aiCfg.baseUrl, token: aiCfg.token, model: aiCfg.model,
          extra: aiCfg.extra || null,
          prompt: currentStyle().prompt,
          session: session,
          items: group.map(function (p) { return { id: p.id, content: p.content, topic: p.topic }; }),
        }),
      })
        .then(parseRoastRes)
        .then(function (res) {
          if (!batchCtl || batchCtl.id !== myId) return;
          var d = res.d || {};
          if (res.ok && d.roasts) {
            fill(res, group);
            batchCtl.done += group.length;
            grow();                       // AIMD：成功就逐步加大批次
            refreshAiCard();
            render(false, 0);             // 先到先上卡
            next();
            return;
          }

          var errText = d.error || 'AI 接口异常';

          /* ---- 限流（429）：精确等待后重试同一组，批次减半 ---- */
          if (d.rateLimited || d.retryAfter) {
            if (attempt >= MAX_RATE_ATTEMPTS) {
              for (var i = 0; i < group.length; i++) markFail(group[i]);
              batchCtl.done += group.length;
              finish('AI 点评被限流，已完成 ' + okCount + '/' + batchCtl.total +
                ' 条 · 稍后点「洗牌」继续');
              return;
            }
            shrink();
            /* 优先用厂商的 Retry-After；没有就指数退避 + 抖动 */
            var waitMs = d.retryAfter > 0
              ? d.retryAfter * 1000
              : Math.min(30000, 2000 * Math.pow(2, attempt)) + Math.round(Math.random() * 500);
            batchCtl.waitingUntil = Date.now() + waitMs;
            setTimeout(function () {
              if (!batchCtl || batchCtl.id !== myId) return;
              batchCtl.waitingUntil = 0;
              next(group, attempt + 1);
            }, waitMs);
            return;
          }

          /* ---- 超时：拆半重试（前半立即重发，后半塞回队首），不等待 ---- */
          if (d.timedOut && group.length > 1) {
            shrink();
            var half = Math.ceil(group.length / 2);
            var head = group.slice(0, half);
            queue.unshift.apply(queue, group.slice(half));
            next(head, 0);      // 重试计数归零：拆半本身就是一次新机会
            return;
          }

          /* ---- 其他错误：短退避重试，耗尽放弃该组、继续队列 ---- */
          if (attempt < MAX_ERR_ATTEMPTS) {
            var waitMs2 = 1000 + attempt * 1500;
            batchCtl.waitingUntil = Date.now() + waitMs2;
            setTimeout(function () {
              if (!batchCtl || batchCtl.id !== myId) return;
              batchCtl.waitingUntil = 0;
              next(group, attempt + 1);
            }, waitMs2);
            return;
          }
          for (var i = 0; i < group.length; i++) markFail(group[i]);
          batchCtl.done += group.length;
          next(); // 放弃该组但不拖垮队列：剩余的牌继续评
        })
        .catch(function (e) {
          if (!batchCtl || batchCtl.id !== myId) return;
          /* 网络层异常（fetch 抛错）：与「其他错误」同策略 */
          if (attempt < MAX_ERR_ATTEMPTS) {
            var waitMs2 = 1000 + attempt * 1500;
            batchCtl.waitingUntil = Date.now() + waitMs2;
            setTimeout(function () {
              if (!batchCtl || batchCtl.id !== myId) return;
              batchCtl.waitingUntil = 0;
              next(group, attempt + 1);
            }, waitMs2);
            return;
          }
          group.forEach(markFail);
          batchCtl.done += group.length;
          finish('AI 点评未生成（' + msg + '）· 点「洗牌」可重试');
        });
    })(null, 0);
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
      clearTimeout(aiLateTimer);
      /* 换牌了：右侧卡片栈回到第 1 张（AI 点评） */
      aiIdx = 0;
      if (anim) {
        void ai.offsetWidth;
        ai.classList.add('anim-in');
        /* 翻转动画在 50%（60ms 延迟 + 480ms×50% ≈ 300ms）处处于立边不可见，
         * 此刻换掉卡内内容，人眼看到的是「翻过去旧点评、翻过来新点评」。
         * lite 档（手选轻量，或 system 档命中 reduce）下动画被降级成
         * 130ms 淡入，没有「立边不可见」的窗口，必须立刻换内容。
         *
         * aiFlipUntil 是给别的调用方（评论到了要重绘）用的时机闸：
         * 动画没播完之前不许动 #ai，只有下面这个中点回调例外。 */
        var reduced = document.documentElement.classList.contains('motion-lite');
        var delay = reduced ? 0 : 300;
        aiFlipUntil = Date.now() + delay + 240;
        aiSwapTimer = setTimeout(paintAI, delay);
      } else {
        aiFlipUntil = 0;
        paintAI();
      }
    }

    S.seen[p.id] = true;
    saveLocal();
    updateHud();
    syncDock(p, idx);
    /* 这里不再为当前这一张单独发点评请求——点评统一由 startBatch()
     * 一次性批量生成。该牌若已有缓存，上面的 aiCard()/roastFor() 已经
     * 渲染出来了；没有则显示内置点评或占位，等下一次批量补齐。 */
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

  /* 右侧卡片栈的绑定。
   * 上下按钮与底栏按钮都是「钉住」的常驻元素（只有 paintAI() 重建面板时才换），
   * 但面板每次重建都会换掉 DOM，所以仍然要在 paintAI() 之后重新绑一次。
   * 动作本身按「当前这张卡」分派 —— 见 onAiAction()。 */
  function bindAI() {
    var up = $('#aiUp'), dn = $('#aiDn'), cp = $('#btnCopy');
    if (up) up.onclick = function () { aiStep(-1); };
    if (dn) dn.onclick = function () { aiStep(1); };
    if (cp) cp.onclick = onAiAction;
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
    /* 当前牌优先：翻到未点评的牌就把它插到批量队列队首，
     * 下一组请求立刻带上它 —— 用户翻牌的动作本身就是优先级信号 */
    var cur = PINS[S.order[S.pos]];
    if (cur && !(roastCache[cur.id] && String(roastCache[cur.id]).trim())) {
      prioritizePin(cur.id);
    }
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
        startBatch(true); // 新牌堆必须重新批量点评（抢占：不被旧批量挡住）
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
    /* 动效档开关（完整 / 轻量 / 跟随系统） */
    var mo = $('#btnMotion');
    if (mo) mo.onclick = cycleMotion;

    /* ---- AI 点评接口配置弹窗 ----
     * 界面只是 providers.js 的一层皮：厂商清单、协议判定、模型规则全部来自
     * window.JBProviders。**不要在这里另写一份厂商表** ——
     * 扩展的 host.html 加载的是同一份 providers.js，写两份迟早对不上。 */
    var cfgMask = $('#aiCfgMask');
    var JB = window.JBProviders || null;

    function provList() { return JB ? JB.listProviders() : []; }
    function provById(id) { return JB ? JB.findProvider(id) : null; }

    /* 老配置没存 providerId：按 baseUrl 反查是哪一家，查不到就是「自定义」 */
    function matchProviderByBase(baseUrl) {
      var b = String(baseUrl || '').replace(/\/+$/, '').toLowerCase();
      if (!b) return 'custom';
      var list = provList();
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].baseUrl || '').replace(/\/+$/, '').toLowerCase() === b) return list[i].id;
      }
      return 'custom';
    }

    function fillProviderOptions(curId) {
      var sel = $('#aiCfgProvider');
      if (!sel) return;
      var list = provList();
      if (!list.length) { sel.innerHTML = '<option value="custom">自定义（自填地址）</option>'; return; }
      sel.innerHTML = list.map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
      }).join('');
      sel.value = curId || 'custom';
      if (!sel.value) sel.value = 'custom';
    }

    function fillModelList(providerId) {
      var dl = $('#aiCfgModelList');
      if (!dl) return;
      var p = provById(providerId);
      var ms = (p && p.models) || [];
      dl.innerHTML = ms.map(function (m) { return '<option value="' + esc(m) + '"></option>'; }).join('');
    }

    /* 表单 → 配置对象（形状与 providers.resolve() 的入参一致） */
    function readCfgForm() {
      var extra = null;
      var extraTxt = $('#aiCfgExtra') ? $('#aiCfgExtra').value.trim() : '';
      if (extraTxt) {
        try { extra = JSON.parse(extraTxt); } catch (e) { return { error: '额外参数不是合法 JSON' }; }
        if (!extra || typeof extra !== 'object' || extra.length !== undefined) {
          return { error: '额外参数要是一个 JSON 对象，例如 {"top_p":0.5}' };
        }
      }
      var cfg = {
        providerId: $('#aiCfgProvider') ? $('#aiCfgProvider').value : '',
        baseUrl: $('#aiCfgBase').value.trim(),
        token: $('#aiCfgToken').value.trim(),
        model: $('#aiCfgModel').value.trim(),
        api: $('#aiCfgApi') ? $('#aiCfgApi').value : '',
      };
      if (extra) cfg.extra = extra;
      return { cfg: cfg };
    }

    /* 把「实际会用哪个协议 / 这条模型有没有特殊规则」当场显示出来。
     * 这正是 modelRules 存在的意义：与其等上游回一句 404，不如填的时候就讲清楚。 */
    function syncApiTag() {
      var tag = $('#aiCfgApiTag');
      if (!tag) return;
      var f = readCfgForm();
      if (!JB || f.error) { tag.hidden = true; return; }
      var r = JB.resolve(f.cfg);
      var bits = ['实际协议：' + r.api];
      if (r.rule && r.rule.dropTemperature) bits.push('该模型不传 temperature');
      if (r.rule && r.rule.thinkingLocked) bits.push('该模型始终开思考');
      else if (r.rule && r.rule.thinkingDisabled) bits.push('自动关闭思考');
      if (r.rule && r.rule.minOutput) bits.push('输出上限至少 ' + r.rule.minOutput);
      if (r.needsKey === false) bits.push('不需要 Key');
      tag.hidden = false;
      tag.textContent = bits.join(' · ');
    }

    function syncCfgBtn() {
      var b = $('#btnAiCfg');
      if (b) b.classList.toggle('on', !!aiCfg);
    }
    function openCfg() {
      var cur = aiCfg;
      var pid = (cur && cur.providerId) || matchProviderByBase(cur && cur.baseUrl);
      fillProviderOptions(pid);
      fillModelList(pid);
      $('#aiCfgBase').value = cur ? (cur.baseUrl || '') : '';
      $('#aiCfgToken').value = cur ? (cur.token || '') : '';
      $('#aiCfgModel').value = cur ? (cur.model || '') : '';
      if ($('#aiCfgApi')) $('#aiCfgApi').value = (cur && cur.api) || '';
      if ($('#aiCfgExtra')) $('#aiCfgExtra').value = (cur && cur.extra) ? JSON.stringify(cur.extra) : '';
      $('#aiCfgCookie').value = localStorage.getItem(JJ_COOKIE_KEY) || '';
      /* 探测服务端这一层（.ai-config.json / JB_AI_* 环境变量）：配了就把标签点亮，
       * 并把空着的地址/模型/协议预填上 —— 只回非敏感字段，Key 本体永不回。 */
      fetch('/api/roast/config').then(function (r) { return r.ok ? r.json() : null; })
        .then(function (c) {
          if (!c) return;
          $('#aiCfgSrvTag').hidden = !c.serverKey;
          $('#aiCfgCookieTag').hidden = !c.jjCookie;
          if (c.serverCfg) {
            if (!$('#aiCfgBase').value && c.baseUrl) $('#aiCfgBase').value = c.baseUrl;
            if (!$('#aiCfgModel').value && c.model) $('#aiCfgModel').value = c.model;
            if ($('#aiCfgApi') && !$('#aiCfgApi').value && c.api) $('#aiCfgApi').value = c.api;
            if (!cur && c.providerId) { fillProviderOptions(c.providerId); fillModelList(c.providerId); }
          }
          syncApiTag();
        })
        .catch(function () {});
      syncApiTag();
      cfgMask.hidden = false;
    }

    /* 换厂商 = 换一整套默认值（地址 + 预置模型），用户随后可以随便改。
     * 只在用户主动切换时触发，所以「选厂商」这个动作本身就是「用它的默认组合」。 */
    var provSel = $('#aiCfgProvider');
    if (provSel) {
      provSel.onchange = function () {
        var p = provById(this.value);
        if (!p) { syncApiTag(); return; }
        if (p.baseUrl) $('#aiCfgBase').value = p.baseUrl;
        fillModelList(p.id);
        if (p.models && p.models.length) $('#aiCfgModel').value = p.models[0];
        if ($('#aiCfgApi')) $('#aiCfgApi').value = '';
        syncApiTag();
      };
    }
    var baseIn = $('#aiCfgBase');
    if (baseIn) baseIn.oninput = syncApiTag;
    var modelIn = $('#aiCfgModel');
    if (modelIn) modelIn.oninput = syncApiTag;
    var apiSel = $('#aiCfgApi');
    if (apiSel) apiSel.onchange = syncApiTag;

    /* 「拉取列表」：问上游 /models 拿真实可用的模型名，填进 datalist。
     * 不是每家都实现了这个端点，拉不到就老实报错，让人手填。 */
    var fetchMb = $('#aiCfgFetchModels');
    if (fetchMb) {
      fetchMb.onclick = function () {
        var btn = this;
        var f = readCfgForm();
        if (f.error) { toast(f.error); return; }
        if (!f.cfg.baseUrl) { toast('先选个厂商，或填一个接口地址'); return; }
        btn.disabled = true;
        btn.textContent = '拉取中…';
        fetch('/api/models', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(f.cfg),
        })
          .then(parseRoastRes)
          .then(function (res) {
            if (!res.ok || !res.d.models) throw new Error((res.d && res.d.error) || '接口异常');
            var dl = $('#aiCfgModelList');
            dl.innerHTML = res.d.models.map(function (m) {
              return '<option value="' + esc(m.id) + '"></option>';
            }).join('');
            toast('拉到 ' + res.d.models.length + ' 个模型，点模型输入框就能选');
          })
          .catch(function (e) { toast('拉取失败：' + ((e && e.message) || e)); })
          .finally(function () { btn.disabled = false; btn.textContent = '拉取列表'; });
      };
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
      startBatch(true); // 换接口/模型后必须重评（抢占）
    }
    var cb = $('#btnAiCfg');
    if (cb) cb.onclick = openCfg;
    $('#aiCfgClose').onclick = closeCfg;
    cfgMask.addEventListener('click', function (e) { if (e.target === cfgMask) closeCfg(); });
    $('#aiCfgSave').onclick = function () {
      var f = readCfgForm();
      if (f.error) { toast(f.error); return; }
      var next = f.cfg;
      /* 掘金 Cookie 独立保存：不参与「是否配置 AI 接口」的判断 */
      var ck = $('#aiCfgCookie').value.trim();
      if (ck) localStorage.setItem(JJ_COOKIE_KEY, ck);
      else localStorage.removeItem(JJ_COOKIE_KEY);

      if (!next.providerId && !next.baseUrl && !next.token && !next.model) {
        applyCfg(null);
        closeCfg();
        toast('未配置 AI 接口，使用内置点评');
        return;
      }
      /* 选了厂商就等于填了地址（地址能从表里推出来），所以这里校验的是
       * 「最终能不能推出一个地址」，而不是表单里那一格有没有字 */
      var p = provById(next.providerId);
      var effBase = next.baseUrl || (p ? p.baseUrl : '');
      if (!effBase || !next.model) {
        toast('接口地址和模型必填；Key 可留空（由服务端文件 / 环境变量提供）');
        return;
      }
      var r = JB ? JB.resolve(next) : null;
      applyCfg(next);
      closeCfg();
      /* 协议与模型规则冲突这类问题必须当场说，别留到翻牌时报 404 */
      if (r && r.warnings && r.warnings.length) toast(r.warnings[0]);
      else if (r) toast('已保存：' + JB.describe(r) + (next.token ? '' : ' · Key 由服务端提供'));
      else toast('已保存，翻牌时实时生成点评');
    };
    $('#aiCfgClear').onclick = function () {
      applyCfg(null);
      localStorage.removeItem(JJ_COOKIE_KEY);
      closeCfg();
      toast('已清除配置，回到内置点评');
    };
    $('#aiCfgTest').onclick = function () {
      var btn = this;
      var f = readCfgForm();
      if (f.error) { toast(f.error); return; }
      var cfg = f.cfg;
      var p = provById(cfg.providerId);
      if ((!cfg.baseUrl && !(p && p.baseUrl)) || !cfg.model) { toast('接口地址和模型必填'); return; }
      if (!cfg.token) { toast('Key 为空，将使用服务端配置（.ai-config.json / JB_AI_API_KEY）'); }
      btn.disabled = true;
      btn.textContent = '测试中…';
      /* 走的是和正式生成完全一样的请求路径（同样带 providerId / api / extra），
       * 否则「测试通过、翻牌报错」就白测了 */
      fetch('/api/roast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: cfg.providerId || '', api: cfg.api || '',
          baseUrl: cfg.baseUrl, token: cfg.token, model: cfg.model,
          extra: cfg.extra || null,
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
          startBatch(true); // 新风格必须重评（抢占）
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
          /* 服务端这层（.ai-config.json 或 JB_AI_* 环境变量）配全了就接手，
           * Key 全程不进浏览器：这里拿到的是空 token。 */
          if (c && c.serverCfg && c.baseUrl && c.model && !aiCfg) {
            aiCfg = {
              baseUrl: c.baseUrl, token: '', model: c.model,
              providerId: c.providerId || '', api: c.api || '',
            };
            syncCfgBtn();
            render(false, 0);
            startBatch(true);
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
      /* ↑↓ 翻右侧卡片栈（AI 点评 / 评论）。必须 preventDefault，否则会滚动页面 */
      else if (e.key === 'ArrowUp') { e.preventDefault(); aiStep(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); aiStep(1); }
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

    /* 主卡是 <a>，整卡点进原文页。原生行为之外只补一件事：
     * 拖选文字后松手，浏览器照样派发 click ——用户本意是选中一段字，
     * 结果整页跳走。所以有非空选区时把这次 click 拦掉。
     * （触屏左右滑不会派发 click，交给浏览器自己判定，不在这里处理。） */
    host.addEventListener('click', function (e) {
      var t = e.target;
      var a = t && t.closest ? t.closest('a.main') : null;
      if (!a) return;
      var sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).length) e.preventDefault();
    });
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
    /* URL 覆写优先于本地记住的档位；只影响本次会话，不落盘 */
    if (urlMotion) S.motion = urlMotion;
    /* 必须早于首屏 render()：先把 html 的档位类定下来，
     * 首屏 render(false, 0) 本来就不播动画，不存在闪烁问题 */
    resolveMotion();
    /* 扩展模式：探一次掘金登录态，「一键评论」按结果亮（内部自判模式，站点是空操作） */
    ensureLoginCheck();
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

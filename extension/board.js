/* board.js — 魔鬼榜单前端
 *
 * 三层：大封面 + 小卡条（首页）→ 赛道详情 → 逐张切牌。
 * 口径全部对齐 docs/devil-board-spec.md 第六、七节；落地时踩到的两个关键点：
 *
 *  1) **条数不固定（1~N）**：面包屑「共 N 张」、进度「第 x / 共 N 张」都动态；
 *     缩略进度是「固定宽轨道里放 N 个卡」（超出横滚），不是固定几格。
 *  2) **三种换法完全等价**：点箭头 / 键盘 ← → / 左右滑动。滑动跟手（松手前不播动画），
 *     阈值 = 牌宽 25%，拖动时箭头淡出让位。
 *
 * v0.9.0：首页从「六摞牌」改为「一张大牌 + 一条小卡」：
 *   上 = 当前赛道封面大牌（1:1.4），下 = 六张赛道小卡，点谁切谁；
 *   切赛道 = 左右切牌（与详情翻牌同一套 --dx 位移机制，.fx 复用 .cx 规则）。
 *   点大牌进详情仍是「飞行层 + clone」：大牌与详情大牌同为 1:1.4，
 *   单轴等比缩放落位，内容全程不变（飞的是 .bigcard 克隆）。
 */
(function () {
  'use strict';

  var q = new URLSearchParams(location.search);

  /* ---------------- 动效档（与 app.js 同口径） ----------------
   *
   * ⚠️ 为什么这里要把 app.js 的逻辑重抄一遍：board.html 只引 board.js、**不引 app.js**，
   *    而首页那三档动效（完整 / 轻量 / 跟随系统）持久化在 localStorage 里、
   *    落到 html.motion-lite / html.motion-full 两个类上。原来 board.js 只写了一句
   *    `matchMedia('(prefers-reduced-motion: reduce)').matches`，于是两个页面口径分裂：
   *      首页设「完整」+ 系统开了减少动效 → 首页有动画、**榜单页没动画**
   *      首页设「轻量」                  → 首页没动画、榜单页照旧播完整动画
   *    两边读同一份档位就一致了。另外原先那句是**加载时快照**：改了系统设置不刷新
   *    页面不会生效（app.js 那边是监听 change 的），这里也补上。
   *
   * 默认档同样是 'full' 而不是 'system' —— 理由与 app.js 一致：榜单的观感主要就靠
   * 这套切牌/飞行，不该被预览环境或系统设置静悄悄降级成「看起来没动画」。
   * URL 覆写（临时预览用，不落盘）：?motion=full|lite|system */
  var MOTION_MODES = ['full', 'lite', 'system'];
  var LKEY = 'juejin-gacha-glass';   // 与 app.js 同一个键（同源共享 localStorage）
  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var urlMotion = (function () {
    var m = /[?&]motion=([a-z]+)/.exec(location.search);
    return m && MOTION_MODES.indexOf(m[1]) >= 0 ? m[1] : null;
  })();
  var motionMode = urlMotion || 'full';
  try {
    var mv = JSON.parse(localStorage.getItem(LKEY) || 'null');
    if (!urlMotion && mv && MOTION_MODES.indexOf(mv.motion) >= 0) motionMode = mv.motion;
  } catch (e) { /* 读不到就用默认档 */ }

  function resolveMotion() {
    var lite = motionMode === 'lite' || (motionMode === 'system' && motionQuery.matches);
    var root = document.documentElement;
    root.classList.toggle('motion-lite', lite);
    root.classList.toggle('motion-full', !lite);
  }
  resolveMotion();
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', resolveMotion);
  else if (motionQuery.addListener) motionQuery.addListener(resolveMotion);

  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  var DUR = 320;        // 切牌 / 发牌
  var DUR_BACK = 240;   // 返回上一层（入场倒放，压短）
  var DUR_SNAP = 160;   // 未过阈值弹回

  /* 封面牌（摞）设计尺寸（= board.css 的 --cover-w / --cover-h）。
   * ⚠️ v0.9.0 六摞已撤，但这对常量是 check_extension.py 的尺寸契约锚点
   *    （与 --cover-w/h 同步、1:1.4），保留勿删。
   *    飞行层的实际设计尺寸由 FT_W/FT_H（首页大牌）决定，见 makeFlyer。 */
  var COVER_W = 202;
  var COVER_H = 283;

  /* 首页大封面牌设计尺寸（= board.css 的 --fw / --fh，站点档）。
   * 300x420 与详情大牌 396x554 同为 1:1.4 → 飞行仍是单轴等比缩放。
   * 浮层档是 240x336，但 scale = 视觉/设计，按 300 算照样成立（240/300=0.8）。 */
  var FT_W = 300;
  var FT_H = 420;

  /* ---------------- 赛道元数据（v0.8.0 发牌视图需要） ----------------
   *
   * ⭐ 为什么前端要抄一份：`TRACKS` 定义在 board-core.mjs（ESM），而 board.js 是
   *   普通 script，不能 import —— 更根本的原因是**发牌视图出现时还没有 S.data**：
   *   那一刻正在算第一手，payload 一片都没有，六摞的赛道名/色得先摆出来。
   *   所以只能前端自带一份静态元数据。
   *
   * ⚠️ 这份是 board-core.mjs `TRACKS` 的**手工副本**，改那边必须同步改这里。
   *   `scripts/check_extension.py` 有一条断言会比对两处的 id / name / def / color，
   *   对不上就构建失败 —— 别靠记性，靠那条断言。
   *   （只需要 id/name/def/color 四项：符号走上面的 SYMBOL，维度条发牌视图不画。） */
  var TRACKS = [
    { id: 'venom',    name: '毒舌榜', def: '骂得最狠，而且最准',   color: '#FF5A3C' },
    { id: 'absurd',   name: '离谱榜', def: '逻辑最崩，还理直气壮', color: '#F5A524' },
    { id: 'passive',  name: '阴阳榜', def: '表面客气，体内捅刀',   color: '#A855F7' },
    { id: 'stubborn', name: '嘴硬榜', def: '错了也绝不认',         color: '#1E80FF' },
    { id: 'blah',     name: '废话榜', def: '说了很多，等于没说',   color: '#454D57' },
    { id: 'emo',      name: 'emo 榜', def: '深夜破防，上班如上坟', color: '#12A173' },
  ];

  /* ---------------- 赛道符号（SVG，无 emoji，spec 第十节） ----------------
   * 图形形状以设计稿为准：毒舌=实心水滴 / 离谱=圈问号 / 阴阳=圆+右半实心 /
   * 嘴硬=素盾牌（设计稿里**没有**内嵌符号）/ 废话=气泡三点 / emo=雨云。
   *
   * ⚠️ 每个符号的 viewBox 必须「按图形自身包围盒收紧成正方形」（见 SYM_VB），
   *    不能统一写 0 0 16 16：六个图形在 16 格里原本大小差一倍
   *    （旧版火焰 6.6×9.3、太极 12.4×12.4），统一缩到 12px 后火焰只剩 5px，
   *    和设计稿那个 ~11px 的小徽章完全对不上。
   *    SYM_VB 的数值 = 浏览器 getBBox() 实测 → 按最大线宽/2 外扩 → 取正方形（×1.04 留边），
   *    六个都落在「12px 盒子里实占 11.54px」，与设计稿一致。
   *    **改了任一 path 就要重算它那一行 viewBox**，别手改。
   *    （重算脚本：把图形塞进一个 viewBox="0 0 16 16" 的 <svg> 里读 getBBox()。） */
  var SYMBOL = {
    venom: '<path d="M8 1.5C5.2 4.6 3.5 6.8 3.5 9.1a4.5 4.5 0 0 0 9 0c0-2.3-1.7-4.5-4.5-7.6z" fill="currentColor"/>',
    absurd: '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.3 6.5c0-1.05.78-1.8 1.8-1.8s1.75.68 1.75 1.62c0 1.3-1.6 1.3-1.6 2.44" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/><circle cx="8.25" cy="10.6" r=".95" fill="currentColor"/>',
    passive: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/>',
    stubborn: '<path d="M8 1.7l5.2 2v4.2c0 3.1-2.1 5.6-5.2 6.5-3.1-.9-5.2-3.4-5.2-6.5V3.7l5.2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    blah: '<path d="M2.3 3.5h11.4v7.3H7.5l-3.3 2.7v-2.7H2.3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="5.6" cy="7.2" r=".95" fill="currentColor"/><circle cx="8" cy="7.2" r=".95" fill="currentColor"/><circle cx="10.4" cy="7.2" r=".95" fill="currentColor"/>',
    emo: '<path d="M4.7 10.5a2.9 2.9 0 01.3-5.7 3.7 3.7 0 016.9 1.1 2.4 2.4 0 01-.4 4.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M5.6 12.1l-.7 1.7M8 12.1l-.7 1.7M10.4 12.1l-.7 1.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  };
  var SYM_VB = {
    venom: '1.708 1.258 12.584 12.584',
    absurd: '0.460 0.460 15.080 15.080',
    passive: '0.772 0.772 14.456 14.456',
    stubborn: '0.564 0.614 14.872 14.872',
    blah: '1.240 1.740 13.520 13.520',
    emo: '1.464 1.836 12.982 12.982',
  };
  /* 卡牌形象素材（都由 scripts/make_card_faces.py 从用户给的参考图里处理出来）：
   *   char-*  **从牌里抠出来的角色**（透明底）—— 封面牌的形象区用
   *   art-*   牌中间的插画带 —— 详情大牌的形象区用
   * ⚠️ 两个前缀互不为子串是刻意的：make_board_snapshot.py 靠
   *    [style*="url(cards/char-...)"] 这种**整路径子串**做内联，前缀相撞会互相命中。 */
  var CARD_CHAR = {
    venom: 'char-c1-vicious', absurd: 'char-c2-absurd', passive: 'char-c3-passive',
    stubborn: 'char-c4-stubborn', blah: 'char-c5-blah', emo: 'char-c6-emo',
  };
  var CARD_ART = {
    venom: 'art-c1-vicious', absurd: 'art-c2-absurd', passive: 'art-c3-passive',
    stubborn: 'art-c4-stubborn', blah: 'art-c5-blah', emo: 'art-c6-emo',
  };
  function sym(id, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="' + (SYM_VB[id] || '0 0 16 16') +
      '" aria-hidden="true" style="display:block">' + (SYMBOL[id] || '') + '</svg>';
  }

  /* ---------------- 卡面背景碎片（v1.0 贴纸风，用户给的参考图） ----------------
   *
   * 参考图里每张卡的角色背后都散着一组**贴纸碎片**，六个赛道各不相同
   * （毒舌=闪电/皇冠，废话=纸堆，emo=星星…），这是它「潮玩贴纸」观感的一半来源。
   *
   * ⭐ 用**矢量现画**，不用位图：
   *   ① 跟着赛道色走（currentColor）——改色值不用重出图，六张自动跟上；
   *   ② 不增加任何请求。首屏本来就要拉六张角色图（合计 ~690KB），
   *      再挂 6 张碎片 PNG 是纯浪费；
   *   ③ 碎片的「散落」是刻意的低信息量装饰，不适合走 `make_card_faces.py`
   *      那套抠图链（那套的产出是要精修的素材，不是几何图形）。
   *
   * 坐标系：viewBox 0 0 100 140 —— **与卡面同为 1:1.4**（300x420 / 240x336 都是），
   * 所以铺满即不变形，两档共用一套坐标。
   * 每条 = [形状, x, y, 缩放, 旋转]。形状定义在 0..10 的局部坐标里；
   * 一块 10 单位的图形按 scale=1 铺出来是 30px（1 单位 = 3px @站点档）。
   * ⚠️ 摆位要避开中间的形象区（x 26~74 / y 20~98），那里是角色；
   *    碎片全落在四角与左右边缘。 */
  var SHAPES = {
    bolt:  '<path d="M6 0 2.2 5.6h2.4L3.4 10 7.8 4.2H5.4z"/>',
    /* 皇冠要带底座：只画三个尖角缩到 20px 时像一座小山峰（emo 榜右侧实测如此），
     * 补一条底边才读得出是皇冠。 */
    crown: '<path d="M1 8.2 2.4 2.4 5 5.4 7.6 2.4 9 8.2z"/><rect x="1" y="8.3" width="8" height="1.6" rx=".5"/>',
    spark: '<path d="M5 0 6.3 3.7 10 5 6.3 6.3 5 10 3.7 6.3 0 5 3.7 3.7z"/>',
    sheet: '<path d="M1.6 1.2h5.2L9.2 3.6V10H1.6z" fill="none" stroke-width="1.1"/>',
    slash: '<path d="M0.6 10 9.4 0" fill="none" stroke-width="1.7" stroke-linecap="round"/>',
    dot:   '<circle cx="5" cy="5" r="2"/>',
    cloud: '<path d="M2.6 8.4a2.2 2.2 0 01.2-4.3 2.8 2.8 0 015.2.8 1.9 1.9 0 01-.3 3.5z" fill="none" stroke-width="1.1"/>',
    ring:  '<circle cx="5" cy="5" r="3.9" fill="none" stroke-width="1.2"/>',
  };
  var DECO = {
    venom:    [['bolt', 9, 24, 1.0, -14],  ['crown', 84, 27, 0.8, 8],
               ['slash', 7, 56, 0.7, 0],   ['slash', 90, 64, 0.6, 0],
               ['spark', 12, 76, 0.65, 0], ['bolt', 86, 86, 0.7, 18]],
    absurd:   [['sheet', 9, 26, 0.9, -10], ['ring', 85, 31, 0.75, 0],
               ['slash', 7, 58, 0.65, 0],  ['spark', 12, 78, 0.7, 0],
               ['dot', 90, 62, 0.5, 0],    ['dot', 83, 82, 0.6, 0]],
    passive:  [['sheet', 10, 30, 0.85, 12], ['sheet', 83, 24, 0.7, -8],
               ['bolt', 7, 60, 0.6, -12],  ['slash', 90, 60, 0.6, 0],
               ['spark', 13, 80, 0.65, 0], ['ring', 83, 86, 0.6, 0]],
    stubborn: [['slash', 8, 28, 0.9, 0],   ['slash', 88, 36, 0.75, 0],
               ['slash', 8, 62, 0.6, 0],   ['slash', 88, 68, 0.55, 0],
               ['dot', 14, 80, 0.55, 0],   ['spark', 83, 85, 0.7, 0]],
    blah:     [['sheet', 9, 24, 0.9, -10], ['sheet', 82, 32, 0.75, 8],
               ['cloud', 12, 74, 0.85, 0], ['slash', 90, 60, 0.55, 0],
               ['dot', 83, 82, 0.55, 0],   ['dot', 7, 58, 0.5, 0]],
    emo:      [['spark', 11, 26, 0.95, 0], ['ring', 84, 33, 0.7, 0],
               ['slash', 7, 58, 0.6, 0],   ['crown', 82, 80, 0.75, 8],
               ['spark', 14, 78, 0.65, 0], ['dot', 90, 62, 0.5, 0]],
  };
  function decoSVG(id) {
    var list = DECO[id] || [];
    if (!list.length) return '';
    return '<svg class="cv-deco" viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden="true">' +
      list.map(function (d) {
        return '<g transform="translate(' + d[1] + ' ' + d[2] + ') scale(' + d[3] + ')' +
          (d[4] ? ' rotate(' + d[4] + ')' : '') + '">' + (SHAPES[d[0]] || '') + '</g>';
      }).join('') + '</svg>';
  }

  /* ---------------- 状态 ---------------- */
  var S = {
    range: q.get('range') === 'week' ? 'week' : 'day',
    data: null,
    status: 'idle',      // idle | building | ready | failed
    progress: null,
    err: null,
    trackId: q.get('track') || null,
    idx: 0,
    fidx: 0,             // 首页当前选中的赛道下标（大牌 / 小卡条共用）
    busy: false,         // 正在播切牌/发牌动画
  };

  var fslotEl = $('#fslot'), stripEl = $('#strip'), ftableEl = $('#ftable');
  var slotEl = $('#slot'), trackEl = $('#track');
  var viewDeal = $('#viewDeal'), viewDetail = $('#viewDetail'), sysEl = $('#sys');
  var tableEl = $('#table'), flyLayer = $('#flyLayer'), boardEl = $('#board');

  function board() {
    if (!S.data) return null;
    for (var i = 0; i < S.data.boards.length; i++) {
      if (S.data.boards[i].id === S.trackId) return S.data.boards[i];
    }
    return null;
  }
  /* 只认 html.motion-lite 一个类（由上面的 resolveMotion 落），不在这里再读
   * matchMedia —— 单一真相：媒体查询只在 resolveMotion 里解析一次。
   * ⚠️ 别改成 `!motionQuery.matches`：那会绕过首页的档位选择，回到口径分裂。 */
  function motion() { return !document.documentElement.classList.contains('motion-lite'); }

  /* ---------------- 取数 ---------------- */

  function setStatus(st, opt) {
    S.status = st;
    if (opt && opt.progress !== undefined) S.progress = opt.progress;
    if (opt && opt.err !== undefined) S.err = opt.err;
    paintSys();
  }

  /* AI 配置的 localStorage 键刻意与 app.js 同一个（'juejin-boom:ai-cfg'）：
   * 同源页面共享 localStorage，所以「抽卡页里填过的配置」榜单页直接复用 ——
   * 扩展浮层里 board.html 与 host.html 是同源，用户在配置弹窗填一次就够，
   * 不必在榜单页再填一遍。站点版填了也走同一份（口径与 /api/roast 的传参一致）；
   * 没填就空着，由服务端 .ai-config.json / 环境变量兜底。 */
  var AI_CFG_KEY = 'juejin-boom:ai-cfg';
  function localAiCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(AI_CFG_KEY) || 'null');
      /* 与 app.js 的 loadAiCfg() 同一条判据：有地址（或厂商）且有模型才算配好 */
      return (c && (c.baseUrl || c.providerId) && c.model) ? c : null;
    } catch (e) { return null; }
  }

  function fetchBoard(fresh) {
    /* ?mock=1 = 用确定性假分数代替 AI（只做前端联调，不烧 token），
     * 服务端在 ?mock=1 / JB_BOARD_MOCK=1 时走假打分。
     * 带 AI 配置时改走 POST、把配置放请求体 —— token 不该出现在 URL 里。 */
    var url = 'api/board?range=' + S.range + (fresh ? '&fresh=1' : '') +
      (q.get('mock') === '1' ? '&mock=1' : '');
    var ai = localAiCfg();
    var init = { cache: 'no-store' };
    if (ai) {
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify({ ai: ai });
    }
    return fetch(url, init).then(function (r) { return r.json(); });
  }

  var pollTimer = null;

  function load(fresh, isPoll) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    /* ⭐ 新一轮打分（首屏 / 切榜期 / 点重新评分）要把发牌台清空。
     * 判据是**这次不是轮询续期** —— 轮询必须保留 scSeen，
     * 否则每 1.3s 清一次，六摞会反复归零。
     * （同一批沸点重新算时 pinId 是重复的，不清就会被去重吃掉。） */
    if (!isPoll) scReset();
    setStatus('building', { progress: S.progress, err: null });
    fetchBoard(fresh).then(function (j) {
      if (j && j.status === 'building') {
        S.data = j.boards && j.boards.length ? j : S.data;
        setStatus('building', { progress: j.progress });
        /* 「评分中」要能看见进度，所以轮询 —— 一次全量抓取 + 打分要一两分钟，
         * 界面必须让人知道它在动，而不是死了。 */
        pollTimer = setTimeout(function () { load(false, true); }, 1300);
        return;
      }
      if (j && j.status === 'failed' && !(j.boards && j.boards.length)) {
        setStatus('failed', { err: j.error || '生成失败' });
        return;
      }
      S.data = j;
      setStatus(j && j.stale ? 'ready' : 'ready', { progress: null, err: null });
      paint();
    }).catch(function (e) {
      setStatus('failed', { err: String((e && e.message) || e) });
    });
  }

  /* ---------------- 渲染：评分中发牌（v0.8.0） ----------------
   *
   * ⭐ 数据源是 `progress.dealt`（board-core 的 scoreCandidates 每批回报的
   *   「本块每条分到哪个赛道」）。**必须累积，不能只留最新一批** ——
   *   前端 1.3s 轮询而 AI 一批十几秒，不累积的话中途发出的牌会凭空消失。
   *
   * ⚠️ 三种内容不能混为一谈（与榜期卡同一个原则，spec §6.7）：
   *   ranked=true  → 飞进对应赛道摞
   *   ranked=false → 「不够 6 分不上榜」，**不是失败**（榜单宁可空着）
   *   没拿到 dealt → 还在请求中
   */
  var scSeen = {};        // pinId -> 记录，防重（轮询会重复推同一批）
  var scCols = null;      // 六个 .sc-col 元素缓存
  /* 牌堆错开的格数上限：超过这个数就不再往下挪（否则压到赛道名，见 paintScoring）。
   * ⚠️ 必须与 board.css 的 `--sc-fan` 一致（.sc-pile 靠它预留错开高度）。 */
  var SC_FAN_MAX = 6;

  /* 新一轮打分 = 推倒重来。⚠️ 只在「不是轮询续期」时调（见 load）：
   * 同一批沸点重算时 pinId 会重复，去重表不清就会把新发的牌全吃掉。 */
  function scReset() {
    scSeen = {};
  }

  /* 赛道色的 8% 淡底 —— 给「顶牌」和计数徽标用。
   * 用 color-mix 而不是硬编码六组浅色：赛道色一改这里自动跟着走。 */
  function tintOf(hex) {
    return 'color-mix(in srgb, ' + hex + ' 8%, #fff)';
  }

  function scBuckets() {
    var b = {};
    for (var i = 0; i < TRACKS.length; i++) b[TRACKS[i].id] = [];
    return b;
  }

  function paintScoring() {
    var p = S.progress || {};
    var dealt = p.dealt || [];
    var b = scBuckets();
    var lost = 0, n = 0;
    /* 最后一张落进哪一摞（给发牌台的「正在落位」提示用） */
    var lastTop = null;
    for (var i = 0; i < dealt.length; i++) {
      var d = dealt[i];
      /* 去重：轮询会重复推同一批 dealt（累积后的完整历史） */
      if (scSeen[d.pinId]) { n++; continue; }
      scSeen[d.pinId] = 1;
      n++;
      if (d.ranked && d.trackId && b[d.trackId]) b[d.trackId].push(d);
      else if (!d.ranked) lost++;
    }

    /* 阶段条：第 1、2 步在进入打分阶段后才有确定的数字 */
    var scan = $('#scScan'), cand = $('#scCand'), done = $('#scDone');
    if (scan) scan.textContent = p.scanned || 0;
    if (cand) cand.textContent = p.candidates || 0;
    if (done) done.textContent = (p.done || 0) + '/' + (p.candidates || 0);
    /* 扫描阶段（还没进打分）：第 1 步在动、第 2、3 步别提前打勾 */
    var scoring = p.phase === 'score';
    var stepEls = document.querySelectorAll('#scPhase .sc-step');
    for (var k = 0; k < stepEls.length; k++) {
      stepEls[k].classList.toggle('is-now', scoring ? k === 2 : k === 0);
      stepEls[k].classList.toggle('is-done', scoring ? k < 2 : false);
    }

    /* 六摞 */
    if (!scCols) {
      var deck = $('#scDeck');
      if (!deck) return;
      deck.innerHTML = TRACKS.map(function (t) {
        return '<div class="sc-col" data-track="' + t.id + '"' +
          ' style="--sc-color:' + t.color + ';--sc-tint:' + tintOf(t.color) + '">' +
          '<div class="sc-pile" data-pile="' + t.id + '"></div>' +
          '<div class="sc-meta"><span class="sc-name">' + t.name + '</span>' +
          '<span class="sc-num" data-num="' + t.id + '">0</span></div></div>';
      }).join('');
      scCols = {};
      var cols = deck.querySelectorAll('.sc-col');
      for (var c = 0; c < cols.length; c++) scCols[cols[c].getAttribute('data-track')] = cols[c];
    }

    for (var ti = 0; ti < TRACKS.length; ti++) {
      var t = TRACKS[ti];
      var col = scCols[t.id];
      if (!col) continue;
      var list = b[t.id];
      var pile = col.querySelector('[data-pile]');
      var num = col.querySelector('[data-num]');
      if (num) num.textContent = list.length;
      if (!pile) continue;

      if (!list.length) {
        pile.className = 'sc-pile is-empty';
        pile.textContent = '等 AI 发牌';
        continue;
      }
      pile.className = 'sc-pile';
      /* ⭐ 一摞牌**倒着叠**：第 1 名在最上（--i:0），往后每张往下 4px。
   *   这样两件事同时成立：
   *     - 视觉上「越靠下名次越大」，符合牌堆直觉
   *     - 新发的那张永远在**最下面**，也就是「刚落进这一摞」的那张
   *       （is-top 给它赛道色 —— 用户第一眼看到的就是刚发生的事）
   * ⚠️ 错开量在**这里封顶**（SC_FAN_MAX）：.sc-pile 固定高、不裁剪，
   *    12 张全按 4px 挪会多出 44px，最后一张压到赛道名上（实测 5~6 张就压）。
   *    CSS 里不做 min(var(--i),N) —— min() in calc() 兼容性不稳。
   *    封顶后超过的那些张会**完全重叠**，只靠最下面那张露出来表示「还有更多」。 */
      var h = '';
      for (var m = 0; m < list.length; m++) {
        var x = list[m];
        var last = (m === list.length - 1);
        h += '<div class="sc-card' + (last ? ' is-top' : '') + '"' +
          ' style="--i:' + Math.min(m, SC_FAN_MAX) + '" title="' + esc(x.title || '') + '">' +
          '<div class="sc-top">' +
            '<b class="sc-rank">' + pad2(m + 1) + '</b>' +
            '<span class="sc-sym">' + sym(t.id, 15) + '</span>' +
          '</div>' +
          '<div class="sc-head">' + x.score + ' · ' + esc(t.def) + '</div>' +
          '<div class="sc-mid"><span class="sc-sym">' + sym(t.id, 34) + '</span></div>' +
          '<div class="sc-verdict">' + esc(x.verdict || x.title || '') + '</div>' +
          '</div>';
      }
      pile.innerHTML = h;
      /* 记下「最后落到哪一摞的」——发牌台上那行提示要用。 */
      if (m) lastTop = { t: t, n: list.length };
    }

    /* 发牌台：待发 = 候选总数 − 已打分；手牌 = 还剩几张没发（上限一手 8 张） */
    var total = p.candidates || 0, scored = p.done || 0;
    var left = Math.max(0, total - scored);
    var hallT = $('#scHallT'), hallS = $('#scHallS'), hallNow = $('#scHallNow'), hand = $('#scHand');
    /* ⭐ 「正在落位」必须**带赛道名 + 赛道色**：这一屏的全部意义就是
     *    「什么类型进了哪个堆」。只报数字的话，用户还是不知道这一手发去了哪。 */
    if (hallNow) {
      if (lastTop) {
        hallNow.textContent = '正在落位 → ' + lastTop.t.name + ' 第 ' + lastTop.n + ' 张（' + lastTop.t.def + '）';
        hallNow.style.color = lastTop.t.color;
      } else if (scoring) {
        hallNow.textContent = 'AI 正在给这一手分赛道…';
        hallNow.style.color = '';
      } else {
        hallNow.textContent = '等 AI 发第一手';
        hallNow.style.color = '';
      }
    }
    if (hallT) {
      hallT.textContent = scoring
        ? (left > 0 ? ('第 ' + (scored + 1) + ' 条待发') : '这一手发完了')
        : ('正在翻沸点流…第 ' + (p.pages || 1) + ' 页');
    }
    if (hallS) {
      hallS.textContent = scoring
        ? ('已有 ' + (n - lost) + ' 条归榜 · ' + lost + ' 条不够 6 分不上榜')
        : ('已扫 ' + (p.scanned || 0) + ' 条 · 抓完才开始打分');
    }
    if (hand) {
      /* 手牌 = 还没发出来的那些，尾批会少于 8 张（4/4 那手），
       * 全发完就是 0 张 —— 和「发牌台清空」视觉一致。 */
      var show = scoring ? Math.min(8, left) : 0;
      var hh = '';
      for (var q = 0; q < show; q++) {
        hh += '<i class="' + (q === 0 ? 'is-going' : '') + '" style="--i:' + q + '"></i>';
      }
      hand.innerHTML = hh;
    }
  }

  /* 切到发牌视图 / 切回。⚠️ 与 viewDeal / viewDetail 是三选一，
   * 所以每次进「评分中」都要把另两个藏起来 —— 否则三层会叠在一起。 */
  function showScoring(on) {
    if (on) {
      viewDeal.hidden = true;
      if (viewDetail) viewDetail.hidden = true;
      $('#viewScoring').hidden = false;
      paintScoring();
    } else {
      $('#viewScoring').hidden = true;
    }
  }

  /* ---------------- 渲染：系统状态 ---------------- */

  var RING = '<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">' +
    '<circle cx="17" cy="17" r="14" fill="none" stroke="#EDEFF2" stroke-width="3"/>' +
    '<circle cx="17" cy="17" r="14" fill="none" stroke="#1A1D21" stroke-width="3"' +
    ' stroke-linecap="round" stroke-dasharray="88" stroke-dashoffset="30" transform="rotate(-90 17 17)">' +
    '<animateTransform attributeName="transform" type="rotate" from="0 17 17" to="360 17 17"' +
    ' dur="1s" repeatCount="indefinite"/></circle></svg>';
  var ICO_EMPTY = '<svg width="34" height="34" viewBox="0 0 34 34"><rect x="7" y="4" width="17" height="24" rx="3" fill="#fff" stroke="#D6DBE0" stroke-width="1.5" transform="rotate(-6 15.5 16)"/><rect x="11" y="6" width="17" height="24" rx="3" fill="#fff" stroke="#C9CDD4" stroke-width="1.5"/><path d="M16 15h7M16 19.5h4.5" stroke="#DFE3E8" stroke-width="1.5" stroke-linecap="round"/></svg>';
  var ICO_FAIL = '<svg width="34" height="34" viewBox="0 0 34 34"><circle cx="17" cy="17" r="13" fill="none" stroke="#E8734A" stroke-width="1.8"/><path d="M17 10v8.5" stroke="#E8734A" stroke-width="1.8" stroke-linecap="round"/><circle cx="17" cy="23" r="1.2" fill="#E8734A"/></svg>';

  function totalCards() {
    if (!S.data || !S.data.boards) return 0;
    return S.data.boards.reduce(function (n, b) { return n + b.top.length; }, 0);
  }

  function paintSys() {
    var st = S.status;
    var show = false, ico = '', title = '', sub = '', bar = false, btn = '';

    /* ⭐ v0.8.0：「评分中」不再弹居中卡片，改成**整个发牌视图**
     * （六摞随 AI 返回逐张长大）。所以这里：
     *   - 无旧榜单 → showScoring(true)，.sys 整个不显示
     *   - 有旧榜单（stale 重算）→ 旧六摞留在下面压暗，当背景参照
     */
    if (st === 'building' && !S.data) {
      showScoring(true);
    } else {
      showScoring(false);
    }

    if (st === 'building' && S.data) {
      /* 有旧榜可看 → 仍用居中卡片压一层（旧榜在后面，不清空） */
      show = true; ico = RING; title = '正在重新评分';
      var pp = S.progress || {};
      sub = pp.phase === 'score'
        ? ('已扫 ' + (pp.scanned || 0) + ' 条 · 重新打分 ' + (pp.done || 0) + '/' + (pp.candidates || 0))
        : ('正在翻沸点流…已扫描 ' + ((pp.scanned || 0)) + ' 条');
      bar = true;
      $('#sysBarIn') && ($('#sysBarIn').style.width =
        pp.candidates ? Math.round((pp.done || 0) / pp.candidates * 100) + '%' : '4%');
    } else if (st === 'building' && !S.data) {
      /* 已交给发牌视图，这里只保留变量（保持分支可读，实际不显示） */
      show = false;
    } else if (st === 'failed') {
      show = true; ico = ICO_FAIL; title = '这次没算出来';
      sub = (S.err || '接口异常') + '。已经算好的榜单不会丢，可以稍后在下方重新评分。';
      btn = '重试';
    } else if (st === 'ready' && totalCards() === 0) {
      show = true; ico = ICO_EMPTY; title = (S.range === 'week' ? '本周' : '今日') + '暂无上榜';
      sub = '候选不够，或内容都不达标 —— 榜单宁可空着，也不硬凑第一名。换个范围试试。';
    }

    sysEl.hidden = !show;
    if (!show) return;
    $('#sysIco').innerHTML = ico;
    $('#sysTitle').textContent = title;
    $('#sysSub').textContent = sub;
    $('#sysBar').hidden = !bar;
    var b = $('#sysBtn');
    b.hidden = !btn;
    b.textContent = btn;
    b.onclick = function () { load(true); };
    /* 「评分中」时把两个视图压暗，让人聚焦在进度上；有旧榜单则留在后面 */
    viewDeal.style.opacity = (st === 'building' && S.data) ? '.28' : '';
    viewDetail.style.opacity = (st === 'building' && S.data) ? '.28' : '';
  }

  /* ---------------- 渲染：六摞牌 ---------------- */

  /* 封面牌 = **我们自己的版式（文字全实时）+ 从参考图里抠出来的角色**。
   *
   * ⭐ 三次改版才对，别再走回头路：
   *   1) v0.4.0 自绘卡面 + 换一版插画 → 用户说「图片样式跟参考图没保持一致」
   *      （根因是我们复刻不出参考图那套字，不是插画的问题）。
   *   2) v0.5.0 从参考图里切牌面凑 1:1.4 → 「贴图太丑了」。
   *   3) v0.5.1 整张参考牌直接用 → 「是把角色抠出来，**不是把整张图都放进去**，
   *      贴在原有的那个卡片上，现在卡片看起来特别奇怪」。
   *   ⭐ 结论：参考图里**值钱的是角色**，不是它的框和烤死的文案。
   *      所以只抠角色当插画，名次/分数/赛道名/定义/入口全部回到我们自己的版式，
   *      顺带把 v0.5.1 丢掉的那个动态值（最高分）拿回来。
   *
   * 空榜（合法状态，spec 6.4）：名次显 0、分数显 —、入口显「暂无上榜」，
   * 不另做占位图，靠 .stack.empty 降不透明度提示。 */
  /* ⭐ v1.0 版式（按用户给的参考图重排）：顶「名次 + 分数」→ 中「角色」→ 下「赛道名 + 定义」→ 底「入口」。
   *   与 v0.6.0 的差别只有两处，但都是参考图的重点：
   *     ① 赛道名从**角色上方**移到**角色下方**并放大（参考图里它是视觉重心，压在角色脚上）；
   *     ② 多一层背景碎片（decoSVG），角色不再是「白底上一个孤零零的形象」。
   *   颜色一律走 CSS 变量 --tc（由 paintFeature 写在 .fx 上）—— 原来每个元素各写一次
   *   内联 color，六处颜色散在字符串里，改配色要改六遍。 */
  function coverHTML(b) {
    var empty = !b.top || !b.top.length;
    var best = empty ? null : b.top[0];
    return '' +
      decoSVG(b.id) +
      '<div class="cover-top">' +
        '<span class="left">' +
          '<span class="cv-sym">' + sym(b.id, 20) + '</span>' +
          '<b class="cover-rank">' + (empty ? '0' : '1') + '</b>' +
        '</span>' +
        '<b class="cover-score' + (empty ? ' is-empty' : '') + '">' +
          (empty ? '—' : best.score.toFixed(1)) + '</b>' +
      '</div>' +
      '<div class="cover-fig" style="background-image:url(cards/' + CARD_CHAR[b.id] + '.png)"></div>' +
      '<div class="cover-name">' + esc(b.name) + '</div>' +
      /* ⚠️ 空榜时定义行与入口**不能都写「暂无上榜」** —— 两行同文案挨在一起，
       *    第一版出图后像渲染重复。定义行保留「暂无上榜」这个数据事实，
       *    入口退回「查看赛道 →」，与正常态的「点击进入 →」同构。 */
      '<div class="cover-def">' + (empty ? '今日暂无上榜' : esc(b.def)) + '</div>' +
      '<div class="cover-go">' +
        '<span class="cv-sym">' + sym(b.id, 13) + '</span>' +
        (empty ? '查看赛道 →' : '点击进入 → 看完整榜单') +
      '</div>';
  }

  /* 首页大牌：三张封面（prev / cur / next）叠在同一格，切赛道 = 左右切牌。
   * 结构与详情 .slot 的 .cx 同构（data-pos 驱动 CSS 位移），复用 --dx 机制。 */
  function paintFeature() {
    var bs = (S.data && S.data.boards) || [];
    var parts = [];
    [-1, 0, 1].forEach(function (d) {
      var i = S.fidx + d;
      if (i < 0 || i >= bs.length) return;
      var b = bs[i];
      var empty = !b.top || !b.top.length;
      /* --tc = 赛道色，整张卡（描边 / 名次 / 分数 / 赛道名 / 入口 / 背景碎片）
       * 都从它派生；写在 .fx 上由 .cover 继承，一处改色全卡跟。 */
      parts.push('<div class="fx' + (empty ? ' empty' : '') +
        '" data-pos="' + (d === 0 ? 'cur' : (d > 0 ? 'next' : 'prev')) + '"' +
        ' style="--tc:' + b.color + '">' +
        '<div class="cover">' + coverHTML(b) + '</div></div>');
    });
    fslotEl.innerHTML = parts.join('');
    fslotEl.classList.remove('peek');
    var cur = bs[S.fidx];
    fslotEl.setAttribute('role', 'button');
    fslotEl.setAttribute('tabindex', '0');
    fslotEl.setAttribute('aria-label', cur
      ? (cur.name + (cur.top.length ? '，' + cur.top.length + ' 张，回车进入' : '（暂无上榜）'))
      : '正在取数');
  }

  /* 小卡条：六张赛道卡（首字 + 赛道色选中态），点谁切谁。title 带张数。 */
  function paintStrip() {
    var bs = (S.data && S.data.boards) || [];
    stripEl.innerHTML = bs.map(function (b, i) {
      var empty = !b.top || !b.top.length;
      return '<button class="fchip' + (i === S.fidx ? ' on' : '') + (empty ? ' is-empty' : '') +
        '" data-j="' + i + '" role="tab" aria-selected="' + (i === S.fidx) +
        '" style="--c:' + b.color + '"' +
        ' title="' + esc(b.name) + ' · ' + (b.top ? b.top.length : 0) + ' 张"' +
        ' aria-label="' + esc(b.name) + (empty ? '（暂无上榜）' : '，' + b.top.length + ' 张') + '">' +
        esc((b.name || ' ').charAt(0)) + '</button>';
    }).join('');
    /* 首页箭头两端置灰：用类而不是 disabled —— disabled 的 button 不派发事件，
     * 「点箭头」会比「点同侧空白」少一层反应，两者必须等价（越界时 fstep 自然不动） */
    $('#fPrev').classList.toggle('is-off', S.fidx <= 0);
    $('#fNext').classList.toggle('is-off', S.fidx >= bs.length - 1);
    $('#fPrev').setAttribute('aria-disabled', S.fidx <= 0 ? 'true' : 'false');
    $('#fNext').setAttribute('aria-disabled', S.fidx >= bs.length - 1 ? 'true' : 'false');
  }

  /* ---------------- 渲染：详情大牌 ---------------- */

  function bigCardHTML(b, it) {
    var dims = (it.dims || []).map(function (d) { return esc(d.k) + ' ' + d.v.toFixed(1); }).join(' · ');
    return '' +
      '<div class="bigcard">' +
        '<div class="bc-top">' +
          '<span class="left">' +
            '<b class="bc-rank" style="color:' + b.color + '">' + it.rank + '</b>' +
            '<span style="color:' + b.color + '">' + sym(b.id, 16) + '</span>' +
          '</span>' +
          '<b class="bc-score" style="color:' + b.color + '">' + it.score.toFixed(1) + '</b>' +
        '</div>' +
        '<div class="bc-fig" style="background-image:url(cards/' + CARD_ART[b.id] + '.png)"></div>' +
        (it.verdict ? '<div class="bc-verdict" style="color:' + b.color + '">「' + esc(it.verdict) + '」</div>' : '') +
        '<div class="bc-text">' + esc(it.content) + '</div>' +
        (dims ? '<div class="bc-dims">' + dims + '</div>' : '') +
        '<div class="bc-line"></div>' +
        '<div class="bc-foot">' +
          '<span>@' + esc(it.user) + '</span>' +
          '<span class="meta">赞 ' + it.digg + ' · 评 ' + it.cmt + '</span>' +
        '</div>' +
        '<a class="bc-go" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">看原文</a>' +
      '</div>';
  }

  /* 三张卡（prev / cur / next）叠在同一格；越界的位次不渲染 */
  function paintCards() {
    var b = board();
    if (!b) { slotEl.innerHTML = ''; return; }
    var n = b.top.length;
    var parts = [];
    [-1, 0, 1].forEach(function (d) {
      var i = S.idx + d;
      if (i < 0 || i >= n) return;
      parts.push('<div class="cx" data-pos="' + (d === 0 ? 'cur' : (d > 0 ? 'next' : 'prev')) + '">' +
        bigCardHTML(b, b.top[i]) + '</div>');
    });
    slotEl.innerHTML = parts.join('');
    slotEl.classList.remove('peek');
  }

  function paintTrack() {
    var b = board();
    if (!b) { trackEl.innerHTML = ''; return; }
    var n = b.top.length;
    var html = '';
    for (var i = 0; i < n; i++) {
      html += '<button class="thumb' + (i === S.idx ? ' on' : '') + '" data-i="' + i + '" ' +
        'style="' + (i === S.idx ? 'color:' + b.color : '') + '" ' +
        'aria-label="第 ' + (i + 1) + ' 张"' + (i === S.idx ? ' aria-current="true"' : '') + '></button>';
    }
    trackEl.innerHTML = html;
    /* 条数少时（轨道放得下）居中留白，不做拉伸填充 */
    var gap = 6, need = n * 24 + (n - 1) * gap;
    trackEl.classList.toggle('narrow', need <= trackEl.clientWidth);
    var on = trackEl.querySelector('.thumb.on');
    if (on && !trackEl.classList.contains('narrow')) {
      /* 当前项滚到可视区中间 */
      var left = on.offsetLeft, w = on.offsetWidth;
      trackEl.scrollTo({ left: Math.max(0, left - (trackEl.clientWidth - w) / 2), behavior: motion() ? 'smooth' : 'auto' });
    } else if (trackEl.classList.contains('narrow')) {
      trackEl.scrollLeft = 0;
    }
  }

  function paintChrome() {
    var b = board();
    var n = b ? b.top.length : 0;
    $('#crumbCur').textContent = b ? (b.name + ' · 共 ' + n + ' 张') : '—';
    $('#opsNum').textContent = '第 ' + (n ? S.idx + 1 : 0) + ' 张 / 共 ' + n + ' 张';
    /* 只剩 1 张时左右箭头同时置灰 */
    $('#btnPrev').disabled = !n || S.idx <= 0;
    $('#btnNext').disabled = !n || S.idx >= n - 1;
  }

  /* ---------------- 视图切换 ---------------- */

  /* 只把详情内容画出来，不动可见性 —— 发牌时要先在「可见但透明」的状态下量矩形，
   * 因为 hidden 元素的 getBoundingClientRect() 全是 0。 */
  function paintDetail() {
    paintCards(); paintTrack(); paintChrome();
  }

  function showDeal() {
    viewDetail.hidden = true;
    viewDeal.hidden = false;
    S.trackId = null;
    if (q.get('track')) {
      q.delete('track');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : ''));
    }
  }

  function showDetail() {
    viewDeal.hidden = true;
    viewDetail.hidden = false;
    paintDetail();
    q.set('track', S.trackId);
    history.replaceState(null, '', location.pathname + '?' + q.toString());
  }

  /* ---------------- 发牌：点一摞 → 顶牌飞到牌台中央（320ms） ----------------
   * 飞行层挂在 body 下（不在 .board 里），刻意不参与 --k 缩放：
   * 这样 clone 始终按设计像素**导出尺寸**渲染，再靠 scale 追平视觉尺寸。
   * ⭐ 封面牌与详情大牌同为 1:1.4 → **单轴等比缩放**即可（--s0 出发 / --s 落位）。
   *    （v0.5.1 那版封面是 1:1.218、大牌 1:1.4，比例不同才需要分轴。）
   *
   * ⭐ v0.8.2：飞的内容从**封面牌**换成**详情大牌的缩略版**。
   *   原来飞的是 `coverEl.outerHTML`，于是整个 320ms 里用户看到的是一张
   *   写着「emo 榜 / 点击进入 →」的**封面小牌**在放大，落位后突然整张换成
   *   详情大牌（名次 / 分数 / 判词 / 看原文）—— 一次明显的内容突变，
   *   而且「点击进入」这个按钮飞到了详情页，语义上已经过期。
   *   改飞大牌的clone 后：飞过去的就是落位后那张牌，**内容全程不变**，
   *   视觉上只剩位移+缩放这一件事（spec §6.2「顶牌飞到牌台中央并放大到详情尺寸」
   *   说的就是这件事）。 */
  function makeFlyer(srcEl, from, to, dw, dh) {
    var flyer = document.createElement('div');
    flyer.className = 'flyer';
    flyer.style.left = from.left + 'px';
    flyer.style.top = from.top + 'px';
    /* 设计尺寸由调用方传（v0.9.0 起首页大牌是 300x420，不再是封面小牌 202x283）：
     * 视觉尺寸 = 设计尺寸 x k → scale 就是「视觉宽 / 设计宽」；同比例所以只算宽度 */
    flyer.style.width = dw + 'px';
    flyer.style.height = dh + 'px';
    flyer.innerHTML = srcEl.outerHTML;
    flyer.style.setProperty('--s0', (from.width / dw).toFixed(4));
    flyer.style.setProperty('--s', (to.width / dw).toFixed(4));
    flyer.style.setProperty('--dx', (to.left - from.left).toFixed(1) + 'px');
    flyer.style.setProperty('--dy', (to.top - from.top).toFixed(1) + 'px');
    flyLayer.appendChild(flyer);
    return flyer;
  }

  function crossFade(big) {
    if (!big) return;
    big.style.transition = 'opacity ' + (motion() ? 140 : 0) + 'ms linear';
    big.style.opacity = '1';
    setTimeout(function () { big.style.transition = ''; big.style.opacity = ''; }, 160);
  }

  function openTrack(trackId) {
    if (S.busy || S.trackId) return;
    var bs = (S.data && S.data.boards) || [];
    var b = null;
    for (var i = 0; i < bs.length; i++) if (bs[i].id === trackId) { b = bs[i]; break; }
    if (!b) return;
    S.busy = true;
    S.trackId = trackId;
    S.idx = 0;
    /* 大牌槽与小卡条必须对齐到要进的赛道（URL ?track= 直达时可能不一致）：
     * viewDeal 此刻多半还可见，重绘要赶在量矩形之前 */
    if (S.fidx !== i) { S.fidx = i; paintFeature(); paintStrip(); }

    if (!motion()) {
      S.busy = false;
      showDetail();
      return;
    }

    /* 先把详情摆出来（透明）并渲染内容，这样才量得到大牌的真实矩形 */
    viewDetail.hidden = false;
    viewDetail.style.opacity = '0';
    paintDetail();
    var big = slotEl.querySelector('.bigcard');
    if (big) big.style.opacity = '0';

    var cover = fslotEl.querySelector('.fx[data-pos="cur"] .cover');
    var from = cover ? cover.getBoundingClientRect() : fslotEl.getBoundingClientRect();
    var to = cardRect();
    /* 空榜：没有大牌可落，就地淡出 */
    if (!b.top || !b.top.length) to = from;

    /* 首页内容整体淡出让位（旧版是六摞 .deck.leaving），
     * 飞行层是唯一焦点 —— 与 v0.8.2 同一原则 */
    viewDeal.style.transition = 'opacity 200ms linear';
    viewDeal.style.opacity = '0';

    /* ⚠️ 飞的是**大牌的克隆**（v0.8.2 起不变），不是封面牌。
     *   克隆源必须是已经渲染好的 .bigcard —— 它此刻 opacity:0，
     *   但 outerHTML 不带行内 style 之外的状态，且下面立刻把clone
     *   的 opacity 强制成 1（.bigcard 的 opacity:0 是行内样式，
     *   outerHTML 会把它**一起克隆过去**，不处理的话飞出来是张空牌）。 */
    var flyer = makeFlyer(big || cover, from, to, FT_W, FT_H);
    var fclone = flyer.firstElementChild;
    if (fclone) {
      /* 克隆带过来的行内 opacity 要清掉，再由 .flyer 自己控制整体透明度 */
      fclone.style.opacity = '';
      fclone.style.width = '100%';
      fclone.style.height = '100%';
    }

    setTimeout(function () {
      viewDetail.style.opacity = '';
      viewDeal.hidden = true;
      viewDeal.style.opacity = '';
      viewDeal.style.transition = '';
      crossFade(big);
      flyer.style.transition = 'opacity ' + (motion() ? 110 : 0) + 'ms linear';
      flyer.style.opacity = '0';
      setTimeout(function () {
        flyer.remove();
        q.set('track', S.trackId);
        history.replaceState(null, '', location.pathname + '?' + q.toString());
        S.busy = false;
      }, motion() ? 130 : 0);
    }, DUR);
  }

  function closeDetail() {
    if (S.busy || !S.trackId) return;
    var cover = fslotEl.querySelector('.fx[data-pos="cur"] .cover');
    if (!cover || !motion()) { backToDeal(); return; }
    S.busy = true;

    var from = cardRect();
    /* 首页大牌视图先「摆出来但不显示」，否则量不到封面大牌的位置 */
    viewDeal.hidden = false;
    viewDeal.style.opacity = '0';
    var to = cover.getBoundingClientRect();

    var big = slotEl.querySelector('.bigcard');
    if (big) { big.style.transition = 'opacity 120ms linear'; big.style.opacity = '0'; }

    /* ⚠️ 与 openTrack 配对：飞**大牌的克隆**（v0.8.2 起不变）。
     *   返回全程内容不变，只是缩回首页大牌位。 */
    var flyer = makeFlyer(big || cover, to, from, FT_W, FT_H);
    var fclone2 = flyer.firstElementChild;
    if (fclone2) {
      fclone2.style.opacity = '';
      fclone2.style.transition = '';
      fclone2.style.width = '100%';
      fclone2.style.height = '100%';
    }
    flyer.classList.add('back');

    setTimeout(function () {
      flyer.remove();
      if (big) { big.style.transition = ''; big.style.opacity = ''; }
      viewDetail.hidden = true;
      /* 首页跟着牌一起淡回来 */
      viewDeal.style.transition = 'opacity 200ms linear';
      viewDeal.style.opacity = '';
      setTimeout(function () { viewDeal.style.transition = ''; }, 220);
      showDeal();
      S.busy = false;
    }, DUR_BACK);
  }

  function backToDeal() {
    viewDetail.hidden = true;
    viewDeal.hidden = false;
    viewDeal.style.opacity = '';
    showDeal();
  }

  /* ---------------- 切牌 ---------------- */

  function cardRect() { return slotEl.getBoundingClientRect(); }

  /* --dx 写在 .slot 上（无单位像素数），三张卡按它一起位移。
   * snap=true 表示「瞬时归零」：先关掉过渡写一次值并强制 reflow，再放开过渡，
   * 否则归零那一下会倒着播一遍动画。 */
  function setDx(v, snap) {
    if (snap) {
      slotEl.classList.add('instant');
      slotEl.style.setProperty('--dx', v);
      void slotEl.offsetWidth;
      slotEl.classList.remove('instant');
      return;
    }
    slotEl.style.setProperty('--dx', v);
  }

  /* 三种换法共用这一条：d=+1 下一张，d=-1 上一张。 */
  function step(d) {
    var b = board();
    if (!b || S.busy) return;
    var n = b.top.length;
    var ni = S.idx + d;
    if (ni < 0 || ni >= n) return;
    slideTo(ni, d, DUR);
  }

  /* 把牌台推到第 ni 张：目标方向的牌已经在槽里了，只要推 --dx 走完那段距离。
   * 走到头再落数据（换 idx、重排三张卡），所以交接过程牌台一直是满的。
   * ⚠️ 距离必须与 CSS 的 --slidegap 联动：切牌期间 --slidegap:0（两牌贴紧），
   *    终点就是整整一张牌宽（396）；拖动那条路gap 还是 16，终点是 412。
   *    写死 412 会在 .sliding 下冲过头16px —— 落位时牌「越过」中心再弹回来。*/
  function slideTo(ni, d, dur) {
    if (!motion()) { S.idx = ni; paintDetail(); return; }
    S.busy = true;
    slotEl.style.setProperty('--peek', '1');
    /* ⚠️ 顺序：**先加 .sliding 再算 dist**。
     * 写反的话 contains('sliding') 读到 false，dist 恒为 slotW+16，
     * 而 CSS 的 --slidegap 已经是 0 → 终点少16px，牌在落位时「差一截」。 */
    slotEl.classList.add('peek', 'sliding');
    var dist = slotEl.offsetWidth;
    setDx(0);
    void slotEl.offsetWidth;
    setDx(-d * dist);
    setTimeout(function () {
      S.idx = ni;
      setDx(0, true);
      slotEl.classList.remove('peek', 'sliding');
      paintDetail();
      S.busy = false;
    }, dur);
  }

  function bindArrows() {
    $('#btnPrev').addEventListener('click', function () { step(-1); });
    $('#btnNext').addEventListener('click', function () { step(1); });
  }
  bindArrows();

  /* ---------------- 首页切赛道（v0.9.0：左右切大牌） ----------------
   * 与详情 slideTo 同一套机制：目标牌已在 .fslot 的对侧槽里（paintFeature
   * 按 fidx 渲染 [-1,0,1]），只要推 --dx 走完一段距离，落位后重排。
   * ⚠️ 同样的顺序坑：**先加 .sliding 再算 dist**（--slidegap 收 0 后
   *    终点才是整整一张牌宽，否则差 16px，落位会「越过中心再弹回」）。 */
  function setFDx(v, snap) {
    if (snap) {
      fslotEl.classList.add('instant');
      fslotEl.style.setProperty('--dx', v);
      void fslotEl.offsetWidth;
      fslotEl.classList.remove('instant');
      return;
    }
    fslotEl.style.setProperty('--dx', v);
  }

  function fstep(d) {
    var bs = (S.data && S.data.boards) || [];
    var ni = S.fidx + d;
    if (S.busy || ni < 0 || ni >= bs.length) return;
    fslideTo(ni, d);
  }

  function fslideTo(ni, d) {
    var bs = (S.data && S.data.boards) || [];
    if (ni < 0 || ni >= bs.length) return;
    /* 跨多张（小卡直接点远端）或减动效环境：跳过动画直接落位 ——
     * 对侧槽里只有相邻那张，多张跳跃播动画会露出空槽 */
    if (!motion() || Math.abs(ni - S.fidx) !== 1) {
      S.fidx = ni;
      paintFeature(); paintStrip();
      return;
    }
    S.busy = true;
    fslotEl.style.setProperty('--peek', '1');
    fslotEl.classList.add('peek', 'sliding');
    var dist = fslotEl.offsetWidth;
    setFDx(0);
    void fslotEl.offsetWidth;
    setFDx(-d * dist);
    setTimeout(function () {
      S.fidx = ni;
      setFDx(0, true);
      fslotEl.classList.remove('peek', 'sliding');
      paintFeature(); paintStrip();
      S.busy = false;
    }, DUR);
  }

  function bindTrack() {
    trackEl.addEventListener('click', function (e) {
      var t = e.target.closest('.thumb');
      if (!t || S.busy) return;
      var i = Number(t.getAttribute('data-i'));
      if (!(i >= 0) || i === S.idx) return;
      /* 点缩略卡是「跳过去」不是「翻过去」：直接落位，不播切牌动画 */
      S.idx = i;
      setDx(0, true);
      slotEl.classList.remove('peek');
      paintDetail();
    });
  }

  /* ---------------- 键盘 ← → / Esc ---------------- */

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (!$('#ruleMask').hidden) {
      if (e.key === 'Escape') closeRule();
      return;
    }
    if (!viewDetail.hidden) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
      return;
    }
    /* 首页：← → 切赛道（与详情翻同一套键位直觉） */
    if (viewDeal.hidden) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); fstep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); fstep(1); }
  });

  /* ---------------- 左右滑动（跟手） ---------------- */

  function bindSwipe() {
    var down = null;
    var cardW = 0;

    tableEl.addEventListener('pointerdown', function (e) {
      if (S.busy || viewDetail.hidden) return;
      if (e.target.closest('.round') || e.target.closest('.bc-go')) return;
      down = { x: e.clientX, dx: 0 };
      cardW = slotEl.offsetWidth;
      tableEl.classList.add('dragging');   // 拖动时两个箭头淡出让位
      slotEl.classList.add('peek');
      try { tableEl.setPointerCapture(e.pointerId); } catch (_) {}
    });

    tableEl.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - down.x;
      /* 已经在第一张还往右拖（或末张往左拖）→ 阻尼，给出「拖不动」的手感 */
      var b = board(), n = b ? b.top.length : 0;
      if ((S.idx === 0 && dx > 0) || (S.idx >= n - 1 && dx < 0)) dx *= 0.32;
      down.dx = dx;
      setDx(dx);
      /* 对侧牌边按位移比例淡入，不要一上来就整张露出来 */
      slotEl.style.setProperty('--peek', Math.min(1, Math.abs(dx) / Math.max(1, cardW * 0.5)).toFixed(2));
    });

    function end() {
      if (!down) return;
      var dx = down.dx;
      down = null;
      tableEl.classList.remove('dragging');
      slotEl.style.setProperty('--peek', '1');

      var b = board(), n = b ? b.top.length : 0;
      var d = dx < 0 ? 1 : -1;
      var ni = S.idx + d;
      var th = cardW * 0.25;               // 吸附阈值 = 牌宽 25%

      if (Math.abs(dx) >= th && ni >= 0 && ni < n) {
        /* 过阈值：接着走完 320ms（当前已经在 dx 上，直接推到终点即可）。
         * ⚠️ 拖动起手时 gap 还是 16px（要露牌边），所以**先切到 sliding**
         *    （gap→0）再算终点 —— 终点是 cardW 而非 cardW+16，
         *    跟 slideTo() 用同一套距离，两条路径动画才对得上。 */
        S.busy = true;
        slotEl.classList.add('sliding');
        setDx(-d * cardW);
        setTimeout(function () {
          S.idx = ni;
          setDx(0, true);
          slotEl.classList.remove('peek', 'sliding');
          paintDetail();
          S.busy = false;
        }, DUR);
        return;
      }

      /* 没过阈值 → 弹回原位（160ms）。--snapdur 让这一段比正式切牌更短。 */
      slotEl.style.setProperty('--snapdur', DUR_SNAP + 'ms');
      slotEl.classList.add('snapping');
      requestAnimationFrame(function () {
        setDx(0);
        setTimeout(function () {
          slotEl.classList.remove('snapping');
          slotEl.classList.remove('peek');
          slotEl.style.removeProperty('--snapdur');
        }, DUR_SNAP);
      });
    }
    tableEl.addEventListener('pointerup', end);
    tableEl.addEventListener('pointercancel', end);
  }

  /* ---------------- 评分规则弹窗 ---------------- */

  function openRule() {
    var bs = (S.data && S.data.boards) || [];
    var host = $('#ruleTracks');
    host.innerHTML = bs.map(function (b) {
      return '<div class="dlg-tr"><span style="color:' + b.color + ';margin:0">' + sym(b.id, 14) + '</span>' +
        '<b style="color:' + b.color + '">' + esc(b.name) + '</b>' +
        '<span>' + esc(b.def) + '</span></div>';
    }).join('');
    $('#ruleMask').hidden = false;
  }
  function closeRule() { $('#ruleMask').hidden = true; }

  /* ---------------- 等比缩放（--k） ----------------
   * 与 app.js 的 fitStage 同一套口径与同一个断点 760；
   * 浮层里 --k 由 board.css 强制成 1（榜单在浮层就是 722 的设计）。 */
  function fitStage() {
    var de = document.documentElement;
    if (de.classList.contains('embed')) return;
    var w = de.clientWidth;
    var pad = 24 * 2;
    var k = Math.min(1, (w - pad) / 1440);
    if (w <= 760) k = 1;   // 窄屏交给 CSS 流式版式，不再等比缩
    de.style.setProperty('--k', k.toFixed(4));
  }

  /* ---------------- 启动 ---------------- */

  function paint() {
    paintFeature(); paintStrip();
    /* 有 track 锚（刷新 / 从详情链接进来）就对齐赛道再停到详情 */
    if (S.trackId && board()) {
      var bs = (S.data && S.data.boards) || [];
      for (var i = 0; i < bs.length; i++) {
        if (bs[i].id === S.trackId) { S.fidx = i; break; }
      }
      paintFeature(); paintStrip();
      if (board().top.length) { viewDeal.hidden = true; showDetail(); }
      else { S.trackId = null; showDeal(); }
    } else {
      if (S.trackId) S.trackId = null;
      showDeal();
    }
    paintSys();
    paintRangeCard();
  }

  /* ---------------- 榜期卡（v2，见 spec §6.7）----------------
   * 它替掉原来那个 `.seg` iOS 分段控件。**要解决的不是好看，是信息量为零**：
   *   · 日榜 = 今天 0 点起；周榜 = 7 天前这一刻（**不是自然周**，见 board-core.mjs:92）
   *   · 实测 117 vs 730 条扫描 —— 差 6 倍，但界面上一个字都没提
   *   · 分布也完全不同（嘴硬榜 2 vs 0 张），点进去才看出「暂无上榜」，像出了 bug
   * 所以卡上摊开三层：时间窗 / 规模 / 状态；展开后再给一张同赛道两榜对照表。 */
  var RANGES = [
    { id: 'day', tag: '日榜', win: '今天 00:00 → 现在' },
    { id: 'week', tag: '周榜', win: '7 天前 → 现在' },
  ];
  /* 两档各自的规模摘要。展开面板要拿它们并排对照，
   * 所以在切档时顺手把「对面那档」也读一次（只读缓存，不触发评分）。
   * ⚠️ key 一律用**档位 id**。曾经这里读 `peerCache[S.range]` 而下面存
   *    `peerCache[peer.id]` → 读写两个 key → 对面列永远 `—`，且**不抛异常**。 */
  var peerCache = {};   // { day|week: 对面档的响应体 或 null(没缓存) }
  var peerBusy = {};    // 在途标记，**别挂在 RANGES 对象上**（换档会串味）

  function rngCur() {
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].id === S.range) return RANGES[i];
    return RANGES[0];
  }
  function rngPeer() {
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].id !== S.range) return RANGES[i];
    return RANGES[1];
  }
  function rngStats(d) {
    if (!d || !d.boards) return null;
    var n = 0;
    for (var i = 0; i < d.boards.length; i++) n += (d.boards[i].top || []).length;
    return { scanned: d.scanned || 0, cards: n, tracks: d.boards.length };
  }

  /* 收起态那张卡。⛰ 三种状态要能一眼分辨：就绪 / 评分中 / 失败。 */
  function paintRangeCard() {
    var cur = rngCur();
    $('#rngTag').textContent = cur.tag;
    $('#rngL1').textContent = cur.win;

    var card = $('#rngCard');
    card.classList.remove('is-building', 'is-failed');

    var l2 = $('#rngL2'), ico = $('#rngIco');
    if (S.status === 'failed') {
      card.classList.add('is-failed');
      var d0 = S.data && new Date(S.data.generatedAt || Date.now());
      l2.textContent = d0 ? (fmtMD(d0) + ' 那次结果') : '暂无数据';
      ico.textContent = '!';
      return;
    }
    if (S.status === 'building') {
      card.classList.add('is-building');
      var p = S.progress || {};
      if (p.phase === 'scan') {
        l2.textContent = '正在扫描 · ' + (p.scanned || 0) + ' 条';
      } else if (p.phase === 'score') {
        l2.textContent = '正在评分 ' + (p.done || 0) + '/' + (p.candidates || 0) + ' 条';
      } else {
        l2.textContent = '正在取数…';
      }
      ico.textContent = '';
      return;
    }

    var st = rngStats(S.data);
    if (!st) { l2.textContent = '正在取数…'; ico.textContent = '⇄'; return; }
    l2.textContent = '已扫 ' + st.scanned + ' 条 · 共 ' + st.cards + ' 张';
    if (S.data.mock) l2.textContent += ' · 演示';
    ico.textContent = '⇄';
  }
  function fmtMD(d) {
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* 展开面板：同赛道 · 两榜并排。
   * ⭐ 这是本次改版最实质的一处 —— 旧设计只让用户「选看哪一档」，
   *    新设计让他在**切换前**就看清两档差在哪。 */
  function paintRangePop() {
    var a = S.data;                      // 当前档
    var peer = rngPeer();
    /* ⚠️ key 必须统一按「档位 id」取，且是 **对面那档**（peer.id），不是当前档。
     *   踩过一次：这里写 peerCache[S.range] 而 loadPeer() 存 peerCache[peer.id]
     *   → 读写两个不同 key → 对面列永远 undefined，且不抛异常。 */
    var p = peerCache[peer.id];
    var ids = [], i;
    if (a && a.boards) for (i = 0; i < a.boards.length; i++) ids.push(a.boards[i].id);
    if (p && p.boards) for (i = 0; i < p.boards.length; i++) {
      if (ids.indexOf(p.boards[i].id) < 0) ids.push(p.boards[i].id);
    }
    function find(d, id) {
      if (!d || !d.boards) return null;
      for (var j = 0; j < d.boards.length; j++) if (d.boards[j].id === id) return d.boards[j];
      return null;
    }

    var h = '';
    for (i = 0; i < ids.length; i++) {
      var ba = find(a, ids[i]), bb = find(p, ids[i]);
      var na = ba ? (ba.top || []).length : null;
      var nb = bb ? (bb.top || []).length : null;
      var name = (ba || bb || {}).name || ids[i];

      /* 差异文案。⚠️ 嘴硬榜「日 2 / 周 0」这种必须显式点出来：
       *   它是**数据事实**（分布天然偏斜，spec §11.6），不是加载失败。 */
      var x, cls = '';
      if (na === null || nb === null) {
        x = '尚未生成'; cls = ' is-pending';
      } else if (nb === 0 && na > 0) {
        x = peer.tag + '空榜'; cls = ' is-empty';
      } else if (na === 0 && nb > 0) {
        x = '本档空榜'; cls = ' is-empty';
      } else if (nb > na) {
        x = peer.tag + '多 ' + (nb - na) + ' 张'; cls = ' is-more';
      } else if (na > nb) {
        x = '本档多 ' + (na - nb) + ' 张'; cls = ' is-more';
      } else {
        x = '持平';
      }
      /* 行 = 切到那一档的入口（点了直接换档）。
       * `peerside` 标出点下去会看到的是哪一档，避免「点行却没反应」的困惑。 */
      h += '<div class="rng-row' + cls + '" role="button" tabindex="0"' +
           ' data-range="' + (cls.indexOf('is-pending') >= 0 ? '' : peer.id) + '"' +
           ' title="' + (cls.indexOf('is-pending') >= 0 ? '该档尚未生成' : '切到' + peer.tag) + '">' +
           '<span class="rng-row-n">' + esc(name) + '</span>' +
           '<span class="rng-row-d">' + (na === null ? '—' : na) + '</span>' +
           '<span class="rng-row-w">' + (nb === null ? '—' : nb) + '</span>' +
           '<span class="rng-row-x">' + esc(x) + '</span></div>';
    }
    $('#rngRows').innerHTML = h || '<div class="rng-row"><span class="rng-row-x">正在取数…</span></div>';

    var sa = rngStats(a), sb = rngStats(p);
    var sum = '<span class="rng-row-n">合计</span>' +
      '<span class="rng-row-d">' + (sa ? sa.cards : '—') + '</span>' +
      '<span class="rng-row-w">' + (sb ? sb.cards : '—') + '</span>' +
      '<span class="rng-row-x">扫描 ' +
      (sa ? sa.scanned : '—') + ' → ' + (sb ? sb.scanned : '—') + ' 条</span>';
    $('#rngSum').innerHTML = sum;
  }

  function toggleRangePop(force) {
    var pop = $('#rngPop'), card = $('#rngCard');
    var open = force === undefined ? pop.hidden : force;
    pop.hidden = !open;
    card.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { paintRangePop(); loadPeer(); }
  }

  /* 只读对面那档的缓存，**绝不触发评分** —— 否则「看一眼周榜」就要烧 100 秒 + token。
   * ⚠️ 必须走 `peek=1`（后端短路成纯读盘）。走普通 /api/board 会触发 ensure()
   *    → 翻 45 页 + 一两分钟，那是对「瞥一眼」的严重惩罚。
   * 没缓存 → status 'none' → 面板显示「尚未生成」，**不能当成 0 张**。 */
  function loadPeer() {
    var peer = rngPeer();
    if (peerCache[peer.id] !== undefined || peerBusy[peer.id]) return;
    peerBusy[peer.id] = true;
    var url = 'api/board?range=' + peer.id + '&peek=1' +
              (q.get('mock') === '1' ? '&mock=1' : '');
    var ai = localAiCfg();
    var init = { cache: 'no-store' };
    if (ai) {
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify({ ai: ai, peek: true });
    }
    fetch(url, init).then(function (r) { return r.json(); }).then(function (j) {
      peerBusy[peer.id] = false;
      peerCache[peer.id] = (j && j.status === 'ready' && j.boards && j.boards.length) ? j : null;
      if (!$('#rngPop').hidden) paintRangePop();
    }).catch(function () {
      peerBusy[peer.id] = false; peerCache[peer.id] = null;
      if (!$('#rngPop').hidden) paintRangePop();
    });
  }

  function switchRange(r) {
    if (r === S.range) { toggleRangePop(false); return; }
    S.range = r;
    S.trackId = null; S.idx = 0; S.fidx = 0; S.data = null;
    q.set('range', r); q.delete('track');
    history.replaceState(null, '', location.pathname + '?' + q.toString());
    toggleRangePop(false);
    paintRangeCard();
    viewDeal.hidden = false; viewDetail.hidden = true;
    load(false);
  }

  function bind() {
    /* 日榜 / 周榜 —— 点榜期卡开合，点面板里的行切换 */
    $('#rngCard').addEventListener('click', function () { toggleRangePop(); });
    $('#rngRows').addEventListener('click', function (e) {
      var r = e.target.closest('[data-range]');
      if (!r || !r.getAttribute('data-range')) return;
      switchRange(r.getAttribute('data-range'));
    });
    /* 行是 role=button，所以 Enter / Space 也要能触发 */
    $('#rngRows').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var r = e.target.closest('[data-range]');
      if (!r || !r.getAttribute('data-range')) return;
      e.preventDefault();
      switchRange(r.getAttribute('data-range'));
    });
    document.addEventListener('click', function (e) {
      if ($('#rngPop').hidden) return;
      if (e.target.closest('#rng')) return;
      toggleRangePop(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#rngPop').hidden) { toggleRangePop(false); $('#rngCard').focus(); }
    });

    $('#btnFresh').addEventListener('click', function () {
      var b = this;
      b.disabled = true;
      load(true);
      setTimeout(function () { b.disabled = false; }, 2500);
    });

    /* 首页大牌台：**只有点中大牌本身**才进详情；
     * 牌子左右两侧（箭头 + 箭头周围的空白）一律「切赛道」——
     * 点左半区 = 上一个榜，点右半区 = 下一个榜。
     * ⚠️ 箭头不单独绑 click，全走这一处委托：单独绑 + 冒泡会双触发；
     *    而且 disabled 的 button 不派发事件，会变成「点空白能切、点箭头没反应」。 */
    ftableEl.addEventListener('click', function (e) {
      if (S.busy) return;
      if (e.target.closest('.fslot')) {
        var bs = (S.data && S.data.boards) || [];
        if (bs[S.fidx]) openTrack(bs[S.fidx].id);
        return;
      }
      /* 箭头按自身语义走方向（键盘 Enter 触发的 click 没有坐标，clientX=0）；
       * 空白区按「落在牌子左半还是右半」决定方向 */
      var rt = e.target.closest('.round');
      if (rt) { fstep(rt.id === 'fPrev' ? -1 : 1); return; }
      var r = fslotEl.getBoundingClientRect();
      fstep(e.clientX < r.left + r.width / 2 ? -1 : 1);
    });
    fslotEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      var bs = (S.data && S.data.boards) || [];
      if (bs[S.fidx] && !S.busy) openTrack(bs[S.fidx].id);
    });
    /* 小卡条：点谁切谁；跨多张直接落位（见 fslideTo） */
    stripEl.addEventListener('click', function (e) {
      var c = e.target.closest('.fchip');
      if (!c || S.busy) return;
      var j = Number(c.getAttribute('data-j'));
      if (!(j >= 0) || j === S.fidx) return;
      fslideTo(j, j > S.fidx ? 1 : -1);
    });
    /* 箭头不单独绑 click —— 见上面 ftable 的委托注释 */

    $('#btnBack').addEventListener('click', closeDetail);
    $('#btnRule').addEventListener('click', openRule);
    $('#ruleClose').addEventListener('click', closeRule);
    $('#ruleMask').addEventListener('click', function (e) { if (e.target === this) closeRule(); });

    bindTrack();
    bindSwipe();

    window.addEventListener('resize', function () { fitStage(); });
    if (window.ResizeObserver) new ResizeObserver(fitStage).observe(document.body);
  }

  function boot() {
    fitStage();
    paintRangeCard();
    bind();
    /* 首屏先摆出大牌的空壳（避免「正在评分」时下面一片空白） */
    if (!S.data) {
      fslotEl.innerHTML = '';
      stripEl.innerHTML = '';
      paintSys();
    }
    load(false);
  }

  boot();
})();

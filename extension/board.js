/* board.js — 魔鬼榜单前端
 *
 * 三层：六摞牌（首页）→ 赛道详情 → 逐张切牌。
 * 口径全部对齐 docs/devil-board-spec.md 第六、七节；落地时踩到的两个关键点：
 *
 *  1) **条数不固定（1~N）**：封面牌刻意不写数字；面包屑「共 N 张」、进度「第 x / 共 N 张」
 *     两个数字都动态；缩略进度是「固定宽轨道里放 N 个卡」（超出横滚），不是固定几格。
 *  2) **三种换法完全等价**：点箭头 / 键盘 ← → / 左右滑动。滑动跟手（松手前不播动画），
 *     阈值 = 牌宽 25%，拖动时箭头淡出让位。
 *
 * 发牌动画用「飞行层 + clone」：把被点那摞的封面牌克隆一份、钉在它的实测坐标上，
 * 再按 translate + scale 飞到牌台中央。两张牌同为 1:1.4，所以等比缩放不会变形，
 * 落位时与大牌矩形严丝合缝 —— 再交叉淡化换掉内容，看不到跳变。
 */
(function () {
  'use strict';

  var q = new URLSearchParams(location.search);
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  /* 封面牌的设计尺寸（= board.css 的 --cover-w / --cover-h）。
   * ⚠️ 必须和 CSS 对齐：飞行层拿不到 .board 上的变量，只能在这里写一份。
   *    202x283 = **1:1.4 纸牌比例**（与详情大牌同比例 → 发牌单轴等比缩放即可）。 */
  var COVER_W = 202;
  var COVER_H = 283;

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

  /* ---------------- 状态 ---------------- */
  var S = {
    range: q.get('range') === 'week' ? 'week' : 'day',
    data: null,
    status: 'idle',      // idle | building | ready | failed
    progress: null,
    err: null,
    trackId: q.get('track') || null,
    idx: 0,
    busy: false,         // 正在播切牌/发牌动画
  };

  var deckEl = $('#deck'), slotEl = $('#slot'), trackEl = $('#track');
  var viewDeal = $('#viewDeal'), viewDetail = $('#viewDetail'), sysEl = $('#sys');
  var tableEl = $('#table'), flyLayer = $('#flyLayer'), boardEl = $('#board');

  function board() {
    if (!S.data) return null;
    for (var i = 0; i < S.data.boards.length; i++) {
      if (S.data.boards[i].id === S.trackId) return S.data.boards[i];
    }
    return null;
  }
  function motion() { return !reduceMotion; }

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

  function load(fresh) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    setStatus('building', { progress: S.progress, err: null });
    fetchBoard(fresh).then(function (j) {
      if (j && j.status === 'building') {
        S.data = j.boards && j.boards.length ? j : S.data;
        setStatus('building', { progress: j.progress });
        /* 「评分中」要能看见进度，所以轮询 —— 一次全量抓取 + 打分要一两分钟，
         * 界面必须让人知道它在动，而不是死了。 */
        pollTimer = setTimeout(function () { load(false); }, 1300);
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

    if (st === 'building' && !S.data) {
      show = true; ico = RING; title = '正在评分';
      var p = S.progress || {};
      if (p.phase === 'score') {
        var done = p.done || 0, tot = p.candidates || 0;
        sub = '已扫描 ' + (p.scanned || 0) + ' 条 · 筛出 ' + tot + ' 条候选 · 打分 ' + done + '/' + tot;
        bar = true;
        $('#sysBarIn') && ($('#sysBarIn').style.width = (tot ? Math.round(done / tot * 100) : 4) + '%');
      } else {
        sub = '正在翻沸点流…已扫描 ' + ((p.scanned || 0)) + ' 条 · 第 ' + (p.pages || 1) + ' 页';
        bar = true;
        $('#sysBarIn') && ($('#sysBarIn').style.width = Math.min(96, (p.pages || 1) * 6) + '%');
      }
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
  function coverHTML(b) {
    var empty = !b.top || !b.top.length;
    var best = empty ? null : b.top[0];
    return '' +
      '<div class="cover-top">' +
        '<span class="left" style="color:' + b.color + '">' +
          '<span style="display:flex">' + sym(b.id, 13) + '</span>' +
          '<b class="cover-rank">' + (empty ? '0' : '1') + '</b>' +
        '</span>' +
        '<b class="cover-score">' + (empty ? '—' : best.score.toFixed(1)) + '</b>' +
      '</div>' +
      '<div class="cover-name" style="color:' + b.color + '">' + esc(b.name) + '</div>' +
      '<div class="cover-fig" style="background-image:url(cards/' + CARD_CHAR[b.id] + '.png)"></div>' +
      '<div class="cover-def">' + esc(b.def) + '</div>' +
      '<div class="cover-go">' +
        '<span style="display:flex;color:' + b.color + '">' + sym(b.id, 10) + '</span>' +
        (empty ? '暂无上榜' : '点击进入 →') +
      '</div>';
  }

  function paintDeck() {
    var bs = (S.data && S.data.boards) || [];
    deckEl.innerHTML = bs.map(function (b) {
      var empty = !b.top || !b.top.length;
      return '<div class="stack' + (empty ? ' empty' : '') + '" data-track="' + b.id + '" role="button" ' +
        'tabindex="0" aria-label="' + esc(b.name) + (empty ? '（暂无上榜）' : '，' + b.top.length + ' 张') + '">' +
        '<span class="stack-face f0"></span>' +
        '<span class="stack-face f1"></span>' +
        '<span class="stack-face f2"></span>' +
        '<div class="cover">' + coverHTML(b) + '</div>' +
      '</div>';
    }).join('');
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
   *    （v0.5.1 那版封面是 1:1.218、大牌 1:1.4，比例不同才需要分轴。） */
  function makeFlyer(coverEl, from, to) {
    var flyer = document.createElement('div');
    flyer.className = 'flyer';
    flyer.style.left = from.left + 'px';
    flyer.style.top = from.top + 'px';
    flyer.style.width = COVER_W + 'px';
    flyer.style.height = COVER_H + 'px';
    flyer.innerHTML = coverEl.outerHTML;
    /* 视觉尺寸 = 设计尺寸 x k → scale 就是「视觉宽 / 设计宽」；同比例所以只算宽度 */
    flyer.style.setProperty('--s0', (from.width / COVER_W).toFixed(4));
    flyer.style.setProperty('--s', (to.width / COVER_W).toFixed(4));
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
    var stack = deckEl.querySelector('.stack[data-track="' + trackId + '"]');
    if (!stack) return;
    S.busy = true;
    S.trackId = trackId;
    S.idx = 0;

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

    var cover = stack.querySelector('.cover');
    var from = cover.getBoundingClientRect();
    var to = cardRect();
    /* 空榜：没有大牌可落，就地淡出 */
    if (!board() || !board().top.length) to = from;

    /* 0ms 按下 → 整摞 scale .97 下沉；80ms 顶牌抽出、另两张淡出；180ms 飞；320ms 落位 */
    stack.classList.add('press');
    deckEl.classList.add('leaving');
    stack.classList.add('taken');

    var flyer = makeFlyer(cover, from, to);

    setTimeout(function () {
      viewDetail.style.opacity = '';
      viewDeal.hidden = true;
      deckEl.classList.remove('leaving');
      stack.classList.remove('press', 'taken');
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
    var track = S.trackId;
    var stack = deckEl.querySelector('.stack[data-track="' + track + '"]');
    if (!stack || !motion()) { backToDeal(); return; }
    S.busy = true;

    var from = cardRect();
    /* 牌堆视图先「摆出来但不显示」，否则量不到封面牌的位置 */
    viewDeal.hidden = false;
    viewDeal.style.opacity = '0';
    stack.classList.remove('press', 'taken');
    var to = stack.querySelector('.cover').getBoundingClientRect();

    var big = slotEl.querySelector('.bigcard');
    if (big) { big.style.transition = 'opacity 120ms linear'; big.style.opacity = '0'; }

    var flyer = makeFlyer(stack.querySelector('.cover'), to, from);
    flyer.classList.add('back');

    setTimeout(function () {
      flyer.remove();
      if (big) { big.style.transition = ''; big.style.opacity = ''; }
      viewDetail.hidden = true;
      /* 其余五摞跟着牌一起淡回来 */
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
    var stack = deckEl.querySelector('.stack[data-track="' + S.trackId + '"]');
    if (stack) stack.classList.remove('press', 'taken');
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
   * 走到头再落数据（换 idx、重排三张卡），所以交接过程牌台一直是满的。 */
  function slideTo(ni, d, dur) {
    if (!motion()) { S.idx = ni; paintDetail(); return; }
    S.busy = true;
    var dist = slotEl.offsetWidth + 16;
    slotEl.style.setProperty('--peek', '1');
    slotEl.classList.add('peek');
    setDx(0);
    void slotEl.offsetWidth;
    setDx(-d * dist);
    setTimeout(function () {
      S.idx = ni;
      setDx(0, true);
      slotEl.classList.remove('peek');
      paintDetail();
      S.busy = false;
    }, dur);
  }

  function bindArrows() {
    $('#btnPrev').addEventListener('click', function () { step(-1); });
    $('#btnNext').addEventListener('click', function () { step(1); });
  }
  bindArrows();

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
    if (viewDetail.hidden) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
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
        /* 过阈值：接着走完 320ms（当前已经在 dx 上，直接推到终点即可） */
        S.busy = true;
        setDx(-d * (cardW + 16));
        setTimeout(function () {
          S.idx = ni;
          setDx(0, true);
          slotEl.classList.remove('peek');
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
    paintDeck();
    /* 有 track 锚（刷新 / 从详情链接进来）就直接停在详情 */
    if (S.trackId && board()) {
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
    S.trackId = null; S.idx = 0; S.data = null;
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

    deckEl.addEventListener('click', function (e) {
      var st = e.target.closest('.stack');
      if (st) openTrack(st.getAttribute('data-track'));
    });
    deckEl.addEventListener('keydown', function (e) {
      var st = e.target.closest('.stack');
      if (st && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTrack(st.getAttribute('data-track')); }
    });

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
    /* 首屏先摆出六摞的空壳（避免「正在评分」时下面一片空白） */
    if (!S.data) {
      deckEl.innerHTML = '';
      paintSys();
    }
    load(false);
  }

  boot();
})();

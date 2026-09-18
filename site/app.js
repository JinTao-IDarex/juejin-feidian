/* app.js — 沸点抽卡 · 磨砂玻璃版
 * 数据来自 data.js（window.PINS_DATA.pins，60 条 0917 真实沸点 + 配对点评）
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

  var S = { order: [], pos: 0, liked: {}, seen: {} };

  /* ---------------- 本地进度 ---------------- */
  function loadLocal() {
    try {
      var raw = localStorage.getItem(LKEY);
      if (!raw) return;
      var v = JSON.parse(raw);
      S.liked = v.liked || {};
      S.seen = v.seen || {};
    } catch (e) { /* 隐私模式 / 数据损坏：静默降级 */ }
  }
  function saveLocal() {
    try {
      localStorage.setItem(LKEY, JSON.stringify({ liked: S.liked, seen: S.seen }));
    } catch (e) { /* 配额满：不影响抽卡 */ }
  }

  /* ---------------- 工具 ---------------- */
  var toastTimer;
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

  /* 主卡线稿插画：牌叠 + 蓝色点缀 + 对话气泡
   * 对齐设计稿 7:2（220x150 画布）：
   *   背牌 92x62 旋转 -9°、描边；正牌 92x62 旋转 7°、填充浅蓝、三条横线；
   *   左上蓝色四角星；右下白色对话泡 + 两条蓝线。
   */
  var ILLUS =
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
        '<div class="illus">' + ILLUS + '</div>' +
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
    return '' +
      '<span class="badge">' + ICON_BOLT + 'AI 点评</span>' +
      '<div class="roast"><span>' + esc(p.roast || '（这条还没配点评）') + '</span></div>' +
      '<button class="copy" id="btnCopy">' + ICON_COPY + '复制这句去评论</button>' +
      '<div class="note">毒的是现象，不是你。</div>';
  }

  /* ---------------- 渲染 ---------------- */
  function render(anim) {
    var host = $('#cards');
    var ai = $('#ai');
    if (!S.order.length) {
      host.innerHTML = '<div class="empty"><b>牌堆是空的</b>' +
        '<span>把 site/data.js 放进来就有牌了。</span></div>';
      if (ai) ai.innerHTML = '';
      updateHud();
      return;
    }

    var idx = S.order[S.pos];
    var p = PINS[idx];
    var prev = S.order[S.pos - 1] != null ? PINS[S.order[S.pos - 1]] : null;
    var next = S.order[S.pos + 1] != null ? PINS[S.order[S.pos + 1]] : null;
    if (!prev && S.order.length > 1) prev = PINS[S.order[S.order.length - 1]];
    if (!next && S.order.length > 1) next = PINS[S.order[0]];

    host.innerHTML = ghostCard(prev, 'left', anim) + mainCard(p, idx, anim) + ghostCard(next, 'right', anim);
    if (ai) {
      ai.innerHTML = aiCard(p);
      ai.classList.toggle('anim-in', !!anim);
    }

    if (anim) {
      [host.querySelector('.main'), ai,
       host.querySelector('.ghost.left'), host.querySelector('.ghost.right')]
        .forEach(function (el) { if (el) void el.offsetWidth; });
    }

    S.seen[p.id] = true;
    saveLocal();
    updateHud();
    bindAI();
  }

  /* 「复制这句去评论」的事件绑定。
   * 关键：render() 每次都把 #ai 的 innerHTML 整个换掉，旧按钮随旧 DOM 一起销毁，
   * 所以必须在每次 render 之后重新绑一次——只绑一次的话，翻第二张按钮就失效了。
   */
  function bindAI() {
    var cp = $('#btnCopy');
    if (!cp) return;
    cp.onclick = function () {
      var p = PINS[S.order[S.pos]];
      if (!p) return;
      if (!p.roast) { toast('这条还没配点评'); return; }
      copyText(p.roast).then(function () { toast('点评已复制，去评论区粘上'); });
    };
  }

  function updateHud() {
    var total = S.order.length;
    $('#progText').textContent = total
      ? '第 ' + (S.pos + 1) + ' / ' + total + ' 张 · 已看 ' + seenCount() + ' · 喜欢 ' + likedCount()
      : '第 0 / 0 张 · 已看 0 · 喜欢 0';
    $('#btnPrev').disabled = total === 0 || S.pos === 0;
    $('#btnNext').disabled = total === 0;
  }

  /* ---------------- 翻牌 ---------------- */
  function go(delta) {
    if (!S.order.length) return;
    var n = S.pos + delta;
    if (n < 0) { toast('已经是第一张了'); return; }
    if (n >= S.order.length) {
      shuffleOrder(); S.pos = 0; render(true);
      toast('这副牌抽完了，重新洗一副');
      return;
    }
    S.pos = n;
    render(true);
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
   */
  var DESIGN_W = 1440;
  function fitStage() {
    var wrap = document.querySelector('.page-wrap');
    if (!wrap) return;
    if (window.matchMedia && window.matchMedia('(max-width:1120px)').matches) {
      document.documentElement.style.setProperty('--k', '1');
      return;
    }
    var avail = wrap.clientWidth;
    if (!avail) return;
    var k = Math.min(1, avail / DESIGN_W);
    document.documentElement.style.setProperty('--k', String(Math.round(k * 1000) / 1000));
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    $('#btnNext').onclick = function () { go(1); };
    $('#btnPrev').onclick = function () { go(-1); };

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(fitStage, 80);
    });
    var mq = window.matchMedia ? window.matchMedia('(max-width:1120px)') : null;
    if (mq) {
      var onmq = function () { fitStage(); };
      if (mq.addEventListener) mq.addEventListener('change', onmq);
      else if (mq.addListener) mq.addListener(onmq);
    }
    fitStage();

    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      var ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON') ae.blur();

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

  /* ---------------- 启动 ---------------- */
  function boot() {
    loadLocal();
    if (!PINS.length) {
      $('#cards').innerHTML = '<div class="empty"><b>没读到牌面数据</b>' +
        '<span>确认 site/data.js 和 index.html 在同一目录。<br>' +
        '如果直接双击打开，部分浏览器会拦截本地文件读取。</span></div>';
      updateHud();
      return;
    }
    rebuild();
    render(true);
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

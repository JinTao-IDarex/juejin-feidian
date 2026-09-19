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
    return '' +
      '<span class="badge">' + ICON_BOLT + 'AI 点评</span>' +
      '<div class="roast"><span>' + esc(p.roast || '（这条还没配点评）') + '</span></div>' +
      '<button class="copy" id="btnCopy">' + ICON_COPY + '复制这句去评论</button>' +
      '<div class="note">毒的是现象，不是你。</div>';
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
      ai.innerHTML = aiCard(p);
      /* #ai 是常驻元素（不是像卡片那样随 innerHTML 重建），
       * 如果只是 classList.toggle('anim-in', true)，类名已经在身上，
       * 动画不会被重新触发——从第二次翻页开始 AI 卡就静止了。
       * 必须先摘掉类、强制 reflow、再加回，才能让动画每次都重新起跑。 */
      ai.classList.remove('anim-in');
      if (anim) { void ai.offsetWidth; ai.classList.add('anim-in'); }
    }

    S.seen[p.id] = true;
    saveLocal();
    updateHud();
    syncDock(p, idx);
    bindAI();
  }

  /* 迷你卡片（dock）内容同步：牌号与主卡左下角大数字一致（原始序号），
   * 纸牌式布局有左上/右下两个牌号角，一起更新；
   * 标题沿用主卡的拆分逻辑——有话题取话题，无话题取正文开头。
   * 收起状态下盲翻时给卡面一个短促的 tick 反馈，提示牌面已换。 */
  function syncDock(p, idx) {
    var nums = document.querySelectorAll('.dock .dc-num');
    for (var i = 0; i < nums.length; i++) nums[i].textContent = pad(idx + 1);
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
      var tag = (e.target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      var ae = document.activeElement;
      if (ae && ae.tagName === 'BUTTON') ae.blur();

      /* Esc 随时可收起；M 随时可切换静音（含收起状态） */
      if (e.key === 'Escape') { setFolded(true); return; }
      if (e.key === 'm' || e.key === 'M') { setMuted(!S.muted); return; }
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
    /* 首屏传 false：不播入场动画。
     * 相邻位交换模型下，首屏没有「从上一张翻过来」的语义，
     * 静止呈现更稳，动画只留给真正的翻页动作（go() 里始终传 true）。 */
    render(false, 0);
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

/* app.js — 沸点抽卡 · 牌面层（扑克牌面，浅色）
 * 两张牌并排：左 = 沸点原文，右 = AI 犀利解析。
 * 点数由热度（赞 + 评论×2）映射：A 2 3 … 10 J Q K。
 * 三种打开方式共用这一份：
 *   ?embed=1          被 content script 注入的浮层 iframe 引用（牌后面铺一层遮罩）
 *   （无参数）         独立窗口 / 独立标签页（自己铺浅色底）
 */
const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (v) => {
  if (chrome.runtime.lastError) r({ ok: false, error: chrome.runtime.lastError.message });
  else r(v || { ok: false, error: '空响应' });
}));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => (n < 10 ? '0' + n : '' + n);

const QS = new URLSearchParams(location.search);
const EMBED = QS.get('embed') === '1';
const TOKEN = QS.get('t') || '';     // 宿主 frame.js 给的回执令牌，避免认错父窗口

function fmt(ts) {
  if (!ts) return '';
  const diff = (Date.now() / 1000) - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  const d = new Date(ts * 1000);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 热度 -> 牌面点数 */
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function heat(p) { return (p.digg || 0) + (p.cmt || 0) * 2 + (p.pics && p.pics.length ? 1 : 0); }
function rankOf(p) {
  const list = S.pins.slice().sort((a, b) => heat(a) - heat(b));
  const i = list.findIndex((x) => x.id === p.id);
  const n = list.length || 1;
  const tier = Math.min(RANKS.length - 1, Math.floor((i / n) * RANKS.length));
  return RANKS[tier];
}

let toastTimer;
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2000);
}
function copyText(txt) {
  return navigator.clipboard.writeText(txt).catch(() => {
    const a = document.createElement('textarea'); a.value = txt; a.style.position = 'fixed';
    a.style.opacity = '0'; document.body.appendChild(a); a.select();
    document.execCommand('copy'); a.remove();
  });
}
const isEmpty = (v) => !v || !v.trim();
const isTop = () => { try { return window.top === window; } catch (e) { return false; } };

/** 关闭牌面层：被注入的浮层 -> 通知父页面；独立窗口 -> 关掉自己 */
function closeSelf() {
  if (EMBED || window.parent !== window) {
    try { window.parent.postMessage({ token: TOKEN, type: 'pin-gacha-close' }, '*'); } catch (e) {}
  } else {
    window.close();
  }
}

/** 打开原文 / 外链：浮层里 window.open 可能被拦，交给宿主页面处理 */
function openLink(url) {
  if (EMBED) {
    try { window.parent.postMessage({ token: TOKEN, type: 'pin-gacha-open-link', url }, '*'); return; } catch (e) {}
  }
  window.open(url, '_blank', 'noopener');
}

const S = {
  pins: [], roasts: {}, cfg: {}, meta: {}, seen: [],
  order: [], pos: 0, cur: null, curIdx: -1,
  personaPick: 0, liked: {}, cmted: {}, q: '',
};

const LKEY = 'gacha-local';
async function loadLocal() {
  const v = await new Promise((r) => chrome.storage.local.get(LKEY, (o) => r(o[LKEY] || {})));
  S.liked = v.liked || {}; S.cmted = v.cmted || {};
}
const saveLocal = () => chrome.storage.local.set({ [LKEY]: { liked: S.liked, cmted: S.cmted } });

/* ---------------- 数据 ---------------- */

async function boot() {
  await loadLocal();
  const st = await send({ type: 'getState' });
  if (!st || st.ok === false) { toast('扩展未就绪，去 chrome://extensions 重新加载一次'); return; }
  S.pins = st.pins; S.roasts = st.roasts; S.cfg = st.cfg; S.meta = st.meta; S.seen = st.seen;
  updateDateTag();
  if (!S.pins.length) {
    $('#stage').innerHTML = '<div class="boardEmpty"><div><b>牌堆是空的</b>正在抓取最新沸点…</div></div>';
    $('#prog').style.width = '0%';
    $('#mLeft').textContent = '0 / 0';
    await doRefresh(true);
  } else {
    shuffle(false);
  }
}
async function updateDateTag() {
  const nl = Object.values(S.liked).filter(Boolean).length;
  const el = $('#favN'); if (el) el.textContent = nl;
  const chip = $('#subChip');
  if (chip) chip.textContent = (S.cfg.autoFetch ? '每 ' + S.cfg.everyMinutes + ' 分自动抓' : '手动刷新');
}

function rebuild(kw) {
  const k = (kw || '').trim().toLowerCase();
  const all = S.pins.map((p, i) => i);
  S.order = k ? all.filter((i) => {
    const p = S.pins[i]; const r = S.roasts[p.id];
    const hay = (p.content + p.user + p.company + p.job + p.topics.join('') +
      (r ? r.roasts.map((x) => x.text).join('') : '')).toLowerCase();
    return hay.includes(k);
  }) : all;
  S.pos = 0;
}
function shuffle(notify) {
  rebuild(S.q);
  S.order.sort(() => Math.random() - 0.5);
  render(true);
  if (notify) toast('重新洗牌');
}

async function doRefresh(silent) {
  const b = $('#btnRefresh'); b.classList.add('spin');
  const r = await send({ type: 'refresh', opts: { pages: 2, limit: 20 } });
  b.classList.remove('spin');
  if (!r || r.ok === false) { toast('抓取失败：' + ((r && r.error) || '未知错误')); return; }
  const st = await send({ type: 'getState' });
  S.pins = st.pins; S.roasts = st.roasts; S.meta = st.meta;
  updateDateTag();
  rebuild(S.q);
  if (r.added) {
    const fresh = new Set((r.fresh || []).map((p) => p.id));
    S.order.sort((a, c) => (fresh.has(S.pins[c].id) ? 1 : 0) - (fresh.has(S.pins[a].id) ? 1 : 0));
    S.pos = 0;
    render(true);
    toast('抓到 ' + r.added + ' 条新沸点');
  } else if (!silent) {
    render(true); toast('没有新沸点，牌堆已是最新');
  }
}

/* ---------------- 渲染 ---------------- */

function cardShell(side, opts) {
  const cls = 'card ' + side + (opts.ai ? ' ai' : '') + (opts.anim ? ' deal' + (side === 'cardL' ? 'L' : 'R') : '');
  const suit = opts.ai ? '♠' : '◆';
  const rankCls = opts.ai ? 'rank-black' : 'rank-red';
  return '' +
    '<article class="' + cls + '">' +
      '<div class="idx tl ' + rankCls + '"><span class="rank">' + opts.rank + '</span><span class="suit">' + suit + '</span></div>' +
      '<div class="idx br ' + rankCls + '"><span class="rank">' + opts.rank + '</span><span class="suit">' + suit + '</span></div>' +
      (opts.slot ? '<div class="slotTag">' + opts.slot + '</div>' : '') +
      opts.inner +
    '</article>';
}

function render(anim) {
  const stage = $('#stage');
  if (!S.order.length) {
    stage.innerHTML = '<div class="boardEmpty"><div><b>' +
      (S.q ? '没搜到' : '牌堆是空的') + '</b>' +
      (S.q ? '换个词试试。' : '点左上角「⟳ 抓最新」发一把牌。') + '</div></div>';
    $('#prog').style.width = '0%'; $('#mLeft').textContent = '0 / 0';
    $('#mRight').textContent = '喜欢 ' + Object.values(S.liked).filter(Boolean).length +
      ' · 已评 ' + Object.values(S.cmted).filter(Boolean).length;
    S.cur = null;
    return;
  }
  const idx = S.order[S.pos];
  const p = S.pins[idx];
  S.cur = p; S.curIdx = idx;
  if (anim) S.personaPick = 0;

  const rank = rankOf(p);
  const long = p.content.length > 250;
  const pics = (p.pics || []).slice(0, 2);
  const left = cardShell('cardL', {
    anim: anim, rank: rank, slot: '原文',
    inner:
      '<div class="cHead"><b>' + esc(p.user) + '</b><span>' +
        esc([p.company, p.job].filter(Boolean).join(' · ') || '掘友') + '</span></div>' +
      '<div class="cBody">' +
        '<div class="txt' + (long ? ' scroll' : '') + '">' + esc(p.content) + '</div>' +
        (pics.length ? '<div class="pics">' + pics.map((u) =>
          '<img src="' + esc(u) + '" referrerpolicy="no-referrer">').join('') + '</div>' : '') +
        (p.topics.length ? '<div class="tags">' + p.topics.slice(0, 3).map((t) =>
          '<span class="tag"># ' + esc(t) + '</span>').join('') + '</div>' : '') +
      '</div>' +
      '<div class="cFoot"><div class="row"><span>赞 ' + p.digg + '</span><span>评 ' + p.cmt +
        '</span><span>' + fmt(p.ctime) + '</span>' +
        '<a href="' + esc(p.url) + '" target="_blank" rel="noreferrer" id="pLink">原文 ↗</a></div></div>',
  });
  stage.innerHTML = left + '<div class="cardHost" id="aiHost"></div>';
  renderAI(p, anim);

  $('#prog').style.width = ((S.pos + 1) / S.order.length * 100) + '%';
  $('#mLeft').textContent = (S.pos + 1) + ' / ' + S.order.length + ' · ' + rank;
  const nl = Object.values(S.liked).filter(Boolean).length;
  const nc = Object.values(S.cmted).filter(Boolean).length;
  $('#mRight').textContent = '喜欢 ' + nl + ' · 已评 ' + nc;
  $('#favN').textContent = nl;
  $('#btnLike').classList.toggle('liked', !!S.liked[p.id]);
  $('#btnLike').innerHTML = '♥ ' + (S.liked[p.id] ? '已喜欢' : '喜欢');
  document.documentElement.classList.toggle('embed', EMBED);
  $('#pLink').onclick = (e) => { e.preventDefault(); openLink(p.url); };
  send({ type: 'markSeen', ids: [p.id] });
}

function currentRoast(p) {
  const r = S.roasts[p.id];
  if (!r) return null;
  const list = r.roasts || [];
  return list[Math.min(S.personaPick, list.length - 1)] || list[0] || null;
}

function renderAI(p, anim) {
  const host = $('#aiHost');
  if (!host) return;
  const r = S.roasts[p.id];
  const list = r ? (r.roasts || []) : [];
  const cur = currentRoast(p);
  const rank = rankOf(p);

  let body, foot = '', state = '待生成', stateCls = '', actions = '';
  if (!r) {
    state = S.cfg.aiProvider === 'off' ? '未配置' : '待生成';
    body = '<p class="ph">' + (S.cfg.aiProvider === 'off'
      ? '还没接模型 API，去设置页填一个。'
      : '点下面「生成点评」，AI 现写一张。') + '</p>';
  } else {
    state = (r.model || 'AI');
    stateCls = ' ok';
    body = '<div class="ornament">◆ ◆ ◆</div>' +
      '<div class="roast">' + esc(cur ? cur.text : '（空）') + '</div>' +
      '<div class="ornament">◆ ◆ ◆</div>';
    foot = '<div class="personas">' + list.map((x, i) =>
      '<button class="persona' + (i === Math.min(S.personaPick, list.length - 1) ? ' on' : '') +
      '" data-i="' + i + '">' + esc(x.persona) + '</button>').join('') +
      ((r.tags && r.tags.length) ? r.tags.map((t) =>
        '<span class="persona tagpill">#' + esc(t) + '</span>').join('') : '') + '</div>' +
      '<div class="cardActs">' +
        '<button id="btnGen">重写</button>' +
        '<button id="btnCopyRoast">复制</button>' +
        '<button id="btnUseRoast">用这句评论</button>' +
        '<button id="btnBatch">补 5 条</button>' +
      '</div>';
  }
  if (!r) {
    actions = '<div class="cardActs"><button id="btnGen">生成点评</button>' +
      '<button id="btnBatch">补 5 条</button></div>';
  }

  host.innerHTML = cardShell('cardR', {
    anim: anim, rank: rank, ai: true,
    inner:
      '<div class="aiState' + stateCls + '">' + esc(state) + '</div>' +
      '<div class="cHead"><b>' + (r ? esc(cur ? cur.persona : '犀利解析') : '犀利解析') + '</b>' +
        '<span>' + (r ? 'AI 点评 · ' + fmt(Math.floor((r.at || 0) / 1000)) : '等待生成') + '</span></div>' +
      '<div class="cBody">' + body + '</div>' +
      '<div class="cFoot">' + foot + actions + '</div>',
  });

  const hostEl = $('#aiHost');
  hostEl.querySelectorAll('.persona[data-i]').forEach((el) => {
    el.onclick = () => { S.personaPick = +el.dataset.i; renderAI(p, false); };
  });
  const g = hostEl.querySelector('#btnGen');
  if (g) g.onclick = (e) => genRoast(p, !!r, e.target);
  const cp = hostEl.querySelector('#btnCopyRoast');
  if (cp) cp.onclick = () => { const c = currentRoast(p); if (c) copyText(c.text).then(() => toast('点评已复制')); };
  const ur = hostEl.querySelector('#btnUseRoast');
  if (ur) ur.onclick = () => openCmt(true);
  const bt = hostEl.querySelector('#btnBatch');
  if (bt) bt.onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = '补写中…';
    const out = await send({ type: 'roastBatch', n: 5 });
    const st = await send({ type: 'getState' });
    S.roasts = st.roasts;
    const ok = (out || []).filter((x) => x && x.ok).length;
    toast(ok ? '补好了 ' + ok + ' 条' : '没补成，检查 API 设置');
    renderAI(p, false);
  };
}

async function genRoast(p, force, btn) {
  if (S.cfg.aiProvider === 'off') { toast('先去设置页配置模型 API'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  const host = $('#aiHost');
  if (host) {
    const ph = host.querySelector('.ph');
    if (ph) ph.innerHTML = '<span class="spinner"></span>AI 正在写…';
    const st = host.querySelector('.aiState');
    if (st) { st.textContent = '生成中'; st.className = 'aiState'; }
  }
  const r = await send({ type: 'roast', id: p.id, force: !!force });
  if (!r || r.ok === false) {
    toast('点评失败：' + ((r && r.error) || ''));
    if (host) {
      const st = host.querySelector('.aiState');
      if (st) { st.textContent = '失败'; st.className = 'aiState err'; }
      const b = host.querySelector('.cBody');
      if (b) b.innerHTML = '<p class="ph">' + esc((r && r.error) || '生成失败') + '</p>';
    }
    return;
  }
  S.roasts[p.id] = r.roast;
  S.personaPick = 0;
  renderAI(p, false);
  toast(r.cached ? '用的是缓存点评' : 'AI 点评到手');
}

/* ---------------- 互动 ---------------- */

function openSheet(el) { $('#mask').classList.add('on'); el.classList.add('on'); }
function closeSheets() {
  $('#mask').classList.remove('on');
  $('#sheetCmt').classList.remove('on'); $('#sheetList').classList.remove('on');
}
function openCmt(useAI) {
  if (!S.cur) return;
  const p = S.cur;
  const cur = currentRoast(p);
  if (useAI && cur) $('#ta').value = cur.text;
  else if (useAI) toast('先给这张生成点评');
  $('#cmtState').textContent = '@ ' + p.user;
  openSheet($('#sheetCmt'));
  loadHotComments(p);
  if (useAI) setTimeout(() => $('#ta').focus(), 240);
}
async function loadHotComments(p) {
  const box = $('#hotCmts');
  box.innerHTML = '';
  const r = await send({ type: 'pinComments', id: p.id });
  const list = (r && r.data) || [];
  if (!list.length) return;
  box.innerHTML = list.slice(0, 4).map((c) => {
    const ci = c.comment_info || {}; const u = c.user_info || {};
    return '<div class="hc"><b>' + esc(u.user_name || '掘友') + '：</b>' +
      esc(String(ci.comment_content || '').slice(0, 70)) + '</div>';
  }).join('');
}
function openList() {
  const box = $('#favs');
  const items = Object.keys(S.liked).filter((k) => S.liked[k]);
  $('#listN').textContent = items.length + ' 张';
  if (!items.length) box.innerHTML = '<div class="empty">还没喜欢过任何一张。</div>';
  else {
    box.innerHTML = items.map((id) => {
      const p = S.pins.find((x) => x.id === id) || { content: '（已不在本地库里）', user: '', id };
      const r = S.roasts[id];
      const t = r && r.roasts && r.roasts[0] ? r.roasts[0].text : '';
      return '<div class="it" data-id="' + esc(id) + '">' +
        '<div><b>' + rankOf(p) + ' · ' + esc(p.user || '掘友') + '：' + esc(p.content.slice(0, 34)) + '</b>' +
        '<span>' + (t ? 'AI：' + esc(t) : esc(p.content.slice(0, 80))) + '</span></div>' +
        '<button class="rm" data-rm="' + esc(id) + '">×</button></div>';
    }).join('');
  }
  openSheet($('#sheetList'));
}

async function toggleLike() {
  if (!S.cur) return;
  const p = S.cur;
  S.liked[p.id] = !S.liked[p.id];
  saveLocal(); render(false);
  toast(S.liked[p.id] ? '已加入收藏' : '取消收藏');
  if (!S.liked[p.id]) return;
  const r = await send({ type: 'digg', id: p.id, on: true });
  if (r && r.err_no === 0) toast('已收藏，并在掘金点了赞');
  else if (r && r.err_msg === 'must login') toast('已收藏（掘金未登录，没同步点赞）');
}

async function sendComment() {
  if (!S.cur) return;
  const txt = $('#ta').value.trim();
  if (!txt) { toast('先写点什么'); return; }
  const btn = $('#btnSendCmt');
  btn.disabled = true; btn.textContent = '发送中…';
  const r = await send({ type: 'comment', id: S.cur.id, content: txt });
  btn.disabled = false; btn.textContent = '发表评论';
  if (r && r.err_no === 0) {
    S.cmted[S.cur.id] = true; saveLocal(); render(false);
    toast('评论已发布'); $('#ta').value = ''; closeSheets();
  } else {
    const why = (r && (r.err_msg || r.error)) || '未知';
    toast('发失败（' + why + '），已复制内容，可去原文粘贴');
    copyText(txt);
  }
}

/* ---------------- 事件 ---------------- */

function bind() {
  $('#btnRefresh').onclick = () => doRefresh(false);
  $('#btnShuffle').onclick = () => shuffle(true);
  $('#btnSettings').onclick = () => send({ type: 'openOptions' });
  $('#btnList').onclick = openList;
  $('#q').oninput = (e) => { S.q = e.target.value; rebuild(S.q); render(true); };
  $('#btnClose').onclick = closeSelf;
  $('#btnNext').onclick = () => {
    if (!S.order.length) return;
    if (S.pos + 1 >= S.order.length) { S.order.sort(() => Math.random() - 0.5); S.pos = 0; toast('牌堆抽完，重洗'); }
    else S.pos++;
    render(true);
  };
  $('#btnPrev').onclick = () => { if (S.pos > 0) { S.pos--; render(true); } else toast('已经是第一张'); };
  $('#btnLike').onclick = toggleLike;
  $('#btnComment').onclick = () => openCmt(false);
  $('#btnCopyLink').onclick = () => {
    if (!S.cur) return;
    const c = currentRoast(S.cur);
    copyText(S.cur.content + '\n' + S.cur.url + (c ? '\n\n—— ' + c.text : ''))
      .then(() => toast('已复制' + (c ? '（含点评）' : '')));
  };

  $('#btnUseAI').onclick = () => {
    const c = S.cur && currentRoast(S.cur);
    if (c) { $('#ta').value = c.text; toast('AI 点评已贴入'); } else toast('先给这张生成点评');
  };
  $('#btnCopyCmt').onclick = () => {
    const v = $('#ta').value.trim();
    v ? copyText(v).then(() => toast('已复制')) : toast('先写点什么');
  };
  $('#btnGoCmt').onclick = () => {
    const v = $('#ta').value.trim();
    if (v) copyText(v);
    if (S.cur) { openLink(S.cur.url); toast(v ? '已复制，去原文粘贴' : '已打开原文'); }
  };
  $('#btnSendCmt').onclick = sendComment;

  $('#favs').onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { S.liked[rm.dataset.rm] = false; saveLocal(); openList(); render(false); return; }
    const it = e.target.closest('.it');
    if (it) {
      const i = S.pins.findIndex((p) => p.id === it.dataset.id);
      if (i < 0) { toast('这条已不在本地牌堆里'); return; }
      const oi = S.order.indexOf(i);
      if (oi >= 0) S.pos = oi; else { S.order.unshift(i); S.pos = 0; }
      closeSheets(); render(true);
    }
  };
  $('#mask').onclick = closeSheets;

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const ae = document.activeElement;
    if (ae && ae.tagName === 'BUTTON') ae.blur();
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); $('#btnNext').click(); }
    else if (e.key === 'ArrowLeft') $('#btnPrev').click();
    else if (e.key.toLowerCase() === 'l') toggleLike();
    else if (e.key.toLowerCase() === 'c') openCmt(false);
    else if (e.key.toLowerCase() === 'r') doRefresh(false);
    else if (e.key === 'Escape') {
      if ($('#mask').classList.contains('on')) closeSheets();
      else $('#btnClose').click();
    }
  });
}

bind();
boot();

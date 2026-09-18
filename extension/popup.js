/* popup.js — 工具栏弹窗：状态 + 在本页弹卡牌 */
const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (v) => {
  if (chrome.runtime.lastError) r({ ok: false, error: chrome.runtime.lastError.message });
  else r(v || { ok: false, error: '空响应' });
}));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 这些页面不能注入 content script，只能退回独立窗口
const DENY = /^(chrome|chrome-extension|edge|about|devtools|view-source|chrome-search|brave|opera|vivaldi):/i;
const STORE_PAGE = /^(https:\/\/chrome\.google\.com\/webstore|https:\/\/chromewebstore\.google\.com)/i;

let toastTimer;
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 1900);
}

function openTab() {
  const url = chrome.runtime.getURL('app.html');
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url });
    window.close();
  });
}

/** 主入口：往当前页注入牌面浮层 */
async function openHere() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || DENY.test(tab.url || '') || STORE_PAGE.test(tab.url || '')) {
    toast('这个页面不让注入，给你开独立窗口');
    setTimeout(openTab, 700);
    return;
  }
  const r = await send({ type: 'inject', tabId: tab.id });
  if (r && r.ok) { window.close(); return; }
  toast('注入失败：' + ((r && r.error) || '未知') + '，改开独立窗口');
  setTimeout(openTab, 1100);
}

async function refresh() {
  const b = $('#btnRefresh'); b.classList.add('spin');
  const r = await send({ type: 'refresh', opts: { pages: 2, limit: 20 } });
  b.classList.remove('spin');
  if (!r || r.ok === false) { toast('抓取失败：' + ((r && r.error) || '未知')); return; }
  await load();
  toast(r.added ? '抓到 ' + r.added + ' 条新沸点' : '没有新沸点');
}

async function load() {
  const [st, local, tab] = await Promise.all([
    send({ type: 'getState' }),
    new Promise((r) => chrome.storage.local.get('gacha-local', (o) => r(o['gacha-local'] || {}))),
    new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => r(t[0] || {}))),
  ]);
  if (!st || st.ok === false) { toast('扩展未就绪'); return; }
  const likes = Object.values(local.liked || {}).filter(Boolean).length;
  $('#nPin').textContent = st.pins.length;
  $('#nRoast').textContent = Object.keys(st.roasts || {}).length;
  $('#nLike').textContent = likes;

  const p = st.pins[0];
  if (!p) { $('#preview').textContent = '牌堆还是空的，点下面「抓最新」发一把。'; }
  else {
    const n = st.meta.lastAdded;
    $('#preview').innerHTML = '<span class="who">最新 · ' + esc(p.user || '掘友') +
      (n ? ' · 本轮新增 ' + n + ' 条' : '') + '</span>' + esc(p.content.slice(0, 120));
  }
  $('#sub').textContent = st.cfg.autoFetch
    ? '实时沸点 · 每 ' + st.cfg.everyMinutes + ' 分钟自动抓'
    : '实时沸点 · 手动刷新';

  const url = (tab && tab.url) || '';
  if (DENY.test(url) || STORE_PAGE.test(url)) {
    $('#btnOpen').textContent = '这个页面不支持 · 开独立窗口';
    $('#hint').textContent = '当前是浏览器内部页面，只能走独立窗口。';
  }
}

$('#btnOpen').onclick = openHere;
$('#btnOpenTab').onclick = openTab;
$('#btnRefresh').onclick = refresh;
$('#btnSettings').onclick = () => send({ type: 'openOptions' });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); openHere(); }
});
load();

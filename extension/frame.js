/* frame.js — 把牌面浮层盖在当前网页上（content script，必须跑在 isolated world 才能用 chrome.*）
 *
 * 做法：往页面注入一个 host 元素（Shadow DOM 隔离样式），里面放一个 iframe 指向 app.html。
 * 牌面全部逻辑仍在 app.html/app.js 里，这里只负责「开 / 关」。
 */
(() => {
  const HOST_ID = 'juejin-pin-gacha-host';
  const TOKEN = 'pin-gacha-frame';
  const FRAME_URL = chrome.runtime.getURL('app.html') + '?embed=1&t=' + TOKEN;

  // 已经开着 -> 关掉（同一个按钮开/关）
  if (document.getElementById(HOST_ID)) {
    window.postMessage({ token: TOKEN, type: 'pin-gacha-close' }, '*');
    return;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-juejin-pin-gacha', '1');
  // 关键：宿主自己必须铺满视口，并且用 !important 压过页面里任何 z-index / position 规则。
  // 注意：!important 必须逐条写，不能把整串声明用分号拼起来再加一个 !important
  //（那样浏览器会把整块声明判为非法，z-index 直接变 auto —— 真实踩过）。
  const IMPORTANT = {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    'min-width': '0',
    'min-height': '0',
    'max-width': 'none',
    'max-height': 'none',
    'z-index': '2147483600',
    'pointer-events': 'auto',
    'transform': 'none',
    'filter': 'none',
    'opacity': '1',
    'visibility': 'visible',
  };
  Object.keys(IMPORTANT).forEach((k) => host.style.setProperty(k, IMPORTANT[k], 'important'));

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host{ all:initial !important; display:block !important;
      position:fixed !important; inset:0 !important;
      width:100vw !important; height:100vh !important;
      z-index:2147483600 !important; }
    .root{
      position:fixed; inset:0; z-index:2147483600;
      display:flex; align-items:center; justify-content:center;
      background:rgba(16,19,24,.5); backdrop-filter:blur(2px);
      font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      animation:jFade .18s ease both;
    }
    @keyframes jFade{from{opacity:0}to{opacity:1}}
    iframe{ width:100%; height:100%; border:0; background:transparent; display:block; color-scheme:light; }
  `;
  const root = document.createElement('div');
  root.className = 'root';
  const frame = document.createElement('iframe');
  frame.setAttribute('title', '沸点抽卡');
  frame.src = FRAME_URL;

  root.appendChild(frame);
  shadow.appendChild(style);
  shadow.appendChild(root);

  /** 自检：把真实尺寸报到页面标题上，方便排查"注入了但看不见" */
  function selfReport() {
    const r = host.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    document.documentElement.setAttribute('data-pin-gacha-size',
      Math.round(r.width) + 'x' + Math.round(r.height) + '/' +
      Math.round(f.width) + 'x' + Math.round(f.height));
  }

  const onMsg = (e) => {
    const d = e.data;
    if (!d || d.token !== TOKEN) return;                 // 只认自己那个 frame
    if (d.type === 'pin-gacha-close') closeOverlay();
    else if (d.type === 'pin-gacha-open-link' && d.url) window.open(d.url, '_blank', 'noopener');
  };

  function openOverlay() {
    (document.body || document.documentElement).appendChild(host);
    document.documentElement.style.overflow = 'hidden';
    window.addEventListener('message', onMsg, false);
    requestAnimationFrame(selfReport);
    setTimeout(selfReport, 300);
    try { chrome.runtime.sendMessage({ type: 'setFloatOpen', open: true }); } catch (err) {}
  }

  function closeOverlay() {
    window.removeEventListener('message', onMsg, false);
    document.documentElement.style.overflow = '';
    document.documentElement.removeAttribute('data-pin-gacha-size');
    host.remove();
    try { chrome.runtime.sendMessage({ type: 'setFloatOpen', open: false }); } catch (err) {}
  }

  // 本页快捷键：Esc 收牌（牌层自己也会发 postMessage，这里兜一道）
  function onKey(e) {
    if (e.key !== 'Escape') return;
    const ae = document.activeElement;
    // 局部放行的白名单：输入框、掘金自己的编辑器
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    e.stopPropagation();
    closeOverlay();
  }

  // 页面被整页替换（掘金是 SPA）时自己收掉，避免留下半截浮层
  function onNav() { if (!document.body || !document.body.contains(host)) closeOverlay(); }

  openOverlay();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('popstate', onNav);
  window.addEventListener('hashchange', onNav);
  // 只在这个 frame 内部生效，所以监听器随关闭一起摘掉
  const cleanup = () => {
    if (document.getElementById(HOST_ID)) return;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onNav);
    window.removeEventListener('hashchange', onNav);
    clearInterval(timer);
  };
  const timer = setInterval(cleanup, 1200);
  try { chrome.runtime.sendMessage({ type: 'floatOpened', title: document.title }); } catch (err) {}
})();

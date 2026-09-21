/* api-shim.js — 把站点页面里的 /api/* 请求接到扩展宿主上
 *
 * 为什么要有它：site/app.js 里有 5 处 fetch('api/…')（pins / roast /
 * comment / comments / roast/config），原本由 site/serve.mjs 这个本地
 * dev server 提供。扩展里没有服务器，于是这里**只劫持 fetch**，
 * 把 /api/* 转成 chrome.runtime 消息交给 background.js 处理。
 *
 * 这样做的意义：app.js 一行都不用改，站点与扩展共用同一份前端代码 ——
 * 站点的牌面、样式、AI 弹窗、翻牌动效全部原样复用，不存在"两套实现漂移"。
 *
 * 加载顺序：必须在 app.js 之前（见 host.html）。
 */
(function () {
  if (window.__JB_SHIM__) return;
  window.__JB_SHIM__ = true;

  var origFetch = window.fetch ? window.fetch.bind(window) : null;

  function pathOf(input) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    try { return new URL(u, location.href).pathname; } catch (e) { return ''; }
  }

  function bodyOf(init) {
    if (!init || !init.body) return null;
    var b = init.body;
    if (typeof b !== 'string') return null;      // FormData / Blob 之类，本项目用不到
    try { return JSON.parse(b); } catch (e) { return { raw: b }; }
  }

  function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload), {
      status: status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  window.fetch = function (input, init) {
    var p = pathOf(input);
    /* 只有 /api/ 开头的才接管；data.js / 字体 / 图片一律走原生 fetch */
    if (p.indexOf('/api/') !== 0) {
      if (!origFetch) return Promise.reject(new Error('fetch 不可用'));
      return origFetch(input, init);
    }

    /* 没有扩展宿主（本地 http 预览、或直接打开 host.html）时降级走同源 fetch，
     * 交给同源服务提供 /api/* —— 这样同一份页面既能当扩展跑，也能当网页跑。 */
    var hasHost = !!(window.chrome && chrome.runtime && chrome.runtime.sendMessage);
    if (!hasHost) {
      if (!origFetch) return Promise.reject(new Error('fetch 不可用'));
      return origFetch(input, init);
    }

    var u = new URL(typeof input === 'string' ? input : input.url, location.href);
    var msg = {
      type: 'jb-api',
      path: u.pathname,
      search: u.search,
      method: ((init && init.method) || 'GET').toUpperCase(),
      payload: bodyOf(init)
    };

    return new Promise(function (resolve) {
      var ch;
      try {
        ch = chrome.runtime.sendMessage(msg);
      } catch (e) {
        /* 扩展被重载 / 卸载后，页面里的 chrome.runtime 会失效 */
        resolve(jsonResponse(502, { error: '扩展已重载，请刷新页面' }));
        return;
      }
      Promise.resolve(ch).then(function (r) {
        if (!r) { resolve(jsonResponse(502, { error: '扩展宿主无响应' })); return; }
        var status = r.status || (r.ok ? 200 : 502);
        resolve(jsonResponse(status, r.body || {}));
      }, function (e) {
        resolve(jsonResponse(502, { error: String((e && e.message) || e) }));
      });
    });
  };
})();

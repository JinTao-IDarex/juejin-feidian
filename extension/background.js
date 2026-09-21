/* background.js — MV3 service worker
 *
 * 只做两件事：
 *   1) 消息路由：把扩展页发来的 /api/* 转给 api.mjs（= serve.mjs 的移植版）
 *   2) 需要登录态的掘金接口，转到掘金页面上下文去发（content.js 代发）
 *
 * 注意：这里**不保存任何数据**，牌面与点评缓存都在 api.mjs 的模块级变量里。
 * service worker 会被回收，缓存随之清空 —— 换来的是零存储、零残留，
 * 关掉浏览器什么也不留下，这正是这个项目「不登录、不上传」的定位。
 */
import { apiPins, apiRoast, apiComment, apiComments, apiRoastConfig } from './api.mjs';

/* 在掘金页面上下文里发请求：content script 的 fetch 天然带上用户的登录 Cookie，
 * 所以「一键评论」不用再让用户手动贴 Cookie（这是扩展相对站点 dev server 的一个白捡的好处）。 */
function makePageFetch(sender) {
  return (url, payload, method, headers, timeoutMs) => new Promise((resolve, reject) => {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId === undefined || tabId === null) {
      reject(new Error('当前不在掘金页面上下文里'));
      return;
    }
    chrome.tabs.sendMessage(tabId, {
      type: 'jb-page-fetch',
      url: url,
      payload: payload || null,
      method: method || 'POST',
      headers: headers || {},
      timeoutMs: timeoutMs || 15000
    }).then((r) => resolve(r || { http: 0, body: {} }))
      .catch((e) => reject(new Error('页面通道不可用：' + ((e && e.message) || e))));
  });
}

const routes = {
  '/api/pins': (m) => apiPins({ fresh: /(?:^|&)fresh=1/.test(String(m.search || '')) }),
  '/api/roast': (m) => apiRoast(m.payload || {}),
  '/api/roast/config': () => apiRoastConfig(),
  '/api/comment': (m, sender) => apiComment(m.payload || {}, { pageFetch: makePageFetch(sender) }),
  '/api/comments': (m, sender) => {
    const qs = new URLSearchParams(String(m.search || ''));
    return apiComments({ pinId: qs.get('pinId') || '' }, { pageFetch: makePageFetch(sender) });
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'jb-api') return false;
  const fn = routes[msg.path];
  if (!fn) {
    sendResponse({ status: 404, body: { error: '未知接口 ' + msg.path } });
    return false;
  }
  Promise.resolve()
    .then(() => fn(msg, sender))
    .then((r) => sendResponse(r || { status: 502, body: { error: '宿主空响应' } }))
    .catch((e) => sendResponse({ status: 502, body: { error: String((e && e.message) || e) } }));
  return true; // 异步响应
});

/* 工具栏图标：等价于点站点自己的 dock 按钮（展开 ⇄ 缩略卡） */
chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id === undefined || tab.id === null) return;
  if (!/^https?:\/\/([^/]*\.)?juejin\.cn\//i.test(tab.url || '')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'jb-toggle' }).catch(() => {});
});

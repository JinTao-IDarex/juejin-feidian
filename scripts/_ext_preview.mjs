/* _ext_preview.mjs — 扩展的本地预览服务器（只用于开发验证，不进扩展包）
 *
 * 为什么要它：本机没法给 Chrome 加载未打包扩展（agent-browser 起不了
 * --load-extension），所以「扩展真实链路」没法端到端点一遍。这个服务器
 * 用同一份 extension/ 目录 + 同一份 api.mjs 把页面跑在 http 上，
 * 于是能验证到：
 *   · embed.css 的裁剪与 --k 接管是否对（浮层版式）
 *   · 站点自己的折叠动画是否还能把页面吸进缩略卡
 *   · api.mjs 这个「serve.mjs 移植版」打真实上游时返回的形状对不对
 * 唯一验证不到的只剩 chrome.* 那几行胶水代码 —— 那部分只能靠代码审查。
 *
 * 用法：
 *   node scripts/_ext_preview.mjs 7300              → http://127.0.0.1:7300/host.html?embed=1&k=0.86
 *   node scripts/_ext_preview.mjs 7300 --mock-ai    → /api/roast 返回假点评（不用真 Key 也能看 AI 卡）
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { apiPins, apiRoast, apiComment, apiComments, apiRoastConfig, apiLoginCheck } from '../extension/api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'extension');
const port = Number(process.argv[2] || 7300);
const MOCK_AI = process.argv.includes('--mock-ai');
/* --mock-login：/api/login-check 直接报已登录，验证「一键评论」按钮的亮起分支 */
const MOCK_LOGIN = process.argv.includes('--mock-login');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/* 假点评：内容本身不重要，要的是让 AI 卡渲染出「有点评」那一态 */
const FAKE = [
  '牌面认真，结论糊弄；这套流程走下来，最该被 review 的是需求本身。',
  '把复杂问题讲成了复杂方案，这大概是技术人最擅长的事。',
  '工具换了一茬又一茬，加班时长倒是很稳定。',
  '能跑就别动——这句话救过无数人，也埋过无数人。',
];

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
  });
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);

  try {
    if (p === '/api/pins') {
      const r = await apiPins({ fresh: u.searchParams.get('fresh') === '1' });
      return send(res, r.status, JSON.stringify(r.body));
    }
    if (p === '/api/login-check') {
      if (MOCK_LOGIN) return send(res, 200, JSON.stringify({ loggedIn: true, user: '预览用户' }));
      /* 预览环境没有掘金页面上下文：apiLoginCheck 自己会报 unknown */
      const r = await apiLoginCheck({}, {});
      return send(res, r.status, JSON.stringify(r.body));
    }
    if (p === '/api/roast/config') {
      const r = apiRoastConfig();
      return send(res, r.status, JSON.stringify(r.body));
    }
    if (p === '/api/roast' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (MOCK_AI) {
        if (Array.isArray(body.items) && body.items.length) {
          const roasts = {};
          body.items.forEach((it, i) => { roasts[String(it.id)] = FAKE[i % FAKE.length]; });
          return send(res, 200, JSON.stringify({ roasts }));
        }
        return send(res, 200, JSON.stringify({ roast: FAKE[0] }));
      }
      const r = await apiRoast(body);
      return send(res, r.status, JSON.stringify(r.body));
    }
    if (p === '/api/comment' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      /* 预览环境没有掘金页面上下文，走显式 Cookie 分支 */
      const r = await apiComment(body, {});
      return send(res, r.status, JSON.stringify(r.body));
    }
    if (p === '/api/comments') {
      const r = await apiComments({ pinId: u.searchParams.get('pinId') || '' }, {});
      return send(res, r.status, JSON.stringify(r.body));
    }

    /* 模拟掘金页面的壳：把 content.js 真实跑起来（壳文件放在 previews/ 下，
     * 不属于扩展包，所以单独开一条路由） */
    if (p === '/panel.html') {
      const buf = await readFile(join(here, '..', 'previews', '_ext_panel.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    const rel = p === '/' ? '/host.html' : p;
    if (rel.split('/').some((seg) => seg.startsWith('_'))) {
      return send(res, 404, '404', 'text/plain; charset=utf-8');
    }
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) return send(res, 403, '403', 'text/plain');
    const buf = await readFile(file);
    /* 一律 no-store：调 content.js / embed.css 时最容易被浏览器缓存坑到，
     * 明明改了文件却还是旧行为。 */
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  } catch (e) {
    send(res, 404, '404 ' + String((e && e.message) || e), 'text/plain; charset=utf-8');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`ext preview on http://127.0.0.1:${port}/host.html?embed=1&k=0.86  (mockAI=${MOCK_AI})`);
});

// 零依赖静态服务器 + /api/pins 实时沸点代理：npm run dev [-- --host 127.0.0.1 --port 7100]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const host = arg('host', process.env.HOST || '127.0.0.1');
const port = Number(arg('port', process.env.PORT || 7100));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------- /api/pins 实时沸点代理 ----------------
 * 浏览器直连 api.juejin.cn 会被 CORS 拦截，所以由 dev server 在服务端转发。
 * 接口与归一化逻辑对齐 scripts/fetch_pins.py 和 extension/background.js：
 *   POST recommend_api/v1/short_msg/recommend  {id_type:4, sort_type:300, cursor, limit}
 * 带 180s 内存缓存，避免每次打开页面都反复打上游。 */
const JJ_API = 'https://api.juejin.cn/recommend_api/v1/short_msg/recommend?aid=2608&spider=0';
const JJ_HEADERS = {
  'content-type': 'application/json',
  'origin': 'https://juejin.cn',
  'referer': 'https://juejin.cn',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};
const CACHE_TTL = 180_000;
let cache = null; // { at, payload }

const TOPIC_RE = /\[(\d+)#([^#\]]+)#\]/g;
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

/* 归一化成 data.js 的牌面形状：
 * id / content / topic / ctime(int) / digg / cmt / user / company / job / avatar / url / roast */
function normalizePin(it) {
  const m = it.msg_Info || {};
  const au = (it.author_user_info && it.author_user_info.user_name !== undefined)
    ? it.author_user_info : (m.author_user_info || {});
  const raw = m.content || '';
  const topics = [];
  let mm;
  TOPIC_RE.lastIndex = 0;
  while ((mm = TOPIC_RE.exec(raw))) topics.push(mm[2]);
  const id = String(m.msg_id || it.msg_id || '');
  return {
    id,
    content: stripHtml(raw.replace(TOPIC_RE, '')),
    topic: topics[0] || '沸点',
    ctime: Number(m.ctime || 0),
    digg: m.digg_count || 0,
    cmt: m.comment_count || 0,
    user: au.user_name || '掘友',
    company: au.company || '',
    job: au.job_title || '',
    avatar: au.avatar_large || '',
    url: 'https://juejin.cn/pin/' + id,
    roast: '', // 实时数据没有手写点评，AI 卡会显示「这条还没配点评」
  };
}

async function fetchPage(cursor, limit) {
  const res = await fetch(JJ_API, {
    method: 'POST',
    headers: JJ_HEADERS,
    body: JSON.stringify({ id_type: 4, sort_type: 300, cursor: String(cursor), limit }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.err_no !== 0 && !data.data) throw new Error(data.err_msg || '接口异常');
  return { list: data.data || [], cursor: data.cursor || '', hasMore: !!data.has_more };
}

async function livePins(want = 60) {
  const out = [];
  const seen = new Set();
  let cursor = '0';
  for (let i = 0; i < 3 && out.length < want; i++) {
    const r = await fetchPage(cursor, 20);
    for (const it of r.list) {
      const p = normalizePin(it);
      if (!p.id || !p.content || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    if (!r.hasMore || !r.cursor) break;
    cursor = r.cursor;
  }
  return out.slice(0, want);
}

async function handleApiPins(res, fresh) {
  try {
    /* fresh=1 跳过缓存强制打上游（「洗牌」按钮获取最新沸点用） */
    if (fresh || !cache || Date.now() - cache.at > CACHE_TTL) {
      const pins = await livePins(60);
      if (!pins.length) throw new Error('上游返回空列表');
      cache = {
        at: Date.now(),
        payload: { day: 'live', date: new Date().toISOString().slice(0, 10), pins },
      };
    }
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(cache.payload));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}

/* ---------------- /api/roast AI 实时点评代理 ----------------
 * 前端把用户在页面里配置的 OpenAI 兼容接口（baseUrl / token / model）
 * 随请求带过来，由服务端转发到对应厂商的 chat/completions。
 * 走服务端转发的原因：1) 浏览器直连多数厂商会被 CORS 拦；
 * 2) 请求失败时能把真实错误透传回页面，方便排障。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 64 * 1024) reject(new Error('请求体过大')); });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

const ROAST_PROMPT =
  '你是掘金沸点的毒舌评论员。针对用户给的沸点内容写一句点评：' +
  '口语化、犀利幽默、一针见血，可以调侃现象，但不攻击作者本人。' +
  '不超过 60 字，只输出点评本身，不要引号、不要解释、不要前缀。';

async function handleApiRoast(req, res) {
  try {
    const body = JSON.parse(await readBody(req) || '{}');
    const base = String(body.baseUrl || '').replace(/\/+$/, '');
    const token = String(body.token || '');
    const model = String(body.model || '');
    const content = String(body.content || '').slice(0, 500);
    const topic = String(body.topic || '');
    /* 风格提示词由前端按所选风格卡牌传入；缺省用内置毒舌风格 */
    const sysPrompt = String(body.prompt || ROAST_PROMPT).slice(0, 800);
    if (!base || !token || !model) throw new Error('请先在右上角配置 AI 接口地址、Key 和模型');
    if (!content) throw new Error('沸点内容为空');
    const upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: (topic ? '【' + topic + '】' : '') + content },
        ],
        temperature: 0.9,
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const msg = (data.error && (data.error.message || data.error.msg)) || ('HTTP ' + upstream.status);
      throw new Error(msg);
    }
    const roast = String(
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
    ).trim().replace(/^["「『]+|["」』]+$/g, '');
    if (!roast) throw new Error('AI 返回了空内容');
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ roast }));
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'AI 接口超时（20s）' : String((e && e.message) || e);
    res.writeHead(502, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: msg }));
  }
}

createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p === '/api/pins') { await handleApiPins(res, u.searchParams.get('fresh') === '1'); return; }
    if (p === '/api/roast' && req.method === 'POST') { await handleApiRoast(req, res); return; }
    if (p === '/') p = '/index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(normalize(root))) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}).listen(port, host, () => console.log(`serving ${root} at http://${host}:${port}/`));

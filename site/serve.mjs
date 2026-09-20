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
 * 2) 请求失败时能把真实错误透传回页面，方便排障。
 *
 * 【Key 不进浏览器】token（以及 baseUrl / model）也可以写进
 * site/.ai-config.json（只存本机），请求里没带时由服务端补上——
 * 这样 Key 永远不会出现在浏览器控制台 / Network 面板里。
 * 注意：该文件已被静态服务的点文件规则拦截，无法通过 http 访问。 */
const AI_CFG_FILE = join(root, '.ai-config.json');
let aiCfgFileCache = null; // { at, cfg }，2s 内复用，避免每次请求都读盘
async function serverAiCfg() {
  if (aiCfgFileCache && Date.now() - aiCfgFileCache.at < 2000) return aiCfgFileCache.cfg;
  let cfg = null;
  try { cfg = JSON.parse(await readFile(AI_CFG_FILE, 'utf8')); } catch { /* 没配置就算了 */ }
  aiCfgFileCache = { at: Date.now(), cfg };
  return cfg;
}
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

/* ---- 上游并发闸门：最多 2 个并发，其余排队（最多等 10s）。
 * 防止翻牌稍快就把服务商的并发配额打爆（concurrency quota exceeded）。
 * 浏览器断开时通过 req close 事件真正取消上游请求。 */
const MAX_UPSTREAM = 2;
let inflight = 0;
const waitQueue = [];
function acquireSlot(maxWaitMs) {
  if (inflight < MAX_UPSTREAM) { inflight++; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const entry = () => { clearTimeout(t); inflight++; resolve(true); };
    const t = setTimeout(() => {
      const i = waitQueue.indexOf(entry);
      if (i >= 0) waitQueue.splice(i, 1);
      resolve(false);
    }, maxWaitMs);
    waitQueue.push(entry);
  });
}
function releaseSlot() {
  inflight--;
  const next = waitQueue.shift();
  if (next) next();
}

/* ---- 服务端点评缓存：同一条内容+同一风格，10 分钟内不重复打上游；
 * 失败结果只记 20s（限流错误很快恢复，值得再试）。 */
const roastSrvCache = new Map(); // key -> { at, roast?, error? }
const SRV_CACHE_OK_TTL = 600_000;
const SRV_CACHE_ERR_TTL = 20_000;
function srvCacheGet(key) {
  const it = roastSrvCache.get(key);
  if (!it) return null;
  const ttl = it.roast ? SRV_CACHE_OK_TTL : SRV_CACHE_ERR_TTL;
  if (Date.now() - it.at > ttl) { roastSrvCache.delete(key); return null; }
  return it;
}
function srvCacheSet(key, val) {
  if (roastSrvCache.size > 300) roastSrvCache.delete(roastSrvCache.keys().next().value);
  roastSrvCache.set(key, Object.assign({ at: Date.now() }, val));
}

async function handleApiRoast(req, res) {
  /* 浏览器（翻牌离开时）断开连接 → 同步取消上游请求，不占厂商配额。
   * 注意必须挂在 res 上判断 writableFinished：req 的 close 在请求体读完时就触发，
   * 挂 req 会把正常请求也当成「客户端跑了」。 */
  const clientGone = new AbortController();
  res.on('close', () => { if (!res.writableFinished) clientGone.abort(); });
  let slotTaken = false;
  try {
    const body = JSON.parse(await readBody(req) || '{}');
    /* 浏览器没带的字段（尤其是 token）用服务端 .ai-config.json 兜底 */
    const fileCfg = (await serverAiCfg()) || {};
    const base = (String(body.baseUrl || '') || String(fileCfg.baseUrl || '')).replace(/\/+$/, '');
    const token = String(body.token || '') || String(fileCfg.token || '');
    const model = String(body.model || '') || String(fileCfg.model || '');
    const content = String(body.content || '').slice(0, 500);
    const topic = String(body.topic || '');
    /* 风格提示词由前端按所选风格卡牌传入；缺省用内置毒舌风格 */
    const sysPrompt = String(body.prompt || ROAST_PROMPT).slice(0, 800);
    if (!base || !token || !model) {
      throw new Error('请先配置 AI 接口：页面右上角 ✦，或写入 site/.ai-config.json');
    }

    /* ---- 批量模式：items 数组 → 单次上游调用生成全部点评 ----
     * 前端把本次所有未点评的沸点打包发来，拼成一个编号清单让模型
     * 输出 JSON 字符串数组（顺序与编号对应），避免逐条请求触发并发限流。
     * 逐条缓存仍然生效：命中过的不重复送上游。 */
    const items = Array.isArray(body.items) ? body.items.slice(0, 100) : null;
    if (items && items.length) {
      const norm = items.map((it) => ({
        id: String((it && it.id) || ''),
        content: String((it && it.content) || '').slice(0, 500),
        topic: String((it && it.topic) || '').slice(0, 80),
      })).filter((it) => it.id && it.content);
      const roasts = {};
      const misses = [];
      for (const it of norm) {
        const key = model + '|' + sysPrompt.slice(0, 40) + '|' + it.content;
        const hit = srvCacheGet(key);
        if (hit && hit.roast) roasts[it.id] = hit.roast;
        else misses.push({ it, key });
      }
      /* 部分成功也要返回：已经命中缓存的那部分点评，不该因为剩余几条
       * 失败就整批丢掉（前端拿不到就只能显示失败，白算一遍还推高请求数）。 */
      let batchErr = null;
      if (misses.length) {
        try {
          if (!(await acquireSlot(10_000))) throw new Error('生成排队超时，稍后再试');
          slotTaken = true;
          const listText = misses
            .map((m, i) => (i + 1) + '. ' + (m.it.topic ? '【' + m.it.topic + '】' : '') + m.it.content)
            .join('\n');
          const upstream = await fetch(base + '/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: sysPrompt +
                  '\n本次给你 ' + misses.length + ' 条沸点（编号 1~' + misses.length + '）。' +
                  '逐条各写一句点评，严格按编号顺序输出一个 JSON 字符串数组，' +
                  '数组长度必须等于 ' + misses.length + '。只输出 JSON 数组本身，' +
                  '不要代码块标记、不要编号、不要任何额外文字。' },
                { role: 'user', content: listText },
              ],
              temperature: 0.9,
              max_tokens: Math.min(8000, 160 * misses.length + 200),
            }),
            signal: AbortSignal.any([clientGone.signal, AbortSignal.timeout(60_000)]),
          });
          const data = await upstream.json().catch(() => ({}));
          if (!upstream.ok) {
            const msg = (data.error && (data.error.message || data.error.msg)) || ('HTTP ' + upstream.status);
            throw new Error(msg);
          }
          const raw = String(
            (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
          ).trim();
          /* 容错提取 JSON 数组：有的模型爱包 ```json 代码块或在前后加废话 */
          const mArr = raw.match(/\[[\s\S]*\]/);
          if (!mArr) throw new Error('AI 未按要求返回 JSON 数组');
          let arr;
          try { arr = JSON.parse(mArr[0]); } catch { throw new Error('AI 返回的 JSON 无法解析'); }
          if (!Array.isArray(arr)) throw new Error('AI 返回格式异常');
          misses.forEach((mm, i) => {
            const t = String(arr[i] || '').trim().replace(/^["「『]+|["」』]+$/g, '');
            if (t) { roasts[mm.it.id] = t; srvCacheSet(mm.key, { roast: t }); }
          });
        } catch (e) {
          /* 客户端主动断开（翻牌走了）就不回错误了——连接已关闭，写了也写不进去 */
          if (clientGone.signal.aborted) return;
          batchErr = String((e && e.message) || e);
        }
      }
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(batchErr ? { roasts, error: batchErr } : { roasts }));
      return;
    }

    if (!content) throw new Error('沸点内容为空');

    const cacheKey = model + '|' + sysPrompt.slice(0, 40) + '|' + content;
    const hit = srvCacheGet(cacheKey);
    if (hit) {
      if (hit.roast) {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ roast: hit.roast }));
      } else {
        res.writeHead(502, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: hit.error }));
      }
      return;
    }

    if (!(await acquireSlot(10_000))) throw new Error('生成排队超时，翻慢一点点');
    slotTaken = true;
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
      signal: AbortSignal.any([clientGone.signal, AbortSignal.timeout(20_000)]),
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
    srvCacheSet(cacheKey, { roast });
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ roast }));
  } catch (e) {
    /* 客户端主动断开（翻牌走了）就不回错误了——连接已关闭，写了也写不进去 */
    if (clientGone.signal.aborted) return;
    const isAbort = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    const msg = isAbort && !clientGone.signal.aborted
      ? 'AI 接口超时（20s）'
      : String((e && e.message) || e);
    res.writeHead(502, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: msg }));
  } finally {
    if (slotTaken) releaseSlot();
  }
}

/* ---------------- /api/comment 一键评论代理 ----------------
 * 把 AI 点评直接发到对应沸点的评论区。
 * 掘金接口：POST interact_api/v1/comment/publish {item_id, item_type:4(沸点), comment_content}
 * 需要登录态 Cookie（sessionid 等），浏览器直连会被 CORS 拦，故由服务端转发。
 * Cookie 可由页面配置带入，也可写进 site/.ai-config.json 的 jjCookie 字段
 * （只存本机、不进浏览器）。CSRF token 一般可省，个别账号需要时可配 jjCsrf。 */
const JJ_COMMENT_API = 'https://api.juejin.cn/interact_api/v1/comment/publish?aid=2608&spider=0';
async function handleApiComment(req, res) {
  const fail = (code, msg) => {
    res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: msg }));
  };
  try {
    const body = JSON.parse(await readBody(req) || '{}');
    const pinId = String(body.pinId || '').trim();
    const content = String(body.content || '').trim().slice(0, 500);
    const fileCfg = (await serverAiCfg()) || {};
    const cookie = String(body.cookie || '') || String(fileCfg.jjCookie || '');
    const csrf = String(body.csrf || '') || String(fileCfg.jjCsrf || '');
    if (!pinId) return fail(400, '缺少沸点 ID');
    if (!content) return fail(400, '评论内容为空');
    if (!cookie) return fail(401, '未配置掘金 Cookie');
    const headers = Object.assign({}, JJ_HEADERS, { cookie });
    if (csrf) headers['x-secsdk-csrf-token'] = csrf;
    const upstream = await fetch(JJ_COMMENT_API, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        item_id: pinId,
        item_type: 4, // 4 = 沸点
        comment_content: content,
        comment_pics: [],
        client_type: 2608,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return fail(502, '掘金接口 HTTP ' + upstream.status);
    if (data.err_no !== 0) {
      /* 常见错误翻译成可操作提示 */
      let msg = data.err_msg || ('err_no=' + data.err_no);
      if (data.err_no === 2190 || /登录/.test(msg)) msg = '掘金登录态失效，请更新 Cookie';
      if (/csrf/i.test(msg)) msg = 'CSRF 校验失败，请在配置里补 x-secsdk-csrf-token';
      return fail(502, msg);
    }
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    const isAbort = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    fail(502, isAbort ? '掘金接口超时（15s）' : String((e && e.message) || e));
  }
}

createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p === '/api/pins') { await handleApiPins(res, u.searchParams.get('fresh') === '1'); return; }
    if (p === '/api/roast' && req.method === 'POST') { await handleApiRoast(req, res); return; }
    if (p === '/api/comment' && req.method === 'POST') { await handleApiComment(req, res); return; }
    /* 供页面判断服务端是否已配 Key / Cookie（只回非敏感字段，绝不回 token 本体） */
    if (p === '/api/roast/config') {
      const c = (await serverAiCfg()) || {};
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        serverKey: !!c.token,
        baseUrl: c.baseUrl || '',
        model: c.model || '',
        jjCookie: !!c.jjCookie,
      }));
      return;
    }
    if (p === '/') p = '/index.html';
    /* 点文件（.ai-config.json / .env 等）一律不伺候——Key 不能被 http 下载 */
    if (p.split('/').some((seg) => seg.startsWith('.'))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
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

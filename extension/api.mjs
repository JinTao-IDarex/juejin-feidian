/* api.mjs — 沸点抽卡的扩展侧接口层
 *
 * 与 site/serve.mjs 的关系：**业务逻辑、提示词、缓存策略逐字移植**，
 * 只把 Node 的 HTTP 那一层换掉：
 *     serve.mjs                            这里
 *     handleApiPins(res, fresh)      →  apiPins({ fresh })      → {status, body}
 *     handleApiRoast(req, res)       →  apiRoast(payload)       → {status, body}
 *     handleApiComment(req, res)     →  apiComment(payload, ctx)→ {status, body}
 *     handleApiComments(res, pinId)  →  apiComments({ pinId }, ctx) → {status, body}
 *     /api/roast/config 内联分支      →  apiRoastConfig()
 *
 * 移植时有意去掉的两处（都是 HTTP 连接语义，扩展里没有对应概念）：
 *   · res.on('close') 的「客户端断开就取消上游」—— 消息通道没有关闭事件
 *   · readBody(req) 的流式读体 —— 消息里已经是对象
 * 其余（并发闸门 MAX_UPSTREAM、两级缓存 TTL、批量 JSON 容错、错误文案翻译）
 * 全部保留，因为那些正是踩过坑攒下来的。
 *
 * 之所以坚持移植而不是「另写一套」：app.js 是按 serve.mjs 的响应形状写的
 * （比如 /api/pins 要 {pins:[...]}、/api/roast 要 {roast} 或 {roasts:{},error}），
 * 形状一对不上，站点前端就得改 —— 那就不是复用了。
 */

/* 协议适配与厂商表在 providers.js 里（与站点同源，由 build_extension.py 复制过来）。
 *
 * ⚠️ 这一行必须组合两种取法，缺一不可：
 *    · Node：providers.js 是 CJS → `import * as` 命名空间带 default = module.exports；
 *    · Chrome 扩展（ESM）：UMD 没有 export 语句 → 命名空间是空的，
 *      但 UMD 的 IIFE 已把结果挂到 self.JBProviders（service worker 里
 *      self === globalThis），所以从 globalThis 兜底。
 *    先试 default 再试 globalThis，两端都能拿到同一份实现。 */
import * as provMod from './providers.js';
const providers = (provMod && provMod.default) || globalThis.JBProviders || null;
if (!providers) throw new Error('providers.js 未加载（扩展包内应存在该文件）');

/* ---------------- 共用 ---------------- */

const JJ_HEADERS = {
  'content-type': 'application/json',
  'origin': 'https://juejin.cn',
  'referer': 'https://juejin.cn',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const TOPIC_RE = /\[(\d+)#([^#\]]+)#\]/g;
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

const ok = (body, status = 200) => ({ status, body });
const fail = (status, msg) => ({ status, body: { error: msg } });

/* ---------------- /api/pins 实时沸点 ---------------- */

const JJ_API = 'https://api.juejin.cn/recommend_api/v1/short_msg/recommend?aid=2608&spider=0';
const CACHE_TTL = 180_000;
let pinsCache = null; // { at, payload }

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

export async function apiPins({ fresh } = {}) {
  try {
    /* fresh=1 跳过缓存强制打上游（「洗牌」按钮获取最新沸点用） */
    if (fresh || !pinsCache || Date.now() - pinsCache.at > CACHE_TTL) {
      const pins = await livePins(60);
      if (!pins.length) throw new Error('上游返回空列表');
      pinsCache = {
        at: Date.now(),
        payload: { day: 'live', date: new Date().toISOString().slice(0, 10), pins },
      };
    }
    return ok(pinsCache.payload);
  } catch (e) {
    /* app.js 收到非 200 会自己回退到 data.js 的内置牌堆，所以这里照实报错即可 */
    return fail(502, String((e && e.message) || e));
  }
}

/* ---------------- /api/roast AI 实时点评 ----------------
 * 页面把用户配的接口（providerId / baseUrl / token / model / api / extra）随请求带过来。
 * 站点版是「浏览器 → serve.mjs → 厂商」，扩展版是
 * 「扩展页 → background service worker → 厂商」：
 * service worker 发请求没有 CORS 限制，也不需要把 Key 交给页面之外的第三方。
 *
 * 【请求形状由 providers.js 决定】chat / responses / anthropic 三种协议，
 * 以及模型级参数差异（推理模型不传 temperature 等）全在那份表里。
 * 这里只负责：取配置 → 拼请求 → 发出去 → 把错误翻译成人话。
 *
 * 【与 serve.mjs 的差别】扩展里没有 site/.ai-config.json，也没有 JB_AI_* 环境变量，
 * 所以那边「请求体 > 环境变量 > 配置文件」的三层合成在这里退化成一层：
 * 配置一律以页面传入为准。其余（并发闸门、两级缓存、批量 JSON 容错）逐字保留。
 */

const ROAST_PROMPT =
  '你是掘金沸点的毒舌评论员。针对用户给的沸点内容写一句点评：' +
  '口语化、犀利幽默、一针见血，可以调侃现象，但不攻击作者本人。' +
  '不超过 60 字，只输出点评本身，不要引号、不要解释、不要前缀。';

/* ---- 上游并发闸门：最多 2 个并发，其余排队（最多等 10s）。
 * 防止翻牌稍快就把服务商的并发配额打爆（concurrency quota exceeded）。 */
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

/* ---- 点评缓存：同一条内容+同一风格，10 分钟内不重复打上游；
 * 失败结果只记 20s（限流错误很快恢复，值得再试）。 */
const roastSrvCache = new Map();
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

/* ---- 批量点评会话：把同一批的多次请求串成一场多轮对话 ----
 * 键 = session id + 模型 + 协议 + 风格；值 = 已发生的 messages 历史。
 * 与 serve.mjs 逐字镜像，改这里记得同步那边。
 * MV3 的 service worker 空闲可能被回收：会话丢了也只是下一轮从头开一场，
 * 点评照常出，属于优雅降级 —— 页面连续翻牌时 worker 几乎总是热的。 */
const AI_SESSION_TTL = 5 * 60_000;
const AI_SESSION_MAX = 40;
const aiSessions = new Map(); // sessionKey -> { at, messages: [{role, content}] }
function aiSessionGet(key) {
  if (aiSessions.size > AI_SESSION_MAX) {
    const now = Date.now();
    for (const [k, v] of aiSessions) {
      if (now - v.at > AI_SESSION_TTL) aiSessions.delete(k);
    }
    while (aiSessions.size > AI_SESSION_MAX) {
      aiSessions.delete(aiSessions.keys().next().value);
    }
  }
  const s = aiSessions.get(key);
  if (s) s.at = Date.now();
  return s || null;
}
function aiSessionSet(key, messages) {
  aiSessions.set(key, { at: Date.now(), messages });
}

/** 按协议调上游，返回解析后的响应对象；失败抛出可读错误（带分类标记） */
async function callUpstream(ai, opts, timeoutMs) {
  const q = providers.buildRequest(ai, opts);
  const upstream = await fetch(q.url, {
    method: q.method,
    headers: q.headers,
    body: JSON.stringify(q.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (upstream.status === 429) {
    /* 厂商限流：把 Retry-After 秒数带回前端，让它精确等待而不是盲猜 */
    const data = await upstream.json().catch(() => ({}));
    const err = new Error(providers.parseError(ai, 429, data));
    err.rateLimited = true;
    err.retryAfter = Number(upstream.headers.get('retry-after')) || 0;
    throw err;
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(providers.parseError(ai, upstream.status, data));
  return data;
}

export async function apiRoast(body = {}) {
  let slotTaken = false;
  try {
    /* 归一化成「怎么调」：厂商表 → 地址，模型规则 → 协议与参数 */
    const ai = providers.resolve({
      providerId: String(body.providerId || ''),
      baseUrl: String(body.baseUrl || ''),
      token: String(body.token || ''),
      model: String(body.model || ''),
      api: String(body.api || ''),
      extra: (body.extra && typeof body.extra === 'object') ? body.extra : null,
    });
    /* 调试日志：帮助排查配置问题 */
    console.log('[jb-api] resolve:', {
      providerId: ai.providerId,
      baseUrl: ai.baseUrl,
      model: ai.model,
      api: ai.api,
      needsKey: ai.needsKey,
      hasToken: !!ai.token,
    });
    const content = String(body.content || '').slice(0, 500);
    const topic = String(body.topic || '');
    /* 风格提示词由前端按所选风格卡牌传入；缺省用内置毒舌风格 */
    const sysPrompt = String(body.prompt || ROAST_PROMPT).slice(0, 800);
    /* needsKey=false 的（本地 Ollama）不要求填 Key */
    if (!ai.baseUrl || !ai.model || (ai.needsKey && !ai.token)) {
      const missing = [];
      if (!ai.baseUrl) missing.push('baseUrl');
      if (!ai.model) missing.push('model');
      if (ai.needsKey && !ai.token) missing.push('token');
      throw new Error('请先配置 AI 接口：浮层右上角 ✦（缺：' + missing.join(', ') + '）');
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
        /* 缓存键带上 api：同一个模型换协议=换了上游形状，不能算同一份结果 */
        const key = ai.model + '|' + ai.api + '|' + sysPrompt.slice(0, 40) + '|' + it.content;
        const hit = srvCacheGet(key);
        if (hit && hit.roast) roasts[it.id] = hit.roast;
        else misses.push({ it, key });
      }
      /* 部分成功也要返回：已经命中缓存的那部分点评，不该因为剩余几条
       * 失败就整批丢掉。
       *
       * 队列逐轮发：每轮最多 10 条（前端自适应批次的上限），且在【同一个对话】
       * 里接续 —— 上一轮的问答原样入列 history，模型每轮都能看到自己之前
       * 用了什么输出格式，JSON 遵从率更高，也能吃到厂商的上下文缓存。
       * 超时按组大小动态（8s 底 + 6s/条），错误分类（限流/超时）随响应透传，
       * 前端据此选退避策略。与 serve.mjs 逐字对齐。 */
      const TURN = 10;
      const sessKey = String(body.session || '').slice(0, 64) +
        '|' + ai.model + '|' + ai.api + '|' + sysPrompt.slice(0, 40);
      const sess = aiSessionGet(sessKey) || { messages: [] };
      const errs = [];
      let retryAfter = 0;   // 上游 429 时带出的等待秒数
      let rateLimited = false;
      let timedOut = false;
      for (let off = 0; off < misses.length; off += TURN) {
        const chunk = misses.slice(off, off + TURN);
        /* 超时按组大小动态：8s 底 + 6s/条（10 条 = 68s），不再一刀切
         * （声明在 try 外：catch 的超时文案要用） */
        const timeoutMs = Math.min(90_000, 8_000 + chunk.length * 6_000);
        let taken = false;
        try {
          if (!(await acquireSlot(10_000))) throw new Error('生成排队超时，稍后再试');
          taken = true;
          const listText = chunk
            .map((m, i) => (i + 1) + '. ' + (m.it.topic ? '【' + m.it.topic + '】' : '') + m.it.content)
            .join('\n');
          const history = sess.messages.slice(-10);
          const data = await callUpstream(ai, {
            system: sysPrompt +
              '\n本次给你 ' + chunk.length + ' 条沸点（编号 1~' + chunk.length + '）。' +
              '逐条各写一句点评，严格按编号顺序输出一个 JSON 字符串数组，' +
              '数组长度必须等于 ' + chunk.length + '。只输出 JSON 数组本身，' +
              '不要代码块标记、不要编号、不要任何额外文字。',
            user: listText,
            maxTokens: Math.min(3000, 260 * chunk.length + 200),
            temperature: 0.7,
            history,
          }, timeoutMs);

          const raw = providers.parseReply(ai, data).trim();
          /* 容错提取 JSON 数组（代码块 / 截断 / 纯文本都能救），见 providers.js */
          const arr = providers.extractJsonArray(raw, chunk.length);
          if (!arr) throw new Error(raw ? 'AI 未按要求返回 JSON 数组' : 'AI 返回了空内容');
          chunk.forEach((mm, i) => {
            const t = String(arr[i] || '').trim().replace(/^["「『]+|["」』]+$/g, '');
            if (t) { roasts[mm.it.id] = t; srvCacheSet(mm.key, { roast: t }); }
          });
          /* 成功才推进对话：本轮问答入列，下一轮接在同一段对话后面 */
          sess.messages = history.concat([
            { role: 'user', content: listText },
            { role: 'assistant', content: raw.slice(0, 4000) },
          ]);
          aiSessionSet(sessKey, sess.messages);
        } catch (e) {
          /* 错误分类透传（独立布尔字段，不污染文案）：前端据此选
           * 「拆半重试 / 退避等待 / 放弃」 */
          const isTimeout = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
          if (isTimeout) timedOut = true;
          if (e && e.rateLimited) {
            rateLimited = true;
            if (e.retryAfter > retryAfter) retryAfter = e.retryAfter;
          }
          errs.push(isTimeout
            ? 'AI 接口超时（' + Math.round(timeoutMs / 1000) + 's）'
            : String((e && e.message) || e));
          break; // 队列等待语义：上游出问题就停下，别硬冲后面几轮
        } finally {
          if (taken) releaseSlot();
        }
      }
      const batchErr = errs.length ? errs.join('；') : null;
      return ok(batchErr
        ? { roasts, error: batchErr, retryAfter: retryAfter || 0,
            rateLimited: rateLimited || false, timedOut: timedOut || false }
        : { roasts });
    }

    if (!content) throw new Error('沸点内容为空');

    const cacheKey = ai.model + '|' + ai.api + '|' + sysPrompt.slice(0, 40) + '|' + content;
    const hit = srvCacheGet(cacheKey);
    if (hit) {
      if (hit.roast) return ok({ roast: hit.roast });
      return fail(502, hit.error);
    }

    if (!(await acquireSlot(10_000))) throw new Error('生成排队超时，翻慢一点点');
    slotTaken = true;
    const data = await callUpstream(ai, {
      system: sysPrompt,
      user: (topic ? '【' + topic + '】' : '') + content,
      maxTokens: 120,
      temperature: 0.9,
    }, 20_000);
    const roast = providers.parseReply(ai, data).trim().replace(/^["「『]+|["」』]+$/g, '');
    /* 正文为空时优先透传上游错误（部分网关把 404 包成 HTTP 200，真相在 body 里） */
    if (!roast) throw new Error(providers.parseError(ai, 200, data) || 'AI 返回了空内容');
    srvCacheSet(cacheKey, { roast });
    return ok({ roast });
  } catch (e) {
    const isAbort = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return fail(502, isAbort ? 'AI 接口超时（20s）' : String((e && e.message) || e));
  } finally {
    if (slotTaken) releaseSlot();
  }
}

/* ---------------- /api/models 拉取模型列表 ----------------
 * 弹窗里的「拉取列表」用，语义与 serve.mjs 的同名路由完全一致：
 * 不是每家厂商都实现了 /models，拉不到就如实报错、让人手填，
 * 不要静默回一份假列表 —— 那比报错更难查。 */
export async function apiModels(body = {}) {
  try {
    const ai = providers.resolve({
      providerId: String(body.providerId || ''),
      baseUrl: String(body.baseUrl || ''),
      token: String(body.token || ''),
      model: String(body.model || ''),
      api: String(body.api || ''),
    });
    if (!ai.baseUrl) throw new Error('先填一个接口地址');
    if (ai.needsKey && !ai.token) throw new Error('先填 API Key');
    const q = providers.buildModelsRequest(ai);
    const upstream = await fetch(q.url, {
      method: q.method,
      headers: q.headers,
      signal: AbortSignal.timeout(15_000),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw new Error(providers.parseError(ai, upstream.status, data));
    const models = providers.parseModels(data);
    if (!models.length) throw new Error('这个接口没返回模型列表，直接手填模型名即可');
    return ok({ models, provider: ai.providerName, api: ai.api });
  } catch (e) {
    const isAbort = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return {
      status: 502,
      body: { models: [], error: isAbort ? '拉取模型列表超时（15s）' : String((e && e.message) || e) },
    };
  }
}

/* ---------------- /api/comment 一键评论 ----------------
 * 掘金接口：POST interact_api/v1/comment/publish {item_id, item_type:4(沸点), comment_content}
 *
 * 站点版要靠用户自己把 Cookie 贴进配置（因为请求从 node 发出去，没有登录态）。
 * 扩展版有更好的路子：**在掘金页面上下文里发**，登录 Cookie 自动带上，
 * 用户不用手贴（见 ctx.pageFetch 分支）。显式传 cookie 的老路子仍然保留，
 * 用于没有页面上下文的场景（例如 Node 下的接口自测）。 */
const JJ_COMMENT_API = 'https://api.juejin.cn/interact_api/v1/comment/publish?aid=2608&spider=0';

export async function apiComment(body = {}, ctx = {}) {
  const pinId = String(body.pinId || '').trim();
  const content = String(body.content || '').trim().slice(0, 500);
  const cookie = String(body.cookie || '');
  const csrf = String(body.csrf || '');
  if (!pinId) return fail(400, '缺少沸点 ID');
  if (!content) return fail(400, '评论内容为空');

  const payload = {
    item_id: pinId,
    item_type: 4, // 4 = 沸点
    comment_content: content,
    comment_pics: [],
    client_type: 2608,
  };

  try {
    let data, httpStatus;
    if (typeof ctx.pageFetch === 'function') {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      if (csrf) headers['x-secsdk-csrf-token'] = csrf;
      const r = await ctx.pageFetch(JJ_COMMENT_API, payload, 'POST', headers, 15_000);
      httpStatus = r.http;
      data = r.body || {};
    } else {
      if (!cookie) return fail(401, '未配置掘金 Cookie');
      const headers = Object.assign({}, JJ_HEADERS, { cookie });
      if (csrf) headers['x-secsdk-csrf-token'] = csrf;
      const upstream = await fetch(JJ_COMMENT_API, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      httpStatus = upstream.status;
      data = await upstream.json().catch(() => ({}));
    }

    if (httpStatus < 200 || httpStatus >= 300) return fail(502, '掘金接口 HTTP ' + httpStatus);
    if (data.err_no !== 0) {
      /* 常见错误翻译成可操作提示 */
      let msg = data.err_msg || ('err_no=' + data.err_no);
      if (data.err_no === 2190 || /登录/.test(msg)) msg = '掘金登录态失效，请刷新页面重新登录';
      if (/csrf/i.test(msg)) msg = 'CSRF 校验失败，请在配置里补 x-secsdk-csrf-token';
      return fail(502, msg);
    }
    return ok({ ok: true });
  } catch (e) {
    const isAbort = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return fail(502, isAbort ? '掘金接口超时（15s）' : String((e && e.message) || e));
  }
}

/* ---------------- /api/comments 沸点评论列表 ----------------
 * 读某条沸点下的一级评论，供 AI 卡里的评论栈逐条翻阅。
 * 掘金接口：POST interact_api/v1/comment/list {item_id, item_type:4, cursor, limit}
 *
 * ⚠️ 这是「一条沸点一次」的读请求。前端只在当前这张牌上按需拉（还带防抖），
 * 不要改成整副牌预取——60 条沸点就是 60 次上游调用，那正是要避免的限流形态。
 * 带 10 分钟内存缓存：同一张牌来回翻不会重复打上游。 */
const JJ_CMT_API = 'https://api.juejin.cn/interact_api/v1/comment/list?aid=2608&spider=0';
const CMT_TTL = 10 * 60 * 1000;
const CMT_MAX = 200;
const cmtCache = new Map(); // pinId -> { at, payload }

function normalizeComment(c) {
  const ci = (c && c.comment_info) || {};
  const u = (c && c.user_info) || {};
  const pics = (ci.comment_pics || [])
    .map((x) => (x && (x.pic_url || x.url || x.src)) || '')
    .filter(Boolean)
    .slice(0, 4);
  return {
    id: String(ci.comment_id || (c && c.comment_id) || ''),
    content: stripHtml(ci.comment_content || ''),
    user: String(u.user_name || '掘友'),
    avatar: String(u.avatar_large || u.avatar_url || ''),
    digg: Number(ci.digg_count) || 0,
    reply: Number(ci.reply_count) || 0,
    ctime: Number(ci.ctime) || 0,
    author: !!(c && c.is_author),
    pics,
  };
}

export async function apiComments({ pinId } = {}, ctx = {}) {
  const id = String(pinId || '');
  if (!/^\d{6,}$/.test(id)) return { status: 400, body: { comments: [], error: '缺少或非法的沸点 ID' } };
  const hit = cmtCache.get(id);
  if (hit && Date.now() - hit.at < CMT_TTL) return ok(hit.payload);
  try {
    const payload = { item_id: id, item_type: 4, cursor: '0', limit: 20 };
    let data, httpStatus;
    if (typeof ctx.pageFetch === 'function') {
      const r = await ctx.pageFetch(JJ_CMT_API, payload, 'POST', {}, 15_000);
      httpStatus = r.http;
      data = r.body || {};
    } else {
      const upstream = await fetch(JJ_CMT_API, {
        method: 'POST',
        headers: JJ_HEADERS,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      httpStatus = upstream.status;
      data = await upstream.json().catch(() => ({}));
      if (httpStatus < 200 || httpStatus >= 300) throw new Error('掘金接口 HTTP ' + httpStatus);
    }
    if (httpStatus < 200 || httpStatus >= 300) throw new Error('掘金接口 HTTP ' + httpStatus);
    if (data.err_no !== 0) throw new Error(data.err_msg || ('err_no=' + data.err_no));
    const comments = (data.data || []).map(normalizeComment).filter((c) => c.id);
    const out = {
      comments,
      total: Number(data.count) || comments.length,
      hasMore: !!data.has_more,
    };
    if (cmtCache.size >= CMT_MAX) cmtCache.clear();
    cmtCache.set(id, { at: Date.now(), payload: out });
    return ok(out);
  } catch (e) {
    const isAbort = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    const msg = isAbort ? '掘金接口超时（15s）' : String((e && e.message) || e);
    return { status: 502, body: { comments: [], error: msg } };
  }
}

/* ---------------- /api/roast/config ----------------
 * 站点版回的是「服务端 .ai-config.json 里配了哪些」；扩展里没有服务端文件，
 * 所以固定回 false —— 于是 app.js 的 AI 配置弹窗不会显示「服务端已配置」，
 * 用户就在弹窗里正常填 OpenAI 兼容接口，配置存在扩展页自己的 localStorage 里。
 * 保留这个路由是为了让 app.js 的探测逻辑拿到 200，而不是 404。 */
export function apiRoastConfig() {
  /* 字段形状与 serve.mjs 的同名路由对齐（多了 serverCfg / providerId / api /
   * providersOverride 这几个新字段），这样前端那份探测代码在两端跑同一套逻辑。 */
  return ok({
    serverKey: false,
    serverCfg: false,
    baseUrl: '',
    model: '',
    providerId: '',
    api: '',
    jjCookie: false,
    providersOverride: 0,
  });
}

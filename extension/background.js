/* background.js — MV3 service worker
 * 定时抓掘金最新沸点、增量去重、更新角标、按需生成 AI 犀利点评。
 */
const API_RECOMMEND = 'https://api.juejin.cn/recommend_api/v1/short_msg/recommend?aid=2608&spider=0';
const API_COMMENTS = 'https://api.juejin.cn/interact_api/v1/comment/list';
const API_PUBLISH = 'https://api.juejin.cn/interact_api/v1/comment/publish';
const API_DIGG = 'https://api.juejin.cn/interact_api/v1/digg/save';

const K = {
  pins: 'pins',
  roasts: 'roasts',
  cfg: 'settings',
  meta: 'meta',
  seen: 'seenIds',
  focus: 'focusPin',
};

const DEFAULT_CFG = {
  aiProvider: 'off',            // off | openai
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  personas: ['毒舌', '冷幽默'],
  autoFetch: false,
  everyMinutes: 15,
  notify: false,
  tone: 'sharp',
  signature: '',
};

const now = () => Date.now();
const sget = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
const sset = (o) => new Promise((r) => chrome.storage.local.set(o, r));

async function getCfg() {
  const cfg = await sget(K.cfg);
  return Object.assign({}, DEFAULT_CFG, cfg || {});
}

const TOPIC_RE = /\[(\d+)#([^#\]]+)#\]/g;
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function normalize(it) {
  const m = it.msg_Info || {};
  const au = (it.author_user_info && it.author_user_info.user_name !== undefined)
    ? it.author_user_info : (m.author_user_info || {});
  const raw = m.content || '';
  const topics = [];
  let mm;
  TOPIC_RE.lastIndex = 0;
  while ((mm = TOPIC_RE.exec(raw))) topics.push(mm[2]);
  const pics = (m.pic_list || []).map((p) => p.url || p.pic_url).filter(Boolean);
  const id = String(m.msg_id || it.msg_id || '');
  return {
    id,
    content: stripHtml(raw.replace(TOPIC_RE, '')),
    topics,
    ctime: Number(m.ctime || 0),
    digg: m.digg_count || 0,
    cmt: m.comment_count || 0,
    user: au.user_name || '掘友',
    company: au.company || '',
    job: au.job_title || '',
    avatar: au.avatar_large || '',
    pics,
    url: 'https://juejin.cn/pin/' + id,
    fetchedAt: now(),
  };
}

async function fetchPins(limit = 20, sortType = 300, cursor = '0') {
  const res = await fetch(API_RECOMMEND, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id_type: 4, sort_type: sortType, cursor: String(cursor), limit }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.err_no !== 0 && !data.data) throw new Error(data.err_msg || '接口异常');
  return {
    list: (data.data || []).map(normalize).filter((x) => x.id && x.content),
    cursor: data.cursor || '',
    hasMore: !!data.has_more,
  };
}

/** 拉取一轮最新沸点并入库（去重，保留新到的） */
async function refresh(opts = {}) {
  const cfg = await getCfg();
  const limit = opts.limit || 20;
  const pages = opts.pages || 1;
  const stored = (await sget(K.pins)) || [];
  const seen = (await sget(K.seen)) || [];
  const seenSet = new Set(seen);
  const have = new Set(stored.map((p) => p.id));

  let cursor = '0';
  const fresh = [];
  for (let i = 0; i < pages; i++) {
    let r;
    try {
      r = await fetchPins(limit, 300, cursor);
    } catch (e) {
      await sset({ [K.meta]: { lastError: String(e), lastTry: now() } });
      return { ok: false, error: String(e), added: 0 };
    }
    for (const p of r.list) {
      if (!have.has(p.id)) {
        have.add(p.id);
        fresh.push(p);              // 本轮新到（含首次拉取的全部）
        if (opts.markSeen !== false) seenSet.add(p.id);
      }
    }
    cursor = r.cursor;
    if (!r.hasMore || !cursor) break;
  }

  const merged = fresh.concat(stored).slice(0, 600);
  await sset({
    [K.pins]: merged,
    [K.seen]: Array.from(seenSet).slice(-4000),
    [K.meta]: {
      lastTry: now(),
      lastOk: now(),
      lastError: '',
      total: merged.length,
      lastAdded: fresh.length,
    },
  });

  // 新到且未读 -> 角标
  const unread = merged.filter((p) => !seenSet.has(p.id)).length;
  chrome.action.setBadgeText({ text: unread > 99 ? '99+' : (unread || '') });
  chrome.action.setBadgeBackgroundColor({ color: '#ff6a2c' });

  if (cfg.notify && fresh.length) {
    chrome.notifications.create('pins-' + now(), {
      type: 'basic',
      iconUrl: 'icons/128.png',
      title: '沸点抽卡 · 有新沸点',
      message: `抓到 ${fresh.length} 条新沸点：${fresh[0].content.slice(0, 40)}`,
    });
  }
  return { ok: true, added: fresh.length, fresh };
}

/* ---------------- AI 点评 ---------------- */

const PERSONA_RULES = {
  '毒舌': '毒舌：铺垫一句、反转收尾，切口锋利，但吐槽的是现象和行业逻辑，绝不攻击发帖人本人。',
  '冷幽默': '冷幽默：面不改色地说反话，越正经越好笑，收尾一句轻飘飘的暴击。',
  '工科直男': '工科直男：用工程/数据视角解构这件事，一本正经地得出离谱结论。',
  '温柔一刀': '温柔一刀：先共情再补刀，语气体谅，但最后一句很准。',
  '命题作文': '命题作文：把它当成一个社会观察命题，给出一个短评式结论。',
};

const SOFT_KEYWORDS = ['抑郁', '疾病', '住院', '自杀', '去世', '死了', '癌症', '焦虑症',
  '裁员', '被裁', '约谈', '失业', '房贷', '亏损', '降薪', '维权', '仲裁', '赔偿'];

function buildPrompt(pin, cfg) {
  const soft = SOFT_KEYWORDS.some((k) => pin.content.includes(k));
  const personas = (cfg.personas || []).slice(0, 3);
  const rules = personas.map((p) => PERSONA_RULES[p] || PERSONA_RULES['毒舌']).join('\n');
  const tone = soft
    ? '这条内容涉及个人处境（疾病/失业/财务等），必须收起机灵，只写一句真诚、不煽情、不说教的人话。'
    : '可以犀利，但只针对现象、行业逻辑、平台规则，不针对发帖人。';
  const lines = [
    '你在给掘金沸点（程序员社区短帖）配一句中文点评，作者是社区用户。',
    '要求：',
    '1. 每条 20~50 字，一句话为主，最多两句，不要列点、不要标题、不要 emoji、不要引号包裹。',
    '2. 直接输出该版本点评，不要任何解释和前缀。',
    '3. 不做政治、领土、民族、宗教相关评论；涉及时只谈内容里安全的那一半。',
    '4. ' + tone,
    '同时给出这几个性格版本的点评，用 JSON 输出。',
    '',
    '作者：' + pin.user + (pin.company ? '（' + pin.company + '）' : ''),
    '话题：' + (pin.topics.join('、') || '无'),
    '正文：' + pin.content.slice(0, 1200),
    '',
    '性格要求：',
    rules,
  ];
  if (cfg.extraPrompt) lines.push('', '额外要求：' + cfg.extraPrompt);
  lines.push('',
    '输出格式（严格 JSON，不要 markdown 代码块）：',
    '{"roasts":[{"persona":"性格名","text":"点评"}],"tags":["2到3个字的关键词"]}');
  return lines.join('\n');
}

function extractJson(text) {
  const s = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('返回里没找到 JSON');
  return JSON.parse(s.slice(a, b + 1));
}

async function callAI(pin, cfg) {
  if (cfg.aiProvider !== 'openai') throw new Error('没配置 AI 接口，去设置页填一下');
  if (!cfg.apiKey) throw new Error('没填 API Key');
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + cfg.apiKey,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.95,
      messages: [
        { role: 'system', content: '你是一个中文社区短评写手，语言克制、准确、有幽默感，从不说教。' },
        { role: 'user', content: buildPrompt(pin, cfg) },
      ],
    }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('AI 接口 ' + res.status + '：' + txt.slice(0, 200));
  let data;
  try { data = JSON.parse(txt); } catch (e) { throw new Error('AI 返回不是 JSON'); }
  const content = data.choices && data.choices[0] && data.choices[0].message
    && data.choices[0].message.content;
  if (!content) throw new Error('AI 返回为空');
  const parsed = extractJson(content);
  let roasts = (parsed.roasts || []).filter((r) => r && r.text).map((r) => ({
    persona: String(r.persona || '犀利').slice(0, 8),
    text: String(r.text).replace(/^["「『]|["」』]$/g, '').trim(),
  }));
  if (!roasts.length) roasts = [{ persona: '犀利', text: String(content).trim().slice(0, 120) }];
  return {
    roasts,
    tags: (parsed.tags || []).map((t) => String(t).slice(0, 6)).slice(0, 4),
    at: now(),
    model: cfg.model,
  };
}

/** 为指定沸点生成点评（带本地缓存） */
async function roastFor(id, force) {
  const cache = (await sget(K.roasts)) || {};
  if (!force && cache[id]) return { ok: true, roast: cache[id], cached: true };
  const pins = (await sget(K.pins)) || [];
  const pin = pins.find((p) => p.id === id);
  if (!pin) return { ok: false, error: '这条沸点不在本地库里' };
  const cfg = await getCfg();
  try {
    const r = await callAI(pin, cfg);
    cache[id] = r;
    await sset({ [K.roasts]: cache });
    return { ok: true, roast: r, cached: false };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** 批量预生成：给最新 n 条还没点评的补上 */
async function roastBatch(n = 5) {
  const pins = (await sget(K.pins)) || [];
  const cache = (await sget(K.roasts)) || {};
  const todo = pins.filter((p) => !cache[p.id]).slice(0, n);
  const out = [];
  for (const p of todo) out.push({ id: p.id, ...(await roastFor(p.id)) });
  return out;
}

/* ---------------- 互动（走用户自己已登录的页面上下文） ---------------- */

/** 在掘金页面上下文里发一个请求（带上用户的 cookie）；没有掘金标签页就临时开一个 */
async function juejinFetch(url, payload, method) {
  const run = async (u, p, m) => {
    const r = await fetch(u, {
      method: m || 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: p ? JSON.stringify(p) : undefined,
    });
    const t = await r.text();
    try { return { http: r.status, body: JSON.parse(t) }; }
    catch (e) { return { http: r.status, body: { err_no: -1, err_msg: t.slice(0, 300) } }; }
  };
  const tabs = await chrome.tabs.query({ url: '*://*.juejin.cn/*' });
  let tab = tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://juejin.cn/pins', active: false });
    await new Promise((resolve) => {
      const h = (id, info) => {
        if (id === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(h); resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(h);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(h); resolve(); }, 9000);
    });
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: run,
    args: [url, payload || null, method || 'POST'],
  });
  return result;
}

async function diggPin(pinId, on) {
  const r = await juejinFetch(API_DIGG, { id: pinId, type: 4, digg: !!on });
  return r ? r.body : { err_no: -1, err_msg: 'no-tab' };
}

async function publishComment(pinId, content) {
  const r = await juejinFetch(API_PUBLISH, {
    item_id: pinId,
    item_type: 4,
    comment_content: content,
    client_request_id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
  });
  return r ? r.body : { err_no: -1, err_msg: 'no-tab' };
}

/* ---------------- 在本页弹出牌面浮层 ---------------- */

/** 往指定标签页注入 frame.js，把牌面浮层盖在当前网页上 */
async function injectFloat(tabId) {
  if (!tabId) return { ok: false, error: '没拿到标签页' };
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url && /^(chrome|edge|about|devtools|chrome-extension|view-source|chrome-search):/i.test(tab.url)) {
      return { ok: false, error: '浏览器内部页面不允许注入' };
    }
  } catch (e) { /* 拿不到 tab 信息就当普通页面处理 */ }

  try {
    // 已注入就复用（frame.js 里自己判断"已开则关"），否则补一次
    await chrome.scripting.insertCSS({ target: { tabId }, css: '' }).catch(() => {});
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['frame.js'],
    });
    await sset({ floatOpen: true, floatTab: tabId, floatAt: now() });
    return { ok: true, frameId: r && r.frameId };
  } catch (e) {
    // 兜底：有些页面（如 chrome:// / 商店页）executeScript 会直接拒绝
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------------- 消息路由 ---------------- */

const handlers = {
  refresh: (m) => refresh(m.opts || {}),
  inject: (m) => injectFloat(m.tabId),
  setFloatOpen: async (m) => { await sset({ floatOpen: !!m.open }); return { ok: true }; },
  floatOpened: (m) => { sset({ floatTitle: String(m.title || '').slice(0, 120) }); return { ok: true }; },
  getState: async () => {
    const [pins, roasts, cfg, meta, seen] = await Promise.all(
      [K.pins, K.roasts, K.cfg, K.meta, K.seen].map((k) => sget(k)));
    return {
      pins: pins || [],
      roasts: roasts || {},
      cfg: Object.assign({}, DEFAULT_CFG, cfg || {}),
      meta: meta || {},
      seen: seen || [],
      defaultCfg: DEFAULT_CFG,
      softKeywords: SOFT_KEYWORDS,
    };
  },
  roast: (m) => roastFor(m.id, m.force),
  roastBatch: (m) => roastBatch(m.n || 5),
  saveCfg: async (m) => { await sset({ [K.cfg]: Object.assign({}, DEFAULT_CFG, m.cfg || {}) }); return { ok: true }; },
  markSeen: async (m) => {
    const seen = (await sget(K.seen)) || [];
    const set = new Set(seen.concat(m.ids || []));
    await sset({ [K.seen]: Array.from(set).slice(-4000) });
    const pins = (await sget(K.pins)) || [];
    const unread = pins.filter((p) => !set.has(p.id)).length;
    chrome.action.setBadgeText({ text: unread > 99 ? '99+' : (unread || '') });
    return { ok: true, unread };
  },
  digg: (m) => diggPin(m.id, m.on),
  comment: (m) => publishComment(m.id, m.content),
  pinComments: async (m) => {
    const r = await juejinFetch(API_COMMENTS, {
      item_id: m.id, item_type: 4, cursor: m.cursor || '0', limit: 20,
    });
    return r ? r.body : { err_no: -1, err_msg: 'no-tab' };
  },
  openOptions: async () => { chrome.runtime.openOptionsPage(); return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) { sendResponse({ ok: false, error: 'unknown type: ' + (msg && msg.type) }); return false; }
  Promise.resolve(fn(msg))
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // 异步响应
});

/* ---------------- 生命周期 ---------------- */

async function setupAlarm() {
  const cfg = await getCfg();
  const all = await chrome.alarms.getAll();
  all.filter((a) => a.name === 'pinsRefresh').forEach((a) => chrome.alarms.clear(a.name));
  if (cfg.autoFetch) {
    chrome.alarms.create('pinsRefresh', { periodInMinutes: Math.max(5, cfg.everyMinutes || 15) });
  }
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'pinsRefresh') refresh({ pages: 2 }); });
chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarm();
  refresh({ pages: 1 });
});
chrome.runtime.onStartup.addListener(() => { setupAlarm(); refresh({ pages: 1 }); });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch[K.cfg]) setupAlarm();
});

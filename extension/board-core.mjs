/* board-core.mjs — 魔鬼榜单的内核（站点 serve.mjs 与扩展 api.mjs 共用同一份）
 *
 * 为什么单独抽一个模块：榜单的「抓取 → 筛候选 → AI 打分 → 组榜」这条链路
 * 有 300 行左右的纯逻辑，而站点（Node）和扩展（service worker）只是
 * 「缓存放哪、怎么发起」不同。逻辑写两遍 = 两套口径，迟早漂移。
 * 所以这里只放环境无关的部分，四样东西由调用方注入：
 *
 *   fetchPage(cursor, limit, sortType)  → { pins:[归一化后的], cursor, hasMore }
 *   resolveAi(body)                     → providers.resolve() 的结果
 *   loadCache(range) / saveCache(range, payload, at)
 *   now()
 *
 * 归一化（normalizePin）刻意不在这里 —— serve.mjs 与 api.mjs 各有一份，
 * 再抄第三份就是三处漂移源。调用方的 fetchPage 直接返回归一化结果。
 *
 * ---- 与设计文档的对应 ----
 * 六赛道 / 互斥归榜 / 48 条候选 / 热度只决定入围不决定名次 / 榜单宪章，
 * 全部对应 docs/devil-board-spec.md 的第一、三、五节。
 */

import * as provMod from './providers.js';
/* 与 api.mjs 同一套取法：Node 走 default（CJS），扩展走 globalThis（UMD 挂的）。 */
const providers = (provMod && provMod.default) || globalThis.JBProviders || null;
if (!providers) throw new Error('providers.js 未加载');

/* ---------------- 六个赛道（spec 第一节） ----------------
 *
 * ⚠️ `color` 不只是装饰，它同时是「封面牌赛道名 / 名次 / 分数」和
 *    「详情大牌分数 / 判词 / 进度」的唯一色源。
 *    2026-09-24 视觉改版时按「封面牌形象插画」重新校准过三个：
 *      absurd 橙→琥珀：插画角色本身就是 #FF7A1A 橙，标题同色会糊在一起；
 *      blah   灰→墨灰 ：插画是黑线稿，参考图的「废话榜」也几乎是黑的；
 *      emo    藏蓝→青绿：插画角色是青绿（#4ECDAF），藏蓝标题完全对不上。
 *    改这四个字母之前先看一眼 assets/board-cards/ 里对应的那张图。
 *
 * ✅ v0.6.0 起**封面牌重新吃 `color`**：封面改回自绘版式之后，
 *    赛道名 / 名次 / 分数 / 两侧符号全都重新用赛道色驱动（见 spec §11.11）。
 *    中间两版（v0.5.0 / v0.5.1）封面是**整张位图**、吃不了色，所以那一度被撤掉。
 *    校准色值时看的参考图应是 `char-<id>.png`（抠出来的角色）与 `art-<id>.png`（插画带）——
 *    ⚠️ 别拿已删除的 `face-*.png` 当依据。
 *    2026-09-25 实拍核对过三个：absurd 琥珀 / blah 墨灰 / emo 青绿，
 *    对应角色主色分别是橙 #FF7A1A、黑线稿、青绿 #4ECDAF。 */
export const TRACKS = [
  { id: 'venom',    name: '毒舌榜', def: '骂得最狠，而且最准',   color: '#FF5A3C', symbol: 'fire',
    dims: ['攻击性', '精准度', '共鸣'],
    anchors: '攻击性 · 精准度 · 共鸣' },
  { id: 'absurd',   name: '离谱榜', def: '逻辑最崩，还理直气壮', color: '#F5A524', symbol: 'question',
    dims: ['荒谬度', '自信度反差', '反驳空间'],
    anchors: '荒谬度 · 自信度反差 · 反驳空间' },
  { id: 'passive',  name: '阴阳榜', def: '表面客气，体内捅刀',   color: '#A855F7', symbol: 'yinyang',
    dims: ['隐晦度', '反讽强度', '表面礼貌反差'],
    anchors: '隐晦度 · 反讽强度 · 表面礼貌反差' },
  { id: 'stubborn', name: '嘴硬榜', def: '错了也绝不认',         color: '#1E80FF', symbol: 'shield',
    dims: ['死不认错程度', '事实偏差', '理直气壮度'],
    anchors: '死不认错程度 · 事实偏差 · 理直气壮度' },
  { id: 'blah',     name: '废话榜', def: '说了很多，等于没说',   color: '#454D57', symbol: 'bubble',
    dims: ['信息密度', '术语密度', '字数反差'],
    anchors: '信息密度（越低分越高）· 术语密度 · 字数/信息量反差' },
  { id: 'emo',      name: 'emo 榜', def: '深夜破防，上班如上坟', color: '#12A173', symbol: 'cloud',
    dims: ['情绪浓度', '共鸣广度', '自嘲刀法'],
    anchors: '情绪浓度 · 共鸣广度 · 自嘲刀法' },
];

export const TRACK_BY_ID = Object.fromEntries(TRACKS.map((t) => [t.id, t]));

/* ---------------- 抓取规格（spec 第二节的实测结论） ---------------- */

/* 日榜必须用 300（时间序）：翻 60 页只够到 1.76 天，但日榜只要 1 天，40 页绰绰有余。
 * 周榜必须用 200（热度序）：300 翻到底也摸不到 7 天，200 约 30 页覆盖一周。
 * ⚠️ ctime 不是严格降序 → 不能「翻到昨天 0 点就早停」，必须整段翻完再按 ctime 过滤。 */
export const RANGE_SPEC = {
  day:  { sortType: 300, maxPages: 40, label: '日榜' },
  week: { sortType: 200, maxPages: 45, label: '周榜' },
};

export const CANDIDATE_N = 48;   // 入围条数（spec 第三节）
export const PER_TRACK   = 12;   // 每榜最多展示多少张（设计稿画了 12 张作示例，不是上限）

const DAY_MS = 86400e3;

/* ⚠️ 踩过的坑：掘金返回的 `ctime` 是**秒**（10 位），而 JS 的时间全是毫秒。
 * 项目其它地方（data.js / /api/pins / app.js 的 fmtTime）一律按秒存，
 * 所以归一化不能动 —— 只能在「比较时间」之前就地换算。
 * 判据用 4e10：毫秒时间戳从 1970 到 3000 年都在 1e12 量级，秒则在 1e9~1e10。 */
export const toMs = (t) => {
  const v = Number(t) || 0;
  return v > 4e10 ? v : v * 1000;
};

/* 时间窗起点：日榜 = 今天 0 点（本地时区），周榜 = 7 天前这一刻。 */
export function rangeStart(range, now) {
  if (range === 'week') return now - 7 * DAY_MS;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* 落盘文件名用的键：日榜按自然日，周榜按 ISO 周（跨周自动换文件，也就自动失效）。 */
export function rangeKey(range, now) {
  const d = new Date(now);
  if (range === 'week') return 'week-' + isoWeek(d);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return 'day-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function isoWeek(d) {
  /* ISO 8601：以周四所在的那一周为第 1 周 */
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - y0) / DAY_MS + 1) / 7);
  return t.getUTCFullYear() + '-W' + (w < 10 ? '0' : '') + w;
}

/* 缓存有效期：日榜 6 小时；周榜活到本自然周结束（下一个 ISO 周就是另一个文件了）。 */
export function cacheTtl(range) {
  return range === 'week' ? Infinity : 6 * 3600e3;
}

/* ---------------- 第一段 · 入围（确定性，不烧 token） ---------------- */

/* 热度分：点赞与评论都取对数再加权 —— 原始计数差三个量级，
 * 不取对数会让「点赞多」直接等于「入围」，那就退化成热帖榜了。 */
export function heat(p) {
  return Math.log1p(Math.max(0, p.digg || 0)) * 0.6 +
         Math.log1p(Math.max(0, p.cmt || 0)) * 0.4;
}

export const MIN_CONTENT = 12;   // 正文 ≥ 12 字；纯图 / 纯链接（无正文）直接出局

export function pickCandidates(pins, n = CANDIDATE_N) {
  const seen = new Set();
  const rows = [];
  for (const p of pins || []) {
    if (!p || !p.id || seen.has(p.id)) continue;
    const text = String(p.content || '').trim();
    if (text.length < MIN_CONTENT) continue;
    seen.add(p.id);
    rows.push(p);
  }
  rows.sort((a, b) => heat(b) - heat(a));
  return rows.slice(0, n);
}

/* ---------------- 翻页抓取 ---------------- */

/* 翻完整段再按 ctime 过滤。onPage 让「已扫描 x 条」这个进度能实时报出去。 */
export async function fetchRange({ range, fetchPage, now, onPage, delayMs = 250 }) {
  const spec = RANGE_SPEC[range] || RANGE_SPEC.day;
  const start = rangeStart(range, now);
  const seen = new Set();
  const out = [];
  let cursor = '0';
  let pages = 0;

  for (let i = 0; i < spec.maxPages; i++) {
    const r = await fetchPage(cursor, 20, spec.sortType);
    const list = (r && r.pins) || [];
    pages++;
    if (!list.length) break;
    let pageMax = 0;
    for (const p of list) {
      if (!p || !p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      const ct = toMs(p.ctime);
      if (ct > pageMax) pageMax = ct;
      out.push(p);
    }
    if (onPage) onPage({ pages, scanned: out.length });
    if (!r.hasMore || !r.cursor) break;
    /* 整页都比窗口还旧 → 再翻也只会更旧。留 1 页余量，防 ctime 轻微乱序。 */
    if (pageMax && pageMax < start && i >= 1) break;
    cursor = r.cursor;
    if (delayMs) await sleep(delayMs);
  }

  const end = now + 60e3;
  return out.filter((p) => toMs(p.ctime) >= start && toMs(p.ctime) <= end);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 第二段 · 定名次（AI） ---------------- */

const CHUNK = 8;   // 8 条/次 → 48 条约 6 次请求（spec 第三节）

function scorePrompt(n) {
  const lines = TRACKS.map((t) => '- ' + t.id + ' ' + t.name + '：' + t.anchors).join('\n');
  const keys = TRACKS.map((t) => '"' + t.id + '"').join(',');
  return '你是掘金「魔鬼榜单」的评分员。下面给你 ' + n + ' 条掘金沸点（编号 1~' + n + '），' +
    '为每一条同时打 6 个赛道的分。\n\n' +
    '赛道（一条沸点只归属它得分最高的那一个）：\n' + lines + '\n\n' +
    '⚠️ 分数必须有区分度，不要都往高分挤：只有**真正典型**地属于某个赛道的内容才给 8 分以上；' +
    '只是"沾一点边"的给 4~6 分；完全不属于的一律 1~3 分。' +
    '一条沸点最多只有一个赛道拿到 6 分以上 —— 这就是它归属的那个榜。\n\n' +
    '每条输出一个对象，字段固定：\n' +
    '{"i": 编号, "s": {' + keys + '}, "d": [最高赛道的三个维度分], ' +
    '"v": "一句判词", "skip": false}\n' +
    '· s 里每个分数 1~10，保留一位小数；d 按上面赛道括号里的维度顺序给三个分。\n' +
    '· v 是判词：犀利幽默、一针见血、口语化，不超过 24 字，**不攻击作者本人**。\n\n' +
    '榜单宪章（硬边界，不可违反）：只评内容、不评人；禁止基于作者身份、公司、' +
    '职位、地域、外貌评分。涉政、涉黄、人身攻击、指向真实姓名的条目，' +
    '一律只回 {"i": 编号, "skip": true}，不要给任何分数。\n\n' +
    '严格按编号顺序输出一个 JSON 数组，长度必须等于 ' + n + '。' +
    '只输出 JSON 数组本身，不要代码块标记、不要解释、不要任何额外文字。';
}

/* 单次上游调用：请求形状由 providers 按协议拼，这里只给原料。 */
async function callModel(ai, { system, user, maxTokens, temperature, timeoutMs }) {
  const q = providers.buildRequest(ai, { system, user, maxTokens, temperature });
  const upstream = await fetch(q.url, {
    method: q.method,
    headers: q.headers,
    body: JSON.stringify(q.body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(providers.parseError(ai, upstream.status, data));
  const raw = providers.parseReply(ai, data).trim();
  if (!raw) throw new Error(providers.parseError(ai, upstream.status, data) || 'AI 返回了空内容');
  return raw;
}

/* 把一次回复解析成 [{i, s:{…}, d:[…], v, skip}]，编号越界 / 结构不对的条目丢弃。
 * 返回 null 表示这整块没救（调用方按失败处理）。 */
export function parseScoreChunk(raw, n) {
  const arr = providers.extractJsonArray(raw, n);
  if (!arr) return null;
  const out = [];
  for (let k = 0; k < n; k++) {
    const cell = arr[k];
    if (cell === null || cell === undefined) { out.push({ i: k + 1, skip: true, bad: true }); continue; }
    let o = cell;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
    if (!o || typeof o !== 'object') { out.push({ i: k + 1, skip: true, bad: true }); continue; }
    if (o.skip) { out.push({ i: k + 1, skip: true }); continue; }
    const s = {};
    for (const t of TRACKS) {
      const v = Number(o.s && o.s[t.id]);
      if (Number.isFinite(v)) s[t.id] = clamp(v, 1, 10);
    }
    const d = (Array.isArray(o.d) ? o.d : []).map((x) => clamp(Number(x) || 0, 0, 10)).slice(0, 3);
    out.push({
      i: k + 1,
      s,
      d,
      v: String(o.v || '').trim().slice(0, 60),
      /* 6 个赛道一个有效分都没有 → 当成没答 */
      skip: Object.keys(s).length === 0,
    });
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* 逐块打分（单飞，不并发 —— 榜单是后台任务，没必要抢配额，稳比快重要）。
 *
 * ⭐ v0.8.0：`onProgress` 除了 `done/total`，还带 `dealt` —— **本块每条内容
 *   被分到哪个赛道**（含没上榜的）。这是「评分中发牌」动画唯一的数据源：
 *   前端要靠它知道哪张牌该飞进哪一摞。
 *   为什么要等整轮打完才有：`assignTrack` 要等 6 个赛道的分都齐了才知道归属，
 *   而 AI 是分块给的 —— 所以最快只能「一块回来就发一批」，
 *   正好对上一手 8 张的节奏。 */
export async function scoreCandidates({ candidates, ai, onProgress, mock }) {
  if (mock) return mockScore(candidates, onProgress);
  const rows = [];
  for (let off = 0; off < candidates.length; off += CHUNK) {
    const chunk = candidates.slice(off, off + CHUNK);
    const listText = chunk.map((p, i) =>
      (i + 1) + '. ' + (p.topic && p.topic !== '沸点' ? '【' + p.topic + '】' : '') +
      String(p.content || '').replace(/\s+/g, ' ').slice(0, 220)
    ).join('\n');

    let parsed = null;
    let lastErr = null;
    /* 同一块最多试 2 次：超时/限流值得再试一次，但**不三次重试**（spec 第五节：
     * 宪章判定的拒答不追问，网络抖动才重试）。 */
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const raw = await callModel(ai, {
          system: scorePrompt(chunk.length),
          user: listText,
          maxTokens: Math.min(4000, 320 * chunk.length + 200),
          temperature: 0.4,
          timeoutMs: Math.min(120_000, 15_000 + chunk.length * 8_000),
        });
        parsed = parseScoreChunk(raw, chunk.length);
        if (!parsed) throw new Error('AI 未按要求返回 JSON 数组');
      } catch (e) {
        lastErr = e;
        await sleep(attempt === 0 ? 1200 : 0);
      }
    }
    if (!parsed) throw new Error('打分失败：' + ((lastErr && lastErr.message) || '未知错误'));

    parsed.forEach((r, k) => {
      const p = chunk[k];
      if (!p) return;
      rows.push(Object.assign({ pin: p }, r));
    });
    if (onProgress) {
      /* 本块的分配明细。⚠️ 只带前端发牌要用的最小字段：
       *   pinId / trackId / score / ranked / verdict 前 12 字 / content 摘头。
       *   不带 dims（发牌动画不画维度条），也不带整条 pin（带宽 8 倍）。 */
      const dealt = parsed.map((r, k) => {
        const p = chunk[k] || {};
        const a = assignTrack(r);
        return {
          pinId: String(p.id || ''),
          trackId: a.trackId,
          score: Math.round(a.score * 10) / 10,
          ranked: a.ranked,
          title: String(p.content || '').replace(/\s+/g, ' ').slice(0, 24),
          verdict: String(r.v || '').slice(0, 16),
        };
      });
      onProgress({ done: Math.min(off + CHUNK, candidates.length), total: candidates.length, dealt });
    }
  }
  return rows;
}

/* ---- 演示用假分数（?mock=1 / --mock）----
 * 用 id 的哈希做种子，同一条沸点每次得到同一组分数，所以前端能稳定复现；
 * 判词从模板里挑，只为把版式撑起来。payload 会带 mock:true，界面也会标明。
 * ⭐ v0.8.0：分块回报（与真打分同一条 onProgress 形状），否则本地联调看不到发牌动画。 */
async function mockScore(candidates, onProgress) {
  const MOCK_CHUNK_MS = 620;   // 一手牌的间隔，让演示模式也看得出「在发牌」
  const VERDICTS = {
    venom: ['这句话的杀伤力，属于把天聊死的艺术', '骂得有理有据，被骂的人还得点头', '刀法精准，连标点都在嘲讽'],
    absurd: ['前后两句自己跟自己吵架', '这逻辑，绕进去了三个弯还理直气壮', '离谱到让人怀疑是反串'],
    passive: ['表面上在夸，细品全是在骂', '客气是真的，刀也是真的', '好话说到第三句就变味了'],
    stubborn: ['证据都摆脸上了，还能接着辩', '错得明明白白，态度依然坚定', '承认一下错误比登天还难'],
    blah: ['说了三百字，有效信息两条', '术语堆了一片，结论等于没说', '读完了，又好像什么都没读'],
    emo: ['半夜三点的字，白天不敢发', '这几个字背后是整宿没睡', '共鸣的人太多了，多到有点心酸'],
  };
  const rnd = (seed) => { let x = seed % 2147483647; if (x <= 0) x += 2147483646;
    return () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; }; };
  /* 逐条算分但**分块回报** —— 与真打分保持同一条 onProgress 形状
     （{done,total,dealt}），前端只有一套渲染路径。 */
  const rows = [];
  for (let off = 0; off < candidates.length; off += CHUNK) {
  const chunk = candidates.slice(off, off + CHUNK);
  const dealt = [];
  chunk.forEach((p, k) => {
    const idx = off + k;
    let h = 2166136261;
    for (const ch of String(p.id)) { h ^= ch.codePointAt(0); h = (h * 16777619) >>> 0; }
    const r = rnd(h || (idx + 1));
    const s = {};
    let bi = 0, bv = -1;
    TRACKS.forEach((t, i) => {
      /* 分布与线上提示词对齐：偏中低分、上限 8.5（提示词要求「只有真正典型的才给 8 分以上」）。
       * 用 r()^1.7 把质量压向低分段，否则六榜封面全是 9 分起，看不出区分度。 */
      const v = Math.round((2.6 + Math.pow(r(), 1.7) * 5.9) * 10) / 10;
      s[t.id] = v;
      if (v > bv) { bv = v; bi = i; }
    });
    const t = TRACKS[bi];
    const base = s[t.id];
    /* 同样对齐提示词里的互斥约束：一条最多一个赛道 ≥6 分，其余压到 6 以下 */
    TRACKS.forEach((x) => {
      if (x.id !== t.id && s[x.id] >= 6) s[x.id] = Math.round((3.2 + r() * 2.4) * 10) / 10;
    });
    const v = VERDICTS[t.id][Math.floor(r() * VERDICTS[t.id].length)];
    rows.push({ pin: p, i: idx + 1, s, d: [Math.min(10, base + 0.2), base, Math.max(1, base - 0.3)]
      .map((x) => Math.round(x * 10) / 10), v, skip: false });
    /* dealt 的形状必须与真打分那条一模一样（前端只有一套渲染路径）。
     * ⚠️ `ranked` / `trackId` **必须走 assignTrack**，不能写死 true：
     *   写死的话，一条最高分 < 6 的候选会在发牌时飞进某一摞，
     *   但 assembleBoards 又会把它判为不上榜 —— 用户看到六摞有 8 张，
     *   成品榜里却找不到，数字对不上。演示模式下这个不一致特别容易撞上
     *   （mock 的分布刻意压向低分段）。 */
    const a = assignTrack({ s, skip: false });
    dealt.push({ pinId: String(p.id || ''), trackId: a.trackId,
      score: Math.round(a.score * 10) / 10, ranked: a.ranked,
      title: String(p.content || '').replace(/\s+/g, ' ').slice(0, 24), verdict: v.slice(0, 16) });
  });
  /* 演示模式也让出帧，动画才看得出来在发（真打分是网络等待，天然有间隔） */
  if (onProgress) {
    onProgress({ done: Math.min(off + CHUNK, candidates.length), total: candidates.length, dealt });
    await sleep(MOCK_CHUNK_MS);
  }
  }
  return rows;
}

/* ---------------- 组榜：每条只进得分最高的那一个榜 ---------------- */

/* ⭐ **归榜判定单独抽出来**（原来这段逻辑内嵌在 assembleBoards 里）。
 *
 * 为什么要抽：v0.8.0「评分中发牌」需要**在打分当场**就知道每条要去哪个赛道
 * —— 牌得飞进对应的那一摞里。而 AI 是分块返回的（CHUNK=8），
 * 一块回来就��按这个函数判一次、报一次进度。
 * 如果判定还埋在 assembleBoards 里（它要等**全部**打完才跑），
 * 那前端就永远拿不到中途的分配结果，只能等两分钟看一个转圈。
 *
 * 判定口径一个字没改（还是「取最高分，< 6 分不上榜」），
 * 只是从「最后算」提到「算完一块就算一块」，两边共用同一个函数保证不漂移。 */
export function assignTrack(row) {
  if (!row || row.skip || !row.s) return { trackId: null, score: 0, ranked: false };
  let best = null;
  for (const t of TRACKS) {
    const v = row.s[t.id];
    if (!Number.isFinite(v)) continue;
    if (!best || v > best.v) best = { id: t.id, v };
  }
  /* 六个赛道都低于 6 分的，不上榜 —— 榜单宁可空着，不硬凑第一名（spec 第五节） */
  if (!best || best.v < 6) return { trackId: null, score: best ? best.v : 0, ranked: false };
  return { trackId: best.id, score: best.v, ranked: true };
}

export function assembleBoards(rows, { perTrack = PER_TRACK, generatedAt, meta } = {}) {
  const buckets = Object.fromEntries(TRACKS.map((t) => [t.id, []]));
  for (const r of rows) {
    const a = assignTrack(r);
    if (!a.ranked) continue;
    buckets[a.trackId].push({ r, score: a.score });
  }

  const boards = TRACKS.map((t) => {
    const list = buckets[t.id]
      .sort((a, b) => b.score - a.score)
      .slice(0, perTrack)
      .map((x, i) => {
        const p = x.r.pin;
        const dims = (x.r.d || []).slice(0, 3).map((v, k) => ({ k: t.dims[k] || ('维度' + (k + 1)), v }));
        return {
          rank: i + 1,
          id: p.id,
          user: p.user || '掘友',
          avatar: p.avatar || '',
          content: String(p.content || ''),
          topic: p.topic || '沸点',
          url: p.url || ('https://juejin.cn/pin/' + p.id),
          ctime: p.ctime || 0,
          digg: p.digg || 0,
          cmt: p.cmt || 0,
          score: Math.round(x.score * 10) / 10,
          dims,
          verdict: x.r.v || '',
        };
      });
    return { id: t.id, name: t.name, def: t.def, color: t.color, symbol: t.symbol, top: list };
  });

  return Object.assign({
    generatedAt: generatedAt || Date.now(),
    candidates: rows.length,
    boards,
  }, meta || {});
}

/* ---------------- 构建任务状态机 ----------------
 * 一次全量抓取 20~45 秒、上千条，AI 再花 1~2 分钟 —— 榜单绝不能实时算。
 * 所以这里做成「后台任务 + 轮询」：
 *   ensure(range)  第一次调用只负责把任务起起来，立刻返回状态快照
 *   snapshot(range) 之后每次轮询读它
 * 这样 HTTP 请求不会挂 3 分钟（会超时、会让人以为页面死了）。
 */
export function createBoardEngine({ fetchPage, resolveAi, loadCache, saveCache, now, mock }) {
  const jobs = new Map(); // range -> { state, progress, payload, error, at, promise }

  function snapshot(range) {
    const j = jobs.get(range);
    if (!j) return { status: 'idle' };
    return {
      status: j.state,
      progress: j.progress || null,
      payload: j.payload || null,
      error: j.error || null,
      stale: !!j.stale,
      at: j.at || 0,
    };
  }

  /* fresh=true 忽略内存与磁盘缓存，强制重建。 */
  async function ensure(range, opts = {}) {
    const useMock = opts.mock === undefined ? !!mock : !!opts.mock;
    const fresh = !!opts.fresh;
    const cur = jobs.get(range);
    if (cur && cur.state === 'building') return snapshot(range);
    if (cur && cur.state === 'ready' && !fresh) return snapshot(range);

    if (!fresh) {
      let hit = null;
      try { hit = await loadCache(range); } catch { hit = null; }
      if (hit && hit.payload) {
        const ttl = cacheTtl(range);
        const fresh0 = ttl === Infinity
          ? rangeKey(range, now()) === rangeKey(range, hit.at || hit.payload.generatedAt || 0)
          : (now() - (hit.at || 0)) < ttl;
        if (fresh0) {
          jobs.set(range, { state: 'ready', payload: hit.payload, at: hit.at || 0, promise: null });
          return snapshot(range);
        }
        /* 过期但有旧结果：先把旧的端上去（标「旧」），后台悄悄重建 ——
         * 「宁可显示旧榜单，也不让人对着转圈等两分钟」。 */
        const job = { state: 'building', progress: { phase: 'scan', scanned: 0, pages: 0 },
                      payload: hit.payload, stale: true, error: null, at: hit.at || 0 };
        jobs.set(range, job);
        job.promise = run(range, useMock, job, opts.ai);
        return snapshot(range);
      }
    }

    const job = { state: 'building', progress: { phase: 'scan', scanned: 0, pages: 0 },
                  payload: null, stale: false, error: null, at: 0 };
    jobs.set(range, job);
    job.promise = run(range, useMock, job, opts.ai);
    return snapshot(range);
  }

  async function run(range, useMock, job, aiBody) {
    try {
      /* 1) 抓取 */
      const pins = await fetchRange({
        range,
        fetchPage,
        now: now(),
        onPage: (p) => { job.progress = { phase: 'scan', scanned: p.scanned, pages: p.pages }; },
      });
      const candidates = pickCandidates(pins);
      if (!candidates.length) {
        job.state = 'ready';
        job.payload = assembleBoards([], { generatedAt: now(), meta: { scanned: pins.length, empty: true } });
        job.stale = false;
        job.progress = null;
        return;
      }

      /* 2) 打分 */
      job.progress = { phase: 'score', scanned: pins.length, candidates: candidates.length, done: 0 };
      /* aiBody：调用方（站点=请求体 / 扩展=页面 localStorage 里的配置）交上来的「怎么调」。
       * 站点没传时靠 serve.mjs 自己那套服务端配置，两边同一份 providers.resolve。 */
      const ai = await resolveAi(aiBody || {});
      /* ⭐ v0.8.0「评分中发牌」：`dealtLog` 累积每一批的分配结果。
       * 为什么要**累积**而不是只留最新一批：前端是 1.3s 轮询，
       * 而 AI 一批要十几秒 —— 不累积的话轮询只能看到最后一批（8 张），
       * 中间发出去的牌会「凭空消失」，六摞的牌数还会来回跳。 */
      const dealtLog = [];
      const rows = await scoreCandidates({
        candidates, ai, mock: useMock,
        onProgress: (p) => {
          if (p.dealt && p.dealt.length) dealtLog.push(...p.dealt);
          job.progress = { phase: 'score', scanned: pins.length,
                           candidates: candidates.length, done: p.done, dealt: dealtLog.slice() };
        },
      });

      /* 3) 组榜 + 落盘 */
      const payload = assembleBoards(rows, {
        generatedAt: now(),
        meta: { scanned: pins.length, mock: useMock, range },
      });
      job.state = 'ready';
      job.payload = payload;
      job.stale = false;
      job.progress = null;
      job.at = now();
      try { await saveCache(range, payload, job.at); } catch { /* 落盘失败不影响本次展示 */ }
    } catch (e) {
      /* 失败不清旧结果：payload 留着，前端标「旧」（spec 第七节 系统状态）。 */
      job.state = 'failed';
      job.error = String((e && e.message) || e);
      job.progress = null;
    }
  }

  return {
    ensure,
    snapshot,
    /* `peek(range)` —— **纯只读**读内存/磁盘缓存，**绝不**起任务。
     *
     * 为什么需要它：榜期卡展开时要把「对面那一档」的规模也摆出来做对照
     * （spec §6.7）。但对面那档通常还没算过 —— 走 ensure() 会**直接触发
     * 一次真评分**：翻 45 页 + 一两分钟 AI + 烧 token。用户只是「看一眼
     * 周榜有多少张」，却等了一分钟还花了钱，这绝对不行。
     *
     * 所以这里是「有就返回、没有就 null」，绝不兜底去跑。
     * ⚠️ 前端拿到 null 要显示「尚未生成」，**不能**当成 0（0 会被误读成空榜）。
     */
    async peek(range) {
      const cur = jobs.get(range);
      if (cur && cur.payload) {
        return { status: cur.state === 'failed' ? 'failed' : 'ready',
                 payload: cur.payload, stale: !!cur.stale, at: cur.at || 0 };
      }
      try {
        const hit = await loadCache(range);
        if (hit && hit.payload) {
          return { status: 'ready', payload: hit.payload, stale: false, at: hit.at || 0 };
        }
      } catch { /* 读盘失败就当没有 */ }
      return null;
    },
    /* 供 ?wait=1 / 脚本自测：把当前这一轮 await 完 */
    wait(range) {
      const j = jobs.get(range);
      return j && j.promise ? j.promise.then(() => snapshot(range)) : Promise.resolve(snapshot(range));
    },
  };
}

/* ---------------- 响应形状（spec 第四节） ---------------- */

export function boardResponse(range, snap) {
  if (snap.status === 'ready' || (snap.status === 'failed' && snap.payload)) {
    return Object.assign({}, snap.payload, {
      range,
      stale: !!(snap.stale || snap.status === 'failed'),
      status: snap.status === 'failed' ? 'failed' : 'ready',
      error: snap.error || null,
    });
  }
  if (snap.status === 'failed') {
    return { range, status: 'failed', error: snap.error || '生成失败', boards: [] };
  }
  return { range, status: 'building', progress: snap.progress || null, boards: [] };
}

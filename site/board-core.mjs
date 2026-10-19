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

/* 翻完整段再按 ctime 过滤。onPage 让「已扫描 x 条」这个进度能实时报出去。
 * ⭐ v1.3.1 `shouldStop`：**提前结束**用的协作式打断 —— 每页之间查一次，
 *   用户点「提前结束」就不再翻下一页，已扫到的条目照常交给打分阶段
 *   （「以当前读取的数据为准」）。页内正在飞的那一个请求让它飞完，
 *   不做硬中断：漏半页的代价远小于实现复杂度。 */
export async function fetchRange({ range, fetchPage, now, onPage, delayMs = 250, shouldStop }) {
  const spec = RANGE_SPEC[range] || RANGE_SPEC.day;
  const start = rangeStart(range, now);
  const seen = new Set();
  const out = [];
  let cursor = '0';
  let pages = 0;

  for (let i = 0; i < spec.maxPages; i++) {
    if (shouldStop && shouldStop()) break;
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

/* 单次上游调用：请求形状由 providers 按协议拼，这里只给原料。
 * v1.3.1 多了一个可选 `signal`（提前结束用）：与超时信号合并 ——
 * AbortSignal.any 是 20+ 才有，老环境自动退化成「只有超时能断」，
 * 提前结束就等这一手飞完（页间/块间检查仍然即时生效）。 */
async function callModel(ai, { system, user, maxTokens, temperature, timeoutMs, signal }) {
  const q = providers.buildRequest(ai, { system, user, maxTokens, temperature });
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  const sig = (signal && AbortSignal.any) ? AbortSignal.any([timeoutSig, signal]) : timeoutSig;
  const upstream = await fetch(q.url, {
    method: q.method,
    headers: q.headers,
    body: JSON.stringify(q.body),
    signal: sig,
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
export async function scoreCandidates({ candidates, ai, onProgress, mock, shouldStop, signal }) {
  if (mock) return mockScore(candidates, onProgress, shouldStop);
  const rows = [];
  let stopped = false;
  for (let off = 0; off < candidates.length; off += CHUNK) {
    if (shouldStop && shouldStop()) { stopped = true; break; }
    const chunk = candidates.slice(off, off + CHUNK);
    const listText = chunk.map((p, i) =>
      (i + 1) + '. ' + (p.topic && p.topic !== '沸点' ? '【' + p.topic + '】' : '') +
      String(p.content || '').replace(/\s+/g, ' ').slice(0, 220)
    ).join('\n');

    /* v1.3.1 「正在分析」上报：**块开始时**把这一手的标题清单报出去，
     * UI 才能显示「AI 正在看什么」（回来后被 done/dealt 覆盖，间隙由
     * 前端拿上一手的落位提示补位）。 */
    if (onProgress) {
      onProgress({ done: off, total: candidates.length,
        now: chunk.map((p) => String(p.content || '').replace(/\s+/g, ' ').slice(0, 18)) });
    }

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
          signal,
        });
        parsed = parseScoreChunk(raw, chunk.length);
        if (!parsed) throw new Error('AI 未按要求返回 JSON 数组');
      } catch (e) {
        /* 提前结束把这一手打断了：不重试、直接按「已打完的算」收工 */
        if (signal && signal.aborted) { stopped = true; break; }
        lastErr = e;
        await sleep(attempt === 0 ? 1200 : 0);
      }
    }
    if (stopped) break;
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
  /* 提前结束时把标记挂在返回数组上（assembleBoards 只认数组形状，多一个
   * 属性不影响它；调用方拿它写 meta.stopped）。 */
  rows.stopped = stopped;
  return rows;
}

/* ---- 演示用假分数（?mock=1 / --mock）----
 * 用 id 的哈希做种子，同一条沸点每次得到同一组分数，所以前端能稳定复现；
 * 判词从模板里挑，只为把版式撑起来。payload 会带 mock:true，界面也会标明。
 * ⭐ v0.8.0：分块回报（与真打分同一条 onProgress 形状），否则本地联调看不到发牌动画。 */
async function mockScore(candidates, onProgress, shouldStop) {
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
  let stopped = false;
  for (let off = 0; off < candidates.length; off += CHUNK) {
  if (shouldStop && shouldStop()) { stopped = true; break; }
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
  /* 演示模式也让出帧，动画才看得出来在发（真打分是网络等待，天然有间隔）。
   * 块开始时同样报 `now`（正在分析的一手）—— 与真打分同一条形状。 */
  if (onProgress) {
    onProgress({ done: off, total: candidates.length,
      now: chunk.map((p) => String(p.content || '').replace(/\s+/g, ' ').slice(0, 18)) });
    await sleep(Math.round(MOCK_CHUNK_MS / 3));
    onProgress({ done: Math.min(off + CHUNK, candidates.length), total: candidates.length, dealt });
    await sleep(MOCK_CHUNK_MS);
  }
  }
  rows.stopped = stopped;
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
  const jobs = new Map(); // range -> { state, runId, t0, progress, payload, error, at, promise, stopReq, cancelReq, aborter }

  /* 本轮任务的标识（v1.3.3）。
   *
   * 为什么需要：dev server 重启 / 扩展 SW 被回收之后，内存里的 jobs Map 整个没了，
   * 但前端还在按 1.3s 轮询。下一个请求要么是从磁盘缓存重建（看起来像 ready），
   * 要么因为 fresh=1 重新起一轮 —— 都是「服务端换了一轮」。
   * 前端手里的旧 runId 兑不上新人 ⇒ 就能判断出「这不是我发起的那一轮」，
   * 提示用户而不是把一轮全新扫描的进度当成自己那次的，静默接受。
   *
   * 时间戳 + 5 位随机后缀：同一毫秒内同时起日榜/周榜（切换榜期会立刻两手并发）
   * 也不至于撞号。 */
  const nextRunId = () => String(now()) + '-' + Math.random().toString(36).slice(2, 7);

  /* ---- 撤销（v1.3.3）的收尾：把 job 恢复成「这轮评过分根本没发生过」 ----
   *
   * 为什么抽成函数：四个闸门（扫描后 / 空榜组榜前 / 打分后 / 落盘前）做的是同一件事，
   * 抄四遍必然漂移，而漂移的表现是「点了撤销却还能看到半份新榜」—— 很难查。
   *
   * 两条结局按「撤销前这一档有没有旧 payload」分叉：
   *   · 有旧 payload（过期静默重建 / 上一轮失败留的底）→ 恢复成 ready + 那份旧榜，
   *     stale 归位成 false：它进来时就看着这份榜，对它来说这不是「过期副本」。
   *     ⚠️ runId 也退回 null —— 旧 payload 不是本轮产物，挂本轮的号会让前端误以为
   *        撤销后的 ready 是「我发起的那一轮跑完了」。
   *   · 没有旧 payload（点「重新评分」走的就是这一支：ensure(fresh=1) 不读缓存，
   *     job.payload 天生是 null）→ **留一个 state:'cancelled' 的空壳**，不能删。
   *
   *     ⚠️ 为什么**不能**用 jobs.delete(range)（v1.3.3 第一版就是这么写的）：
   *        删掉之后这一档就变成了「从没算过」，而日榜是**会 ensure() 自启**的 ——
   *        刷新页面 / 切榜期回来 / boot 的下一个请求就会重新拉一轮 45 页扫描。
   *        用户点撤销的意图是「别算了」，反手自动再开一轮是最坏结果，且违背撤销语义。
   *        空壳的作用就是给 ensure() 一道闸：非 fresh 的请求撞上它直接回快照、绝不起跑，
   *        必须等用户明确再点一次「重新评分」（fresh=1）。
   *        前端也**本来就要有 canceled 态**（交互规范 T13：日榜首评撤销 → 已撤销卡），
   *        它不是多出来的分支，只是现在才有了数据源。
   *
   * ⚠️ 这里**绝不能**调 saveCache，也**绝不能**去删磁盘缓存：磁盘上存的是**上一轮**
   *    的产物（可能还是上周的），本轮半途算出来的东西一个字节都不许落，
   *    上一轮的产物也不能因为这次撤销被删 —— 留着，让它按 TTL 自己过期。 */
  function cancelRestore(range, job) {
    /* cancelled 标记独立于 state 存在：
     * 有旧 payload 那一条路恢复出来的是 **ready**，从 payload / runId 上都看不出
     * 「这是撤销回来的旧榜」还是「刚跑完的新榜」。前端刷新页面后自己的本地标记会丢，
     * 那时会把旧榜的 ready 误读成「刚跑完」而弹一次结果卡 ——
     * 把它挂在这里，随快照一起下发，frontend 不用自持状态也能分辨。 */
    job.cancelled = true;
    const prevPayload = job.payload;
    const prevAt = job.at;
    if (prevPayload) {
      job.state = 'ready';
      job.payload = prevPayload;
      job.at = prevAt || 0;
      job.stale = false;
      job.progress = null;
      job.error = null;
      job.runId = null;
      job.stopReq = false;
      job.cancelReq = false;
      job.aborter = null;
      return;
    }
    job.state = 'cancelled';
    job.payload = null;
    job.progress = null;
    job.error = null;
    job.runId = null;
    job.at = 0;
    job.stale = false;
    job.stopReq = false;
    job.cancelReq = false;
    job.aborter = null;
  }

  function snapshot(range) {
    const j = jobs.get(range);
    /* idle 也补齐同形状的键：调用方（boardResponse）不用到处判空，
     * 前端读 `runId: null` 也比「这个字段压根不存在」好判断。 */
    if (!j) return { status: 'idle', progress: null, payload: null, error: null, stale: false, at: 0, runId: null };
    return {
      status: j.state,
      progress: j.progress || null,
      payload: j.payload || null,
      error: j.error || null,
      stale: !!j.stale,
      at: j.at || 0,
      /* v1.3.3：这一档是不是**撤销过**的。与 state 分开是因为「有旧榜的那条路」
       * 会恢复成 ready —— 光看 state 分不出「撤销回来的旧榜」和「刚跑完的新榜」，
       * 而前端刷新页面后自己的本地标记会丢，得由这里兜住。 */
      cancelled: !!j.cancelled,
      /* runId 随快照一路下发（boardResponse 会把它带上），
       * 前端轮询比对的依据就是它。没有正在跑的任务（周榜没算过 / 已撤销）时为 null ——
       * ⚠️ 前端比对前必须先判空，否则「两侧都没有」会被误判成「换了」。 */
      runId: j.runId || null,
    };
  }

  /* fresh=true 忽略内存与磁盘缓存，强制重建。 */
  async function ensure(range, opts = {}) {
    const useMock = opts.mock === undefined ? !!mock : !!opts.mock;
    const fresh = !!opts.fresh;
    const cur = jobs.get(range);
    if (cur && cur.state === 'building') return snapshot(range);
    if (cur && cur.state === 'ready' && !fresh) return snapshot(range);
    /* ⚠️ 撤销过的档位：**非用户主动就绝不自动起跑**。
     * 这道闸是 `cancelRestore()` 留那个 state:'cancelled' 空壳的唯一理由 ——
     * 少了它，「点了撤销」在下次刷新 / 切榜期回来 / boot 时会变成「又跑一轮 45 页扫描」，
     * 直接违背撤销的语义（用户说的是「别算了」）。
     * 判据是 `!fresh`：fresh=1 来自「重新评分 / 开始评分」按钮，那是用户明确要跑，
     * 照常放行（并且会用一个全新的 job 顶掉这个空壳）。 */
    if (cur && cur.state === 'cancelled' && !fresh) return snapshot(range);

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
    /* v1.3.3 这两样必须在函数的**同步段**里先落好：
     * ensure() 是在 `job.promise = run(...)` 之后立刻 `return snapshot(range)` 的，
     * 而 run() 会一直同步执行到 fetchRange 里的第一个 await ——
     * 所以此刻写进 job.progress 的 runId，前端在这一次 HTTP 响应里就能拿到。
     * 放到第一个 await 之后 = 轮询的第一帧没有 runId = 前端认不出任务。 */
    job.t0 = now();          // 本轮耗时（ms）的起点，组榜时会写进 meta.ms
    job.runId = nextRunId();
    /* 新一轮的开始要清掉「此档撤销过」的痕迹：空壳 job 被 fresh=1 重新启用时，
     * 或是同一份 job 对象被别的地方复用时，都不能把上一次的 cancelled 带进新结果。
     * ⚠️ 必须在同步段（与 runId/t0 同理）。 */
    job.cancelled = false;
    if (job.progress) job.progress.runId = job.runId;   // 起手那一帧补上 runId
    try {
      /* 提前结束（stopReq）与撤销（cancelReq）是**两个独立标记**，但共用同一套
       * 协作式打断：只看 stopReq 的话，撤销请求既打不断翻页/分块，
       * 又会被当成「用户要提前收尾」继续往下组榜。 */
      const interrupted = () => !!job.stopReq || !!job.cancelReq;
      /* 1) 抓取（v1.3.1：shouldStop = 提前结束 —— 用户点了停就不再翻页，
       *   已扫到的照常交给打分，「以当前读取的数据为准」；v1.3.3 撤销同样走这里） */
      const pins = await fetchRange({
        range,
        fetchPage,
        now: now(),
        shouldStop: interrupted,
        onPage: (p) => { job.progress = { phase: 'scan', runId: job.runId, scanned: p.scanned, pages: p.pages,
                                          stopping: !!job.stopReq, cancelling: !!job.cancelReq }; },
      });
      /* 撤销闸门 ①：扫描阶段。翻页已经在上面被打断，这里是最早能收尾的地方 ——
       * 撤销**不往下组榜**，所以必须在此就返回，不能等到最后一道闸。 */
      if (job.cancelReq) { cancelRestore(range, job); return; }
      const stopped = !!job.stopReq;   // 中断产物：扫描被截断（或停止请求落在扫描后、打分中）
      const candidates = pickCandidates(pins);
      /* 撤销闸门 ②：空榜分支的组榜门槛 —— 这一道是我自己加的，原文的「三个检查点」
       * 里没有它，但没有它就不成立：`if (!candidates.length)` 排在组榜之前，
       * 它会**先一步改写 job.payload**（换成一份 `empty: true` 的空榜）。
       * ⚠️ 为什么必须拦：撤销之后让人看见「六摞全空」是最糟的一种半份新榜 ——
       *   它比「扫了一半的残缺榜」更像一次成功，**谎言更彻底**：用户会以为
       *   「今天确实没人上榜」，而不是「我撤销了」。而且这一支不落盘，
       *   磁盘上还是旧榜，只有内存里被换掉了，连重开页面都对不上账。
       *   所以必须在 payload 被碰到之前收尾。 */
      if (job.cancelReq) { cancelRestore(range, job); return; }
      if (!candidates.length) {
        job.state = 'ready';
        job.payload = assembleBoards([], { generatedAt: now(),
          /* ms：本轮从起到组榜的真实耗时（v1.3.3）。meta 会被摊平进 payload 顶层，
           * 前端直接读 payload.ms 就能说「这次评了 78.4 秒」。 */
          meta: { scanned: pins.length, empty: true, stopped: stopped || undefined, ms: now() - job.t0 } });
        job.stale = false;
        job.progress = null;
        return;
      }

      /* 2) 打分 */
      job.progress = { phase: 'score', runId: job.runId, scanned: pins.length,
                       candidates: candidates.length, done: 0,
                       stopping: !!job.stopReq, cancelling: !!job.cancelReq };
      /* aiBody：调用方（站点=请求体 / 扩展=页面 localStorage 里的配置）交上来的「怎么调」。
       * 站点没传时靠 serve.mjs 自己那套服务端配置，两边同一份 providers.resolve。 */
      const ai = await resolveAi(aiBody || {});
      /* 提前结束要能打断正在飞的那一手 AI 请求（不只等它超时）：每个 job 一个
       * AbortController，stop() 时 abort —— fetchRange 那层不用它，页间检查就够。 */
      const aborter = new AbortController();
      job.aborter = aborter;
      /* ⭐ v0.8.0「评分中发牌」：`dealtLog` 累积每一批的分配结果。
       * 为什么要**累积**而不是只留最新一批：前端是 1.3s 轮询，
       * 而 AI 一批要十几秒 —— 不累积的话轮询只能看到最后一批（8 张），
       * 中间发出去的牌会「凭空消失」，六摞的牌数还会来回跳。 */
      const dealtLog = [];
      const rows = await scoreCandidates({
        candidates, ai, mock: useMock,
        shouldStop: interrupted,
        signal: aborter.signal,
        onProgress: (p) => {
          if (p.dealt && p.dealt.length) dealtLog.push(...p.dealt);
          job.progress = { phase: 'score', runId: job.runId, scanned: pins.length,
                           candidates: candidates.length, done: p.done, dealt: dealtLog.slice(),
                           now: p.now || null, stopping: !!job.stopReq, cancelling: !!job.cancelReq };
        },
      });
      /* 撤销闸门 ③：打分之后。这一支最要紧 —— 打分是整个流程里最长的一段
       * （48 条 / 6 手 / 一两分钟），撤销请求绝大多数会落在这一段的某一手之间，
       * 靠 cancel() 里那一记 abort 把正在飞的那手掐掉，然后就在这里收尾。 */
      if (job.cancelReq) { cancelRestore(range, job); return; }

      /* 撤销闸门 ④（最后一道闸）：组榜 + 落盘**之前**。
       * 拦在这儿是因为一旦越过它就是 saveCache —— 磁盘上的旧榜会被这半轮产物覆盖，
       * 而「覆盖缓存文件」在 memory-only 的扩展里看得出来、在站点上却要重开页面才看得出。
       * 提前结束的产物**就是**这轮的结果（用户说了算）：照常落盘复用，
       * 只在 payload 上标 stopped，让界面能说清「这份榜单是提前结束时按已读数据组的」。 */
      if (job.cancelReq) { cancelRestore(range, job); return; }
      const payload = assembleBoards(rows, {
        generatedAt: now(),
        meta: { scanned: pins.length, mock: useMock, range,
                stopped: (stopped || rows.stopped) || undefined,
                /* ms 同空榜分支：meta 会被摊平到 payload 顶层，前端读 payload.ms 即可 */
                ms: now() - job.t0 },
      });
      job.state = 'ready';
      job.payload = payload;
      job.stale = false;
      job.progress = null;
      job.at = now();
      job.aborter = null;
      try { await saveCache(range, payload, job.at); } catch { /* 落盘失败不影响本次展示 */ }
    } catch (e) {
      /* ⚠️ 撤销**不走**这条路径：上面四个闸门都显式「恢复状态 + return」，
       * 靠 throw 落进这里会留下 state:'failed' 和 job.error ——
       * 用户明明点了撤销，界面却弹出「生成失败：BodyStreamBuffer was aborted」，
       * 而且 payload 会被保留着当「旧榜」显示。
       * 下面这半句是**兜底**：万一最后一道闸之后还有东西能把 AbortError 抛出来，
       * 也按撤销处理，绝不替用户把主动撤销记成失败。 */
      if (job.cancelReq) { cancelRestore(range, job); return; }
      /* 失败不清旧结果：payload 留着，前端标「旧」（spec 第七节 系统状态）。 */
      job.state = 'failed';
      job.error = String((e && e.message) || e);
      job.progress = null;
      job.aborter = null;
    }
  }

  /* `peekImpl(range)` —— **纯只读**读内存/磁盘缓存，**绝不**起任务。
   *
   * 为什么需要它：榜期卡展开时要把「对面那一档」的规模也摆出来做对照
   * （spec §6.7）。但对面那档通常还没算过 —— 走 ensure() 会**直接触发
   * 一次真评分**：翻 45 页 + 一两分钟 AI + 烧 token。用户只是「看一眼
   * 周榜有多少张」，却等了一分钟还花了钱，这绝对不行。
   *
   * 所以这里是「有就返回、没有就 null」，绝不兜底去跑。
   * ⚠️ 前端拿到 null 要显示「尚未生成」，**不能**当成 0（0 会被误读成空榜）。
   * （写成具名函数而不是对象方法：hold() 要在闭包里直接调它。） */
  async function peekImpl(range) {
    const cur = jobs.get(range);
    /* ⚠️ state:'cancelled' 的空壳刻意**不影响**这里：它 payload 为空，会自然落到
     * 下面的读盘分支 —— 磁盘上有上一轮的产物就照旧回那份（「旧榜原地不动」，
     * 撤销不删磁盘），没有就回 null ⇒ 调用方给 status:'none'（周榜「还没评过分」）。
     * 也就是说 peek / hold 永远不会自己吐出 'cancelled' 这个状态，
     * 前端拿到的只有 none 或真实缓存，不存在第三种。 */
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
  }

  return {
    ensure,
    snapshot,
    /* v1.3.1 提前结束：置 stopReq 即可 —— 抓取停在页间、打分停在块间，
     * 正在飞的那一手 AI 请求顺手 abort（signal 已挂到 callModel）。
     * 之后这一轮照常走完「打分（剩下的不再打）→ 组榜 → 落盘」，
     * 前端轮询自然会看到 ready。对非 building 状态调用是无害空操作。 */
    stop(range) {
      const j = jobs.get(range);
      if (!j || j.state !== 'building') return false;
      j.stopReq = true;
      if (j.progress) j.progress = Object.assign({}, j.progress, { stopping: true });
      if (j.aborter) { try { j.aborter.abort(); } catch { /* 已飞完就算了 */ } }
      return true;
    },
    /* v1.3.3 撤销：置 cancelReq 即可 —— 打断的三个协作点（页间 / 块间 / 正在飞的
     * 那一手 AI）与 stop 共用同一套，区别只在 run() 撞上 cancelReq 时**整轮作废**：
     *   不组榜、不落盘、不让旧 payload 被任何半成品覆盖，
     *   job 恢复到「这轮没发生过」（有旧榜就回到那份旧榜，没有就当这一档从没算过）。
     *
     * ⚠️ 与 stop 的关系：两个标记**互不影响**，stopping 期间**仍然允许撤销** ——
     *    提前结束的产物此刻还没落盘，此时反悔想彻底作废完全来得及；
     *    反过来也一样，撤销之后再点提前结束就是空操作（job 已经不是 building 了）。
     *    （state:'cancelled' 的空壳吃 stop 同样是空操作 —— 那一轮早就不存在了。）
     *
     * ⚠️ abort 必须复用 job.aborter：signal 才是能掐掉「正在飞的那一手」的唯一把手，
     *    只置标记的话那一手会照常打完并返回，白烧那一手的 token（8 条 × 六赛道）。
     *
     * 对非 building 状态调用是幂等空操作（什么都不做，返回 false），
     * 调用方照常拿 snapshot() 包 boardResponse 回给前端。 */
    cancel(range) {
      const j = jobs.get(range);
      if (!j || j.state !== 'building') return false;
      j.cancelReq = true;
      if (j.progress) j.progress = Object.assign({}, j.progress, { cancelling: true });
      if (j.aborter) { try { j.aborter.abort(); } catch { /* 已飞完就算了 */ } }
      return true;
    },
    /* v1.3.1 周榜不自动：**只读现状、绝不 ensure** ——
     * building 就回快照（让前端接着轮询），否则等价 peek（缓存/none）。
     * 与 peek 的分工：peek 是「对面那档的对照数据」（UI 要 boards），
     * hold 是「这一档现在什么状态」（UI 要 building 进度或 none 门槛）。
     * ⚠️ state:'cancelled' 的空壳**刻意**落进 peek 那一支：周榜撤销后要回到
     *    「还没评过分」的入口卡（磁盘上有旧榜就照旧显示那份 —— 撤销不删磁盘产物）。 */
    async hold(range) {
      const cur = jobs.get(range);
      if (cur && cur.state === 'building') return snapshot(range);
      return peekImpl(range);
    },
    peek: peekImpl,
    /* 供 ?wait=1 / 脚本自测：把当前这一轮 await 完 */
    wait(range) {
      const j = jobs.get(range);
      return j && j.promise ? j.promise.then(() => snapshot(range)) : Promise.resolve(snapshot(range));
    },
  };
}

/* ---------------- 响应形状（spec 第四节） ---------------- */

export function boardResponse(range, snap) {
  /* v1.3.3 runId 一路带到协议层：前端轮询比对的依据就是它。
   * 注意它**不进 payload** —— payload 是要落盘的，把「某一轮任务的编号」
   * 写进缓存文件毫无意义，还会让下一轮读出来误以为是自己的。
   * ⚠️ 没有任务时为 null，前端比对前要判空。 */
  const runId = snap.runId || null;
  if (snap.status === 'ready' || (snap.status === 'failed' && snap.payload)) {
    return Object.assign({}, snap.payload, {
      range,
      stale: !!(snap.stale || snap.status === 'failed'),
      status: snap.status === 'failed' ? 'failed' : 'ready',
      error: snap.error || null,
      runId,
      /* 撤销过的那一档，恢复出的 ready（旧榜）也要带上标记 ——
       * 否则前端分不出「撤销回来的旧榜」与「刚跑完的新榜」，
       * 刷新页面丢了自己的本地标记后就会误弹一次结果卡。 */
      cancelled: !!snap.cancelled,
    });
  }
  if (snap.status === 'failed') {
    return { range, status: 'failed', error: snap.error || '生成失败', boards: [], runId };
  }
  /* v1.3.3 撤销（没有旧榜的那条路）：没有半点产物可给，但**必须是个静止态** ——
   * 落到 building 兜底会让前端「只在 ready/failed/none 时停轮询」的逻辑永不终止：
   * 转圈永久转、"重新评分"按钮永久 disabled、弹窗卡在「正在撤销…」。 */
  if (snap.status === 'cancelled') {
    return { range, status: 'cancelled', boards: [], runId: null, cancelled: true };
  }
  /* idle = 这一档在内存里连个 job 都没有（从来没起过任务的周榜等）。
   * 以前它会掉进下面的 building 兜底 —— 同一个坑（轮询永不落定），一并补掉。 */
  if (snap.status === 'idle') {
    return { range, status: 'none', boards: [], runId: null };
  }
  /* building：进度帧里自己也带了一份 runId（job.progress.runId），
   * 顶层再给一份是为了让前端有一处固定位置可读，不必先判 progress 在不在。 */
  return { range, status: 'building', progress: snap.progress || null, boards: [], runId };
}

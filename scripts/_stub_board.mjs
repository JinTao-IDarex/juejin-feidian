#!/usr/bin/env node
/* ⭐ 桩服务器：伺服 site/ 静态文件 + 回放**固定**的 /api/board progress 序列。
 *
 * 为什么需要它（别删，视觉验收全靠它）：
 *   board.js 的发牌视图只由 progress.dealt 驱动，而真链路要先抓掘金（网络抖动、
 *   限流、偶尔只回 20 条就空榜）+ 再等 AI 分 6 批 —— 慢且不确定，
 *   「等条件再截图」经常错过过程态，或者压根等不到。
 *   这里把网络那层换成一个可控脚本：几行 JSON 就能造出任意中间态
 *   （六摞长到第几手、发牌台剩几张、有多少条不够 6 分不上榜）。
 *
 * 用法：
 *   node scripts/_stub_board.mjs --port 7300 [--chunk 8] [--ms 620] [--scan 142] [--cand 48]
 *                               [--drop 5] [--range day]
 *   然后开 http://127.0.0.1:7300/board.html
 *
 * 行为：
 *   GET /api/board?range=X[&peek=1]  → building/ready 两态
 *     · 前 3.5s（或 --scanfor ms）phase=scan，scanned 递增到 --scan
 *     · 之后每 --ms 推一手：done += chunk，dealt 累积 chunk 条
 *       牌面用与board-core.mjs mockScore 同一套哈希，六赛道轮流，
 *       其中 --drop 条标 ranked:false（模拟「不够 6 分不上榜」）
 *     · done == cand 之后再等 1.2s → ready（payload 用 assembleBoards 同形）
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname, dirname } from 'node:path';

const argv0 = process.argv.slice(2);
const arg0 = (n, d) => { const i = argv0.indexOf('--' + n); return i >= 0 && argv0[i + 1] !== undefined ? argv0[i + 1] : d; };
/* --root site|extension：extension 走构建产物（board.html?embed=1 即 722 浮层档）。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', arg0('root', 'site'));
const argv = argv0;
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const PORT = Number(arg('port', 7300));
const CHUNK = Number(arg('chunk', 8));
const MS = Number(arg('ms', 620));
const SCAN = Number(arg('scan', 142));
const CAND = Number(arg('cand', 48));
const DROP = Number(arg('drop', 5));
/* --only <trackId>：所有牌只归这一个赛道，其余五个就是**空榜**。
 * 空榜是合法且常见的状态（分布天然偏斜），但随机分布下不一定每次都能撞到
 * 某条赛道为 0 —— 版式验收（名次显 0 / 分数显 — / 定义显「暂无上榜」）
 * 需要一个确定能造出来的空榜，否则只能靠运气等。 */
const ONLY = arg('only', '');
const SCANFOR = Number(arg('scanfor', 3500));
const HOLD = Number(arg('hold', 1200));
/* ⭐ --pauseat N：推到第 N 手就**冻住**，不再往后走（保持 building）。
 * 用来截图 —— 过程态只存在几秒，「等条件再截图」经常落在成品态上。
 * 每次截图配一个新端口的桩进程，因为计时器活在进程里、不会重置。 */
const PAUSEAT = Number(arg('pauseat', 0));

const TRACKS = [
  { id: 'venom', name: '毒舌榜', def: '骂得最狠，而且最准', color: '#FF5A3C', dims: ['攻击性', '精准度', '共鸣'] },
  { id: 'absurd', name: '离谱榜', def: '逻辑最崩，还理直气壮', color: '#F5A524', dims: ['荒谬度', '自信度反差', '反驳空间'] },
  { id: 'passive', name: '阴阳榜', def: '表面客气，体内捅刀', color: '#A855F7', dims: ['隐晦度', '反讽强度', '表面礼貌反差'] },
  { id: 'stubborn', name: '嘴硬榜', def: '错了也绝不认', color: '#1E80FF', dims: ['死不认错程度', '事实偏差', '理直气壮度'] },
  { id: 'blah', name: '废话榜', def: '说了很多，等于没说', color: '#454D57', dims: ['信息密度', '术语密度', '字数反差'] },
  { id: 'emo', name: 'emo 榜', def: '深夜破防，上班如上坟', color: '#12A173', dims: ['情绪浓度', '共鸣广度', '自嘲刀法'] },
];

/* 正文分三档长度轮换 —— 详情大牌的 .bc-text 会折 1/2/3 行，
 * 这样折行与纵向预算两条路径每次验收都会被走到（见 deal() 的注释）。 */
const CONTENT = [
  '今天上线前最后一次回归，测试同学说「你这个问题单上写的复现步骤我复现不出来」，我打开一看是缓存没清。',
  '我们组把「先上个测试环境」这句话说了三年，到现在测试环境还是那台谁都不敢动的虚拟机，重启一次要等半小时。',
  '需求评审的时候没人说话，排期的时候没人说话，等到上线炸了，群里突然全是说话的人，一条接一条，还都带着「我早就说过」。',
];
const VERDICTS = {
  venom: ['这句话的杀伤力，属于把天聊死的艺术', '骂得有理有据，被骂的人还得点头', '刀法精准，连标点都在嘲讽'],
  absurd: ['前后两句自己跟自己吵架', '这逻辑，绕进去三个弯还理直气壮', '离谱到让人怀疑是反串'],
  passive: ['表面上在夸，细品全是在骂', '客气是真的，刀也是真的', '好话说到第三句就变味了'],
  stubborn: ['证据都摆脸上了，还能接着辩', '错得明白白，态度依然坚定', '承认一下错误比登天还难'],
  blah: ['说了三百字，有效信息两条', '术语堆了一片，结论等于没说', '读完了，又好像什么都没读'],
  emo: ['半夜三点的字，白天不敢发', '这几个字背后是整宿没睡', '共鸣的人太多了，多到有点心酸'],
};

/* 与 board-core.mjs mockScore 同一套种子：同一条 id 每次得到同一组分数 */
function deal(i) {
  const id = 'stub' + i;
  let h = 2166136261;
  for (const ch of id) { h ^= ch.codePointAt(0); h = (h * 16777619) >>> 0; }
  let x = h % 2147483647; if (x <= 0) x += 2147483646;
  const r = () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; };
  const scores = TRACKS.map(() => Math.round((2.6 + Math.pow(r(), 1.7) * 5.9) * 10) / 10);
  let bi = 0; TRACKS.forEach((_, k) => { if (scores[k] > scores[bi]) bi = k; });
  /* 每 9 条里挑一条当「不够 6 分不上榜」，让第三种状态也出现在演示里。
   * --only 模式下不制造落选项：那时要验的是「五条空榜」，多一条落选只会干扰。 */
  const dropped = !ONLY && (i % 9 === 4) && i < DROP * 9;
  const t = ONLY ? (TRACKS.filter((x) => x.id === ONLY)[0] || TRACKS[bi]) : TRACKS[bi];
  const base = scores[bi];
  return {
    pinId: id, trackId: dropped ? null : t.id,
    score: dropped ? Math.round(Math.min(base, 5.5) * 10) / 10 : base,
    ranked: !dropped,
    title: '第 ' + (i + 1) + ' 条沸点的正文摘要这里',
    verdict: (VERDICTS[t.id][Math.floor(r() * 3)] || '').slice(0, 16),
    /* ⭐ 下面这些字段**一个都不能省**（与 board-core.mjs assembleBoards 的条目同形）。
     * 旧版只给 rank/score/verdict/title，后果是详情大牌的正文段、维度行、页脚
     * 全是空的 —— 实测 `.bc-text` 高度 0、页脚显示「赞 undefined」。
     * 也就是说**详情页的多行折行和纵向预算从来没被任何截图验过**，
     * 一个「正文写长了把底部按钮顶出卡外」的 bug 可以在这里静静躺着。
     * ⚠️ 这些 r() 调用必须放在 verdict **之后**（对象字面量按书写顺序求值），
     *    放在前面会把每条已定的赛道归属和分数全部错位。 */
    content: CONTENT[i % CONTENT.length],
    user: '桩用户' + ((i % 7) + 1),
    digg: 30 + ((i * 37) % 900),
    cmt: 3 + ((i * 13) % 120),
    url: 'https://juejin.cn/pin/' + id,
    ctime: 1760000000 - i * 37,
    dims: (t.dims || []).map((k, j) => ({ k, v: Math.round((2.6 + r() * 5.9) * 10) / 10 })),
  };
}

/* 预生成完整 dealt 序列 */
const ALL = [];
for (let i = 0; i < CAND; i++) ALL.push(deal(i));

function state(range, t0) {
  const el = Date.now() - t0;
  if (el < SCANFOR) {
    const k = Math.min(SCAN, Math.round(SCAN * el / SCANFOR));
    return { status: 'building', progress: { phase: 'scan', scanned: k, pages: Math.ceil(k / 20) } };
  }
  const total = Math.ceil(CAND / CHUNK);
  /* pauseat：把「可推进的批数」封顶，于是第 N 手之后永远停在那儿 */
  const cap = PAUSEAT > 0 ? Math.min(total, PAUSEAT) : total;
  const batches = Math.min(cap, Math.floor((el - SCANFOR) / MS));
  if (batches >= total) {
    if (el - SCANFOR < total * MS + HOLD) {
      return { status: 'building', progress: { phase: 'score', scanned: SCAN, candidates: CAND, done: CAND, dealt: ALL.slice() } };
    }
    /* ready 载荷按 board-core.mjs assembleBoards 的条目**逐字段**对齐
     * （以前只挑 4 个字段，详情页的正文/维度/页脚就永远是空的）。 */
    return {
      status: 'ready',
      boards: TRACKS.map((t) => ({
        ...t,
        top: ALL.filter((d) => d.ranked && d.trackId === t.id).map((d, k) => ({
          rank: k + 1,
          id: d.pinId,
          user: d.user,
          avatar: '',
          content: d.content,
          topic: '沸点',
          url: d.url,
          ctime: d.ctime,
          digg: d.digg,
          cmt: d.cmt,
          score: d.score,
          dims: d.dims,
          verdict: d.verdict,
        })),
      })),
      generatedAt: Date.now(),
      candidates: CAND,
    };
  }
  const done = Math.min(CAND, batches * CHUNK);
  return { status: 'building', progress: { phase: 'score', scanned: SCAN, candidates: CAND, done, dealt: ALL.slice(0, done) } };
}

const jobs = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const range = u.searchParams.get('range') === 'week' ? 'week' : 'day';
  if (u.pathname === '/api/board') {
    if (!jobs.has(range) || u.searchParams.get('fresh') === '1') jobs.set(range, Date.now());
    const s = state(range, jobs.get(range));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(s.status === 'ready'
      ? { ...s, range, stale: false, mock: true, scanned: SCAN, candidates: CAND }
      : { range, status: 'building', progress: s.progress, boards: [] }));
    return;
  }
  /* 静态：只伺服站内文件（防目录穿越） */
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/board.html';
  /* ⭐ /cards/ 是**虚拟路由**，站内并没有这个目录：
   *   站点版挂在 assets/board-cards/（与 site/serve.mjs:767 同一条），
   *   扩展构建产物自己带 cards/。
   *   不加这条的话用桩截图时六张卡面全是 404 —— 版式验收（卡面/发牌视图）
   *   会看到六张空白牌，很容易误判成「图片没渲染」而去改本来正确的 CSS。 */
  const IS_EXT = arg0('root', 'site') === 'extension';
  const isCards = p.indexOf('/cards/') === 0;
  const CARDS_DIR = IS_EXT ? join(ROOT, 'cards') : join(ROOT, '..', 'assets', 'board-cards');
  const base = isCards ? CARDS_DIR : ROOT;
  const file = join(base, isCards ? p.slice('/cards/'.length) : p);
  if (!file.startsWith(base)) { res.writeHead(403); res.end(); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + p);
  }
}).listen(PORT, '127.0.0.1', () => console.log('stub board on http://127.0.0.1:' + PORT + '/board.html'));
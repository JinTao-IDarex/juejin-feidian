/* _probe_api.mjs — 给移植后的 api.mjs 做接口自测（开发用，不进扩展包）
 *
 * 覆盖三件在浏览器里不好验的事：
 *   1) /api/roast 的批量 JSON 容错、缓存命中、错误文案，用一个假上游来打
 *      （不用真 Key，也不烧真配额）
 *   2) /api/comments 打真实掘金上游到底回什么（区分「接口不通」和「这条真没评论」）
 *   3) /api/pins 的归一化字段完整性
 *
 * 用法： node scripts/_probe_api.mjs
 */
import { createServer } from 'node:http';

import { apiPins, apiRoast, apiComments, apiComment } from '../extension/api.mjs';

const out = [];
const log = (s) => { out.push(s); console.log(s); };

/* ---------------- 1) 假上游：OpenAI 兼容 ---------------- */
let upstreamHits = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    /* /bad/* 一律 404：用来验「上游报错要原样透传」 */
    if (req.url.indexOf('/bad/') === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model not found' } }));
      return;
    }
    const payload = JSON.parse(body || '{}');
    upstreamHits.push(payload.messages && payload.messages[0] && payload.messages[0].content.slice(0, 12));
    const sys = String(payload.messages[0].content);
    let content;
    /* 批量模式的判据是系统提示里那句「本次给你 N 条」。
     * 探针原先用「长度 > 200」判，结果中文比想象中短（约 190），判错成单条，
     * 于是 misreport 成「AI 未按要求返回 JSON 数组」—— 是探针的锅，不是 api.mjs 的。 */
    if (sys.indexOf('本次给你') >= 0) {
      const m = sys.match(/本次给你 (\d+) 条/);
      const n = m ? Number(m[1]) : 3;
      const arr = [];
      for (let i = 0; i < n; i++) arr.push('点评' + (i + 1) + '：「这是一句测试点评」');
      content = '```json\n' + JSON.stringify(arr) + '\n```';
    } else {
      content = '「单条测试点评」';
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => fake.listen(7399, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:7399/v1';
const CFG = { baseUrl: BASE, token: 't', model: 'mock' };

/* ---------------- 2) /api/pins ---------------- */
{
  const r = await apiPins({ fresh: true });
  const pins = (r.body || {}).pins || [];
  const need = ['id', 'content', 'topic', 'ctime', 'digg', 'cmt', 'user', 'company', 'job', 'avatar', 'url', 'roast'];
  const missing = need.filter((k) => !(k in (pins[0] || {})));
  log(`[pins] status=${r.status} day=${r.body.day} n=${pins.length} 缺字段=${missing.length ? missing.join(',') : '无'}`);
  log(`[pins] 首条 topic=${pins[0].topic} user=${pins[0].user} ctime=${pins[0].ctime} url=${pins[0].url}`);
  log(`[pins] 免费统计：有公司名 ${pins.filter((p) => p.company).length}/${pins.length}，有头像 ${pins.filter((p) => p.avatar).length}/${pins.length}`);
}

/* ---------------- 3) /api/roast ---------------- */
{
  const a = await apiRoast(Object.assign({ content: '今天上线又回滚了', topic: '发布' }, CFG));
  log(`[roast] 单条 status=${a.status} roast=${JSON.stringify(a.body.roast)}`);

  const hitsAfterFirst = upstreamHits.length;
  const b = await apiRoast(Object.assign({ content: '今天上线又回滚了', topic: '发布' }, CFG));
  log(`[roast] 同内容再问：status=${b.status} 一致=${b.body.roast === a.body.roast} 新打上游=${upstreamHits.length - hitsAfterFirst}（应为 0，命中缓存）`);

  const items = [
    { id: '1', content: '一', topic: 'A' },
    { id: '2', content: '二', topic: 'B' },
    { id: '3', content: '三', topic: 'C' },
  ];
  const c = await apiRoast(Object.assign({ items }, CFG));
  log(`[roast] 批量 status=${c.status} 条数=${Object.keys(c.body.roasts || {}).length} 示例=${JSON.stringify(c.body.roasts['1'])} error=${c.body.error || '-'}`);

  const d = await apiRoast({ content: 'x' });
  log(`[roast] 缺配置 status=${d.status} msg=${d.body.error}`);

  const e = await apiRoast(Object.assign({ content: '空内容测试' }, CFG, { baseUrl: 'http://127.0.0.1:7399/bad' }));
  log(`[roast] 上游 404 status=${e.status} msg=${String(e.body.error).slice(0, 60)}`);
  log(`[roast] 上游总命中次数=${upstreamHits.length}（单条首问 1 + 批量 1；/bad 那条在计数前就早返回了，不计入）`);
}
fake.close();

/* ---------------- 4) /api/comments 打真实上游 ---------------- */
{
  /* 取「卡上评论数最多」的那条来验评论列表：首条沸点可能是真没评论，
   * 拿它测会把「接口通但没评论」误读成「接口不通」。 */
  const pr = await apiPins({});
  const list = (pr.body.pins || []);
  const withCmt = list.slice().sort((a, b) => (b.cmt || 0) - (a.cmt || 0))[0] || {};
  log(`[comments] 取样沸点 id=${withCmt.id} 卡上评论数=${withCmt.cmt}`);

  const r = await apiComments({ pinId: withCmt.id });
  log(`[comments] 直连分支 status=${r.status} 条数=${(r.body.comments || []).length} total=${r.body.total} err=${r.body.error || '-'}`);
  const c0 = (r.body.comments || [])[0];
  if (c0) log(`[comments] 首条 ${c0.user} / ${String(c0.content).slice(0, 30)} / 赞${c0.digg} 作者=${c0.author}`);

  const raw = await fetch('https://api.juejin.cn/interact_api/v1/comment/list?aid=2608&spider=0', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://juejin.cn',
      referer: 'https://juejin.cn',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ item_id: withCmt.id, item_type: 4, cursor: '0', limit: 20 }),
  });
  const rawText = await raw.text();
  let rawJson = {};
  try { rawJson = JSON.parse(rawText); } catch (e) { /* 非 JSON */ }
  log(`[comments] 上游原始 http=${raw.status} err_no=${rawJson.err_no} err_msg=${rawJson.err_msg || '-'} count=${rawJson.count} data 长度=${(rawJson.data || []).length}`);
  log(`[comments] 原始正文片段=${rawText.slice(0, 180).replace(/\s+/g, ' ')}`);
}

/* ---------------- 5) /api/comment 无页面上下文时应报「未配置 Cookie」 ---------------- */
{
  const r = await apiComment({ pinId: '7687434016368115746', content: '测试' }, {});
  log(`[comment] 无 Cookie status=${r.status} msg=${r.body.error}`);
}

console.log('\n==== 汇总 ====');
console.log(out.join('\n'));

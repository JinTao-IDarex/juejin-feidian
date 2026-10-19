// 无头 Chrome 截图工具：抓魔鬼榜单「评分中」弹窗的执行态 / 结果态。
// 用法：node scripts/shot_scoring.mjs [outPrefix]
// 依赖：本机 Chrome + Node>=22（全局 WebSocket / fetch）。仅做前端联调（?mock=1，不烧 token）。
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;
const URL_BASE = 'http://localhost:7100/board.html?mock=1';
const prefix = process.argv[2] || 'output/shots/scoring';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + process.env.TEMP + '/jb-shot-profile',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* chrome 还没起好 */ }
    await sleep(250);
  }
  throw new Error('chrome devtools 没起来');
}

let seq = 0;
const pending = new Map();
let ws;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面内执行出错: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = `${prefix}-${name}.png`;
  await writeFile(file, Buffer.from(r.data, 'base64'));
  console.log('saved', file);
}

async function main() {
  const url = await wsUrl();
  ws = new WebSocket(url);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_BASE });
  await sleep(2500); // 首屏渲染 + 缓存榜单落定

  // 点「重新评分」→ 等确认条展开 → 点「开始重评」
  await evaluate(`document.querySelector('#btnFresh').click()`);
  await sleep(600);
  await evaluate(`document.querySelector('#cfGo').click()`);

  // 轮询到「分析期中段」（AI 逐条分赛道，已发出去一些牌）再拍
  let got = false;
  for (let i = 0; i < 120; i++) {
    const s = await evaluate(`(function(){
      var v=document.querySelector('#viewScoring');
      var done=(document.querySelector('#scDone')||{}).textContent||'';
      var m=/^(\\d+)\\/(\\d+)$/.exec(done);
      return JSON.stringify({hidden:!!(v&&v.hidden),done:done,
        cur:m?+m[1]:0,total:m?+m[2]:0,
        result:!document.querySelector('#scResult').hidden});
    })()`);
    const st = JSON.parse(s);
    if (!st.hidden && !st.result && st.total > 0 && st.cur >= Math.min(10, Math.floor(st.total / 3))) { got = true; break; }
    if (st.result) break; // mock 太快直接进了结果态也接受
    await sleep(300);
  }
  console.log('mid-scoring captured:', got);
  await sleep(400);
  await shot('running');

  // 等结果卡出来再拍一张
  for (let i = 0; i < 60; i++) {
    const done = await evaluate(`!document.querySelector('#scResult').hidden`);
    if (done) break;
    await sleep(300);
  }
  await sleep(600);
  await shot('result');

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });

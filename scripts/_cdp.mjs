#!/usr/bin/env node
/* 极简 CDP 客户端 —— 在本机做「真实等待」的浏览器核验。
 *
 * ⭐ 为什么不用 `chrome --headless --virtual-time-budget=N --screenshot`：
 *   virtual time 会让页面里的 setTimeout 几乎瞬时触发，而**服务端是真实时间**。
 *   实测：虚拟 46 秒只对应真实不到 1 秒 —— 抓取还没完就 dump 了，
 *   探针只看到 phase=scan/0，**完全错过**要验的过程态。
 *   所以这里用 CDP 协议驱动，真等真看。
 *
 * 依赖：Node 18+ 全局 WebSocket、fetch。零 npm 包。
 *
 * 用法：
 *   node scripts/_cdp.mjs <url> [--w 1440] [--h 1000] [--wait "<js>"] [--shot out.png]
 *                          [--timeout 60000] [--eval "<js>"] [--full]
 *
 *   --wait "<js>"  反复求值直到为真值（truthy）。每次 250ms 一次。
 *   --eval  "<js>"  最后再求值一次，把结果打到 stdout（JSON.stringify 的返回值）。
 *   --shot <path>  满足 --wait 后截图（PNG，绝对路径）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.JB_CHROME
  || 'C:/Users/apple/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe';

const argv = process.argv.slice(2);
const url = argv[0];
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const W = Number(arg('w', 1440)), H = Number(arg('h', 1000));
const PRE = arg('pre', '');
/* --waitfile / --evalfile / --evaltmplfile：从文件读表达式。
 * 原因：这些 JS 全是引号和 $，塞进命令行必被shell 吃掉两三次
 *（`node -e "setTimeout(()=>{},2500)"` 直接语法错）。 */
const readExpr = (v) => { try { return readFileSync(v, 'utf8'); } catch { return v; } };
const WAITX = arg('waitfile', '') ? readExpr(arg('waitfile', '')) : arg('wait', '');
const EVALX = arg('evalfile', '') ? readExpr(arg('evalfile', '')) : arg('eval', '');
const TMPLX = arg('evaltmplfile', '') ? readExpr(arg('evaltmplfile', '')) : arg('evaltmpl', '');
const SHOT = arg('shot', '');
const TIMEOUT = Number(arg('timeout', 60000));

if (!url) { console.error('用法: node scripts/_cdp.mjs <url> [--wait js] [--eval js] [--shot out.png]'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'jb-cdp-'));
const port = 9500 + Math.floor(Math.random() * 400);

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--use-gl=swiftshader', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--force-device-scale-factor=1',
  '--window-size=' + (W + 16) + ',' + (H + 95),
  '--user-data-dir=' + profile,
  '--remote-debugging-port=' + port,
  'about:blank',
], { stdio: 'ignore' });

let ws = null, nextId = 1;
const waiting = new Map();
const events = [];

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => waiting.set(id, { res, rej }));
}

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(120);
  }
  throw new Error('CDP 端点没起来（端口 ' + port + '）');
}

async function main() {
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) w.rej(new Error(m.method + ' ' + JSON.stringify(m.error)));
      else w.res(m.result);
    } else if (m.method) events.push(m);
  };

  /* 每个页面 target 挂一个 session */
  const { targetInfos } = await send('Target.getTargets');
  let target = targetInfos.find((t) => t.type === 'page');
  if (!target) {
    const c = await send('Target.createTarget', { url: 'about:blank' });
    target = { targetId: c.targetId };
  }
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);

  /* ⭐ 必须强制 no-preference —— **headless Chrome 默认是
   * `prefers-reduced-motion: reduce`**，而 board.js 的 `motion()` 就是
   * `!reduceMotion` → 返回 false → `slideTo()` / `openTrack()` 全部走
   *「直接落位、不播动画」那条分支。
   * 后果：不加这句，测切牌会看到「动画根本没跑」，很容易误判成
   * 「动画坏了」而去改本来正确的代码。（记忆里 agent-browser 那条
   * `set media light no-preference` 是同一个坑，两处都要设。）
   * ⚠️ setEmulatedMedia 必须在 navigate 之前，否则首帧就按 reduce 画了。 */
  await send('Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, sessionId);

  /* ⚠️ 导航前等一下：本地桩服务器（node 起进程）可能比 Chrome 启动还慢，
   * 不等就会 404 / ERR_CONNECTION_REFUSED —— 而 load 事件照样触发，
   * 看起来「页面打开了但什么也没有」，极易误判成前端 bug。
   * 用 --preurl <ms> 打开这个等待（默认 0）。 */
  const PREURL = Number(arg('preurl', 0));
  if (PREURL) await sleep(PREURL);

  await send('Page.navigate', { url }, sessionId);

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' +
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  }

  /* 等 load 事件（最多 15 秒） */
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (events.some((e) => e.method === 'Page.loadEventFired')) break;
    await sleep(100);
  }
  const loadedAt = Date.now() - t0;

  let waited = '';
  /* --pre：在开始 --wait 之前先求值一次并等它落地。
   * 用途：board.html 只认 load(true) 的按钮点击，URL 上的 ?fresh=1 会被忽略
   * （fetchBoard 只把 fresh=1 挂在 load(true) 上），所以要真的点一下重新评分。 */
  if (PRE) {
    try { await evaluate(PRE); } catch (e) { console.error('!! --pre 失败: ' + e.message); }
    await sleep(300);
  }
  if (WAITX) {
    const w0 = Date.now();
    let ok = false;
    while (Date.now() - w0 < TIMEOUT) {
      let v = false;
      try { v = await evaluate(WAITX); } catch { /* 页面还在导航 */ }
      if (v) { ok = true; break; }
      await sleep(250);
    }
    waited = String(Date.now() - w0);
    if (!ok) console.error('!! --wait 超时 ' + TIMEOUT + 'ms: ' + WAITX.slice(0, 120));
  }

  if (EVALX || TMPLX) {
    /* ⚠️ awaitPromise + 超长字符串不可靠，所以长文本分块取：
     *   --evaltmpl(file) 给一个含 %LEN% 的 JS 表达式（求值出**完整字符串**），
     *   工具自己把 %LEN% 替成 0 / 分片偏移再逐块拉，最后拼起来。 */
    if (TMPLX) {
      let whole = '';
      try { whole = String(await evaluate(TMPLX.replace(/%LEN%/g, '0'))); }
      catch (e) { console.error('!! evaltmpl 失败: ' + e.message); }
      for (let i = 0; i < whole.length; i += 4000) process.stdout.write(whole.slice(i, i + 4000));
      if (whole.length) process.stdout.write('\n');
    } else {
      let out = null;
      try { out = await evaluate(EVALX); }
      catch (e) { out = { __error: String(e.message) }; }
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    }
  }

  if (SHOT) {
    /* --clip x,y,w,h [--clipscale N]：只截一块、并按 scale 放大（默认 2 倍）。
     * 用途：卡面这类 300x420 的部件，整页截图按 1080 宽显示后细节全糊 ——
     * 「白描边是不是把字吃糊了」这种判断靠整页图看不出，只能放大到原始像素看。 */
    const params = { format: 'png', captureBeyondViewport: has('full') };
    const clip = arg('clip', '');
    if (clip) {
      const [cx, cy, cw, ch] = clip.split(',').map(Number);
      params.clip = { x: cx, y: cy, width: cw, height: ch, scale: Number(arg('clipscale', 2)) };
      delete params.captureBeyondViewport;
    }
    const r = await send('Page.captureScreenshot', params, sessionId);
    writeFileSync(SHOT, Buffer.from(r.data, 'base64'));
    console.error('shot -> ' + SHOT + (clip ? ' clip=' + clip : ''));
  }

  if (has('errors')) {
    /* 页面里的 JS 异常在 headless 截图里完全不可见（画面正常、功能静默失效），
     * 所以把 Runtime.exceptionThrown / console.error 一并打出来 —— 这是最容易漏的一类 bug。 */
    for (const e of events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails || {};
        console.error('!! EXCEPTION: ' + (d.exception && d.exception.description || d.text));
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        console.error('!! console.error: ' + e.params.args.map((a) => a.value || a.description || '').join(' '));
      }
    }
  }

  console.error('load=' + loadedAt + 'ms wait=' + waited + 'ms');
  ws.close();
}

main().then(() => {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 临时目录留着也无所谓 */ }
  process.exit(0);
}).catch((e) => {
  console.error('CDP 失败: ' + e.message);
  try { chrome.kill(); } catch { /* 已退出 */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 同上 */ }
  process.exit(1);
});
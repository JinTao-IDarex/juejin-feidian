# -*- coding: utf-8 -*-
"""Generate the gacha-style single-file page: juejin_pins_gacha_<day>.html"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PREVIEWS = os.path.join(ROOT, "previews")

day = sys.argv[1]
pins = json.load(open(os.path.join(DATA, "pins_raw_%s.json" % day), encoding="utf-8"))
cmts = json.load(open(os.path.join(DATA, "comments_%s.json" % day), encoding="utf-8"))
date = cmts["date"]
comments = cmts["comments"]
assert len(pins) == len(comments), "count mismatch %d vs %d" % (len(pins), len(comments))

cards = []
for p, c in zip(pins, comments):
    cards.append({
        "id": p["id"],
        "content": p["content"],
        "user": p["user_name"] or "掘友",
        "company": p["company"] or "",
        "job": p["job_title"] or "",
        "avatar": p["avatar"],
        "ctime": int(p["ctime"] or 0),
        "digg": p["digg_count"] or 0,
        "cmt": p["comment_count"] or 0,
        "topics": p["topics"],
        "pics": p["pics"],
        "url": p["url"],
        "roast": c,
    })

payload = json.dumps({"date": date, "cards": cards}, ensure_ascii=False).replace("</", "<\\/")

HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>掘金沸点 · 毒舌抽卡 __DAY__</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f4f6fa; --card:#fff; --ink:#1f2329; --ink2:#5b6472; --ink3:#98a1b0;
  --line:#e8ecf2; --jj:#1e80ff; --hot:#ff7a45; --hot2:#ffb37a; --like:#ff4d6a;
  --shadow:0 18px 44px -18px rgba(31,35,41,.22),0 2px 8px rgba(31,35,41,.05);
}
body{
  font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  background:var(--bg); color:var(--ink); min-height:100vh; padding-bottom:132px;
  background-image:radial-gradient(circle at 12% 8%,#e6efff 0,transparent 42%),
                   radial-gradient(circle at 88% 4%,#ffeee4 0,transparent 38%);
  background-attachment:fixed;
}
.wrap{max-width:1140px;margin:0 auto;padding:20px 18px 0}

/* header */
header{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;letter-spacing:.3px}
.brand .dot{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--jj),#5aa9ff);
  display:grid;place-items:center;color:#fff;font-size:14px;box-shadow:0 6px 14px -4px var(--jj)}
.brand small{font-weight:500;color:var(--ink3);font-size:12px;letter-spacing:0}
.grow{flex:1}
.search{position:relative}
.search input{width:210px;padding:9px 12px 9px 32px;border:1px solid var(--line);border-radius:10px;
  background:#fff;font-size:13px;outline:none;transition:.18s}
.search input:focus{border-color:var(--jj);box-shadow:0 0 0 3px rgba(30,128,255,.12)}
.search svg{position:absolute;left:10px;top:9px;opacity:.4}
.tbtn{border:1px solid var(--line);background:#fff;border-radius:10px;padding:9px 13px;font-size:13px;
  color:var(--ink2);cursor:pointer;transition:.18s;font-weight:600}
.tbtn:hover{border-color:var(--jj);color:var(--jj)}
.tbtn.on{background:var(--jj);border-color:var(--jj);color:#fff}

/* progress */
.bar{height:5px;border-radius:99px;background:#e6eaf1;overflow:hidden;margin-bottom:16px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--jj),#7ab6ff);
  border-radius:99px;transition:width .35s cubic-bezier(.4,0,.2,1)}
.meta{display:flex;justify-content:space-between;font-size:12px;color:var(--ink3);margin:-10px 0 14px}

/* stage */
.stage{display:grid;grid-template-columns:1.15fr .85fr;gap:20px;align-items:start}
@media(max-width:900px){.stage{grid-template-columns:1fr}}
.slot{position:relative}
.slot::before,.slot::after{content:"";position:absolute;inset:0;border-radius:20px;background:#fff;
  border:1px solid var(--line);z-index:0}
.slot::before{transform:rotate(-1.4deg) translateY(7px);opacity:.55}
.slot::after{transform:rotate(1.8deg) translateY(11px);opacity:.3}
.card{position:relative;z-index:1;background:var(--card);border:1px solid var(--line);border-radius:20px;
  box-shadow:var(--shadow);padding:22px 24px;min-height:340px;animation:dealIn .46s cubic-bezier(.2,.9,.3,1.1) both}
@keyframes dealIn{
  0%{opacity:0;transform:translateY(46px) scale(.94) rotateX(-10deg)}
  60%{opacity:1}
  100%{opacity:1;transform:none}
}
.card.out{animation:dealOut .26s ease-in forwards}
@keyframes dealOut{to{opacity:0;transform:translateY(-26px) scale(.95)}}

/* author row */
.au{display:flex;align-items:center;gap:11px;margin-bottom:14px}
.au img{width:42px;height:42px;border-radius:50%;object-fit:cover;background:#eef1f6;border:1px solid var(--line)}
.au .nm{font-weight:700;font-size:15px}
.au .sub{font-size:12px;color:var(--ink3);margin-top:1px}
.au .tm{margin-left:auto;font-size:12px;color:var(--ink3);white-space:nowrap}
.body{font-size:16px;line-height:1.85;white-space:pre-wrap;word-break:break-word;color:#252a31}
.body.long{max-height:340px;overflow:auto;padding-right:6px}
.body.long::-webkit-scrollbar{width:5px}
.body.long::-webkit-scrollbar-thumb{background:#d7dde7;border-radius:9px}
.tags{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}
.tag{font-size:12px;color:var(--jj);background:rgba(30,128,255,.08);border-radius:7px;padding:3px 9px}
.pics{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.pics img{width:104px;height:104px;object-fit:cover;border-radius:12px;border:1px solid var(--line);cursor:zoom-in}
.stats{display:flex;gap:18px;margin-top:16px;padding-top:14px;border-top:1px dashed var(--line);
  font-size:13px;color:var(--ink3)}
.stats b{color:var(--ink2);font-weight:700}
.src{margin-left:auto;font-size:12px;color:var(--jj);text-decoration:none;font-weight:600}

/* ai card */
.ai{border-radius:20px;padding:22px 24px;color:#fff;position:relative;overflow:hidden;min-height:340px;
  background:linear-gradient(155deg,#ff8a4c 0%,#ff6a2c 55%,#f2541b 100%);
  box-shadow:0 18px 40px -16px rgba(242,84,27,.55);animation:dealIn .46s .07s cubic-bezier(.2,.9,.3,1.1) both}
.ai::after{content:"";position:absolute;right:-70px;top:-70px;width:210px;height:210px;border-radius:50%;
  background:rgba(255,255,255,.11)}
.ai::before{content:"AI";position:absolute;right:22px;bottom:14px;font-size:74px;font-weight:900;
  color:rgba(255,255,255,.13);letter-spacing:-2px}
.ai .hd{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;letter-spacing:1.2px;
  opacity:.95;margin-bottom:16px}
.ai .hd span{width:22px;height:22px;border-radius:7px;background:rgba(255,255,255,.22);display:grid;
  place-items:center;font-size:12px}
.ai .txt{font-size:19px;line-height:1.85;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.08);
  position:relative;z-index:1}
.ai .acts{display:flex;gap:9px;margin-top:22px;position:relative;z-index:1;flex-wrap:wrap}
.ai .acts button{border:none;background:rgba(255,255,255,.2);color:#fff;padding:9px 15px;border-radius:11px;
  font-size:13px;font-weight:700;cursor:pointer;backdrop-filter:blur(4px);transition:.18s}
.ai .acts button:hover{background:#fff;color:#f2541b}
.ai .acts button.solid{background:#fff;color:#f2541b}
.ai .acts button.solid:hover{background:#fff4ee}
.mood{margin-top:18px;font-size:12px;opacity:.8;position:relative;z-index:1}

/* dock */
.dock{position:fixed;left:0;right:0;bottom:0;padding:14px 18px calc(16px + env(safe-area-inset-bottom));
  display:flex;justify-content:center;gap:11px;flex-wrap:wrap;z-index:40;
  background:linear-gradient(to top,rgba(244,246,250,.98) 55%,rgba(244,246,250,0))}
.btn{border:1px solid var(--line);background:#fff;border-radius:14px;padding:13px 20px;font-size:14.5px;
  font-weight:700;color:var(--ink);cursor:pointer;box-shadow:0 8px 20px -10px rgba(31,35,41,.3);
  transition:.16s;display:flex;align-items:center;gap:7px}
.btn:hover{transform:translateY(-2px)}
.btn:active{transform:translateY(0) scale(.97)}
.btn.primary{background:var(--jj);border-color:var(--jj);color:#fff;box-shadow:0 10px 24px -10px var(--jj)}
.btn.like{border-color:#ffd3dc;color:var(--like)}
.btn.like.on{background:var(--like);border-color:var(--like);color:#fff;
  box-shadow:0 10px 24px -10px var(--like)}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
.pop{animation:pop .42s ease}
@keyframes pop{0%{transform:scale(1)}35%{transform:scale(1.22)}70%{transform:scale(.94)}100%{transform:scale(1)}}

/* drawer */
.mask{position:fixed;inset:0;background:rgba(20,24,32,.42);opacity:0;pointer-events:none;transition:.22s;z-index:50;
  backdrop-filter:blur(2px)}
.mask.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:50%;bottom:0;transform:translate(-50%,108%);width:min(720px,100%);z-index:60;
  background:#fff;border-radius:20px 20px 0 0;padding:20px 22px calc(20px + env(safe-area-inset-bottom));
  box-shadow:0 -18px 50px -18px rgba(0,0,0,.3);transition:transform .28s cubic-bezier(.2,.9,.3,1)}
.sheet.on{transform:translate(-50%,0)}
.sheet h3{font-size:16px;margin-bottom:4px}
.sheet p.hint{font-size:12.5px;color:var(--ink3);margin-bottom:12px}
.sheet textarea{width:100%;height:118px;border:1px solid var(--line);border-radius:12px;padding:12px;
  font:15px/1.7 inherit;resize:vertical;outline:none;transition:.18s}
.sheet textarea:focus{border-color:var(--jj);box-shadow:0 0 0 3px rgba(30,128,255,.12)}
.sheet .row{display:flex;gap:9px;margin-top:12px;flex-wrap:wrap}
.sheet .row .btn{padding:11px 16px;font-size:13.5px;box-shadow:none}
.favs{max-height:60vh;overflow:auto}
.favs .it{padding:12px 0;border-bottom:1px solid var(--line);cursor:pointer}
.favs .it:last-child{border-bottom:none}
.favs .it b{display:block;font-size:13.5px;margin-bottom:3px}
.favs .it span{font-size:12.5px;color:var(--ink3);display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden}
.empty{text-align:center;color:var(--ink3);padding:36px 0;font-size:14px}
.toast{position:fixed;left:50%;bottom:118px;transform:translate(-50%,16px);background:#1f2329;color:#fff;
  padding:10px 18px;border-radius:12px;font-size:13.5px;opacity:0;pointer-events:none;transition:.24s;z-index:80}
.toast.on{opacity:1;transform:translate(-50%,0)}
.kbd{font-size:11.5px;color:var(--ink3);text-align:center;margin:16px 0 0}
.kbd i{font-style:normal;background:#fff;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;
  padding:1px 6px;margin:0 2px;font-family:inherit}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><span class="dot">沸</span>沸点毒舌抽卡<small>__DATE__ · __N__ 张</small></div>
    <div class="grow"></div>
    <div class="search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
        <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="q" placeholder="搜内容 / 作者 / 话题">
    </div>
    <button class="tbtn" id="btnShuffle">洗牌</button>
    <button class="tbtn" id="btnFav">收藏夹 <b id="favN">0</b></button>
  </header>
  <div class="bar"><i id="prog" style="width:0%"></i></div>
  <div class="meta"><span id="mLeft">第 1 / __N__ 张</span><span id="mRight">已看 0 · 喜欢 0</span></div>

  <div class="stage" id="stage">
    <div class="slot"><article class="card" id="pin"></article></div>
    <aside class="ai" id="ai"></aside>
  </div>
  <p class="kbd"><i>←</i><i>→</i> 翻牌 <i>Space</i> 下一张 <i>L</i> 喜欢 <i>C</i> 评论</p>
</div>

<div class="dock">
  <button class="btn" id="bPrev">← 上一张</button>
  <button class="btn like" id="bLike">♥ 喜欢</button>
  <button class="btn" id="bCmt">💬 评论</button>
  <button class="btn" id="bOpen">↗ 原文</button>
  <button class="btn primary" id="bNext">抽下一张 →</button>
</div>

<div class="mask" id="mask"></div>
<div class="sheet" id="sheetCmt">
  <h3>写条评论</h3>
  <p class="hint">掘金没开放网页端匿名发评，这里生成好内容，复制后去沸点页粘贴即可。</p>
  <textarea id="ta" placeholder="说点什么…"></textarea>
  <div class="row">
    <button class="btn primary" id="bUseAI">✨ 贴入 AI 评价</button>
    <button class="btn" id="bCopy">复制</button>
    <button class="btn" id="bGo">复制并打开沸点</button>
    <button class="btn" id="bSave">标记已评论</button>
  </div>
</div>
<div class="sheet" id="sheetFav">
  <h3>我喜欢的 <span id="favN2" style="color:var(--ink3);font-weight:500"></span></h3>
  <p class="hint">点任意一条跳回那张卡。</p>
  <div class="favs" id="favList"></div>
</div>
<div class="toast" id="toast"></div>

<script>
const DATA = __PAYLOAD__;
const N = DATA.cards.length;
const KEY = 'jj-gacha-' + DATA.date;
const S = Object.assign({liked:[],cmted:[],viewed:[]}, JSON.parse(localStorage.getItem(KEY) || '{}'));
const save = () => localStorage.setItem(KEY, JSON.stringify(S));
let order = DATA.cards.map((_, i) => i).sort(() => Math.random() - .5);
let pos = 0, cur = null;

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pad = n => n < 10 ? '0' + n : '' + n;
const fmt = t => { const d = new Date(t * 1000); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
function toast(m){ const t = $('#toast'); t.textContent = m; t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 1900); }
function copy(txt){
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(txt);
  const a = document.createElement('textarea'); a.value = txt; a.style.position = 'fixed'; a.style.opacity = 0;
  document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); return Promise.resolve();
}

function render(anim){
  const idx = order[pos], c = DATA.cards[idx];
  cur = c; cur._idx = idx;
  const long = c.content.length > 420;
  $('#pin').innerHTML = `
    <div class="au">
      ${c.avatar ? `<img src="${esc(c.avatar)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div><div class="nm">${esc(c.user)}</div>
        <div class="sub">${esc([c.company, c.job].filter(Boolean).join(' · ') || '掘友')}</div></div>
      <div class="tm">${fmt(c.ctime)}</div>
    </div>
    <div class="body${long ? ' long' : ''}">${esc(c.content)}</div>
    ${c.topics.length ? `<div class="tags">${c.topics.map(t => `<span class="tag"># ${esc(t)}</span>`).join('')}</div>` : ''}
    ${c.pics.length ? `<div class="pics">${c.pics.map(p => `<img src="${esc(p)}" referrerpolicy="no-referrer" onclick="window.open(this.src)">`).join('')}</div>` : ''}
    <div class="stats"><span>👍 <b>${c.digg}</b> 赞</span><span>💬 <b>${c.cmt}</b> 评论</span>
      <a class="src" href="${esc(c.url)}" target="_blank" rel="noreferrer">沸点原文 ↗</a></div>`;
  $('#ai').innerHTML = `
    <div class="hd"><span>AI</span>犀利点评</div>
    <div class="txt" id="roastTxt">${esc(c.roast)}</div>
    <div class="acts">
      <button class="solid" id="aUse">✨ 用这句评论</button>
      <button id="aCopy">复制点评</button>
    </div>
    <div class="mood">话是毒了点，说的是现象，不是你。</div>`;
  $('#aUse').onclick = () => { openCmt(true); };
  $('#aCopy').onclick = () => copy(c.roast).then(() => toast('点评已复制'));

  if (anim){ const el = $('#pin'); el.classList.remove('out');
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    const ai = $('#ai'); ai.style.animation = 'none'; void ai.offsetWidth; ai.style.animation = ''; }

  if (!S.viewed.includes(idx)){ S.viewed.push(idx); save(); }
  $('#bLike').classList.toggle('on', S.liked.includes(idx));
  $('#bLike').textContent = S.liked.includes(idx) ? '♥ 已喜欢' : '♥ 喜欢';
  $('#bSave').textContent = S.cmted.includes(idx) ? '✓ 已评论' : '标记已评论';
  $('#prog').style.width = ((pos + 1) / order.length * 100) + '%';
  $('#mLeft').textContent = `第 ${pos + 1} / ${order.length} 张 · ${fmt(c.ctime)}`;
  $('#mRight').textContent = `已看 ${S.viewed.length} · 喜欢 ${S.liked.length} · 已评 ${S.cmted.length}`;
  $('#favN').textContent = S.liked.length;
}
function go(step, anim){
  const n = pos + step;
  if (n < 0){ toast('已经是第一张了'); return; }
  if (n >= order.length){ toast('这波抽完了，点「洗牌」再来一轮'); return; }
  pos = n; render(anim !== false);
}
function next(){ pos + 1 >= order.length ? pos = 0 : pos++; render(true); }
function toggleLike(){
  const i = cur._idx, k = S.liked.indexOf(i);
  k >= 0 ? S.liked.splice(k, 1) : S.liked.push(i);
  save(); render(false);
  const b = $('#bLike'); b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 420);
  toast(k >= 0 ? '取消喜欢' : '已加入收藏夹');
}
function openSheet(el){ $('#mask').classList.add('on'); el.classList.add('on'); }
function closeSheet(){ $('#mask').classList.remove('on');
  $('#sheetCmt').classList.remove('on'); $('#sheetFav').classList.remove('on'); }
function openCmt(useAI){
  if (useAI) $('#ta').value = cur.roast;
  openSheet($('#sheetCmt')); if (useAI) setTimeout(() => $('#ta').focus(), 260);
}
function favList(){
  const box = $('#favList');
  if (!S.liked.length){ box.innerHTML = '<div class="empty">还没喜欢过任何一张。看到对味的就点个 ♥ 吧。</div>'; return; }
  box.innerHTML = S.liked.map(i => {
    const c = DATA.cards[i];
    return `<div class="it" data-i="${i}"><b>${esc(c.user)} · ${esc(c.roast.slice(0, 0))}${esc(c.content.slice(0, 40))}</b>
      <span>AI：${esc(c.roast)}</span></div>`;
  }).join('');
  box.querySelectorAll('.it').forEach(el => el.onclick = () => {
    const i = +el.dataset.i; const p = order.indexOf(i);
    if (p >= 0) pos = p; else { order.unshift(i); pos = 0; }
    closeSheet(); render(true);
  });
  $('#favN2').textContent = S.liked.length + ' 张';
}

$('#bNext').onclick = next;
$('#bPrev').onclick = () => go(-1);
$('#bLike').onclick = toggleLike;
$('#bCmt').onclick = () => openCmt(false);
$('#bOpen').onclick = () => window.open(cur.url, '_blank');
$('#mask').onclick = closeSheet;
$('#bUseAI').onclick = () => { $('#ta').value = cur.roast; toast('AI 评价已贴入'); };
$('#bCopy').onclick = () => { const v = $('#ta').value.trim();
  v ? copy(v).then(() => toast('评论已复制')) : toast('先写点什么吧'); };
$('#bGo').onclick = () => { const v = $('#ta').value.trim();
  const done = () => { S.cmted.includes(cur._idx) || S.cmted.push(cur._idx); save();
    $('#bSave').textContent = '✓ 已评论'; window.open(cur.url, '_blank'); };
  v ? copy(v).then(() => { toast('已复制，去沸点粘贴'); done(); }) : done(); };
$('#bSave').onclick = () => { if (!S.cmted.includes(cur._idx)) S.cmted.push(cur._idx); save();
  $('#bSave').textContent = '✓ 已评论'; toast('已标记为已评论'); closeSheet(); };
$('#btnFav').onclick = () => { favList(); openSheet($('#sheetFav')); };
$('#btnShuffle').onclick = () => { order.sort(() => Math.random() - .5); pos = 0; render(true); toast('重新洗牌'); };
$('#q').oninput = e => {
  const kw = e.target.value.trim().toLowerCase();
  if (!kw){ order = DATA.cards.map((_, i) => i); pos = 0; render(true); return; }
  const hit = DATA.cards.map((c, i) => [c, i]).filter(([c]) =>
    (c.content + c.user + c.company + c.job + c.topics.join('') + c.roast).toLowerCase().includes(kw));
  order = hit.map(([, i]) => i); pos = 0;
  order.length ? render(true) : ($('#pin').innerHTML = '<div class="empty">没搜到，换个词试试。</div>',
    $('#ai').innerHTML = '<div class="hd"><span>AI</span>没辙</div><div class="txt">这关键词我一张都没捞着，要不换个说法。</div>');
};
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const ae = document.activeElement;
  if (ae && ae.tagName === 'BUTTON') ae.blur();
  if (e.key === 'ArrowRight' || e.key === ' '){ e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft') go(-1);
  else if (e.key.toLowerCase() === 'l') toggleLike();
  else if (e.key.toLowerCase() === 'c') openCmt(false);
  else if (e.key === 'Escape') closeSheet();
});
render(true);
</script>
</body></html>
"""

HTML = (HTML.replace("__DAY__", day).replace("__DATE__", date)
            .replace("__N__", str(len(cards))).replace("__PAYLOAD__", payload))

out = os.path.join(PREVIEWS, "juejin_pins_gacha_%s.html" % day)
open(out, "w", encoding="utf-8").write(HTML)
print("saved " + out)

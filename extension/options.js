/* options.js */
const $ = (s) => document.querySelector(s);
const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (v) => {
  if (chrome.runtime.lastError) r({ ok: false, error: chrome.runtime.lastError.message });
  else r(v || {});
}));

const ALL_PERSONAS = ['毒舌', '冷幽默', '工科直男', '温柔一刀', '命题作文'];
let cfg = null;

function renderPersonas() {
  $('#personas').innerHTML = ALL_PERSONAS.map((p) =>
    '<span class="chip' + (cfg.personas.includes(p) ? ' on' : '') + '" data-p="' + p + '">' + p + '</span>').join('');
  $('#personas').querySelectorAll('.chip').forEach((el) => {
    el.onclick = () => {
      const p = el.dataset.p;
      const i = cfg.personas.indexOf(p);
      if (i >= 0) cfg.personas.splice(i, 1);
      else if (cfg.personas.length >= 3) { flash('最多选 3 个'); return; }
      else cfg.personas.push(p);
      if (!cfg.personas.length) cfg.personas.push('毒舌');
      renderPersonas();
    };
  });
}

async function load() {
  const st = await send({ type: 'getState' });
  cfg = Object.assign({}, st.defaultCfg, st.cfg);
  $('#aiProvider').value = cfg.aiProvider;
  $('#baseUrl').value = cfg.baseUrl;
  $('#model').value = cfg.model;
  $('#apiKey').value = cfg.apiKey;
  $('#autoFetch').checked = !!cfg.autoFetch;
  $('#everyMinutes').value = cfg.everyMinutes;
  $('#notify').checked = !!cfg.notify;
  $('#extra').value = cfg.extraPrompt || '';
  renderPersonas();
}

function flash(msg) {
  const s = $('#saved'); s.textContent = msg || '已保存'; s.classList.add('on');
  setTimeout(() => s.classList.remove('on'), 1600);
}
function showOut(txt, isErr) {
  const o = $('#out'); o.style.display = 'block'; o.textContent = txt;
  o.classList.toggle('err', !!isErr);
}

function collect() {
  return {
    aiProvider: $('#aiProvider').value,
    baseUrl: $('#baseUrl').value.trim() || 'https://api.openai.com/v1',
    model: $('#model').value.trim() || 'gpt-4o-mini',
    apiKey: $('#apiKey').value.trim(),
    personas: cfg.personas.slice(0, 3),
    autoFetch: $('#autoFetch').checked,
    everyMinutes: Math.max(5, parseInt($('#everyMinutes').value, 10) || 15),
    notify: $('#notify').checked,
    extraPrompt: $('#extra').value.trim(),
  };
}

$('#btnSave').onclick = async () => {
  cfg = Object.assign(cfg, collect());
  await send({ type: 'saveCfg', cfg });
  renderPersonas();
  flash('已保存');
};

$('#btnTest').onclick = async () => {
  const c = Object.assign(cfg, collect());
  showOut('测试中…');
  if (c.aiProvider === 'off') { showOut('当前是「关闭」状态，先选 OpenAI 兼容接口。', true); return; }
  if (!c.apiKey && !/localhost|127\.0\.0\.1/.test(c.baseUrl)) { showOut('缺 API Key。', true); return; }
  try {
    const res = await fetch(c.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (c.apiKey || 'x') },
      body: JSON.stringify({
        model: c.model,
        max_tokens: 60,
        messages: [{ role: 'user', content: '用一句话点评「程序员写周报」这件事，20 字以内。' }],
      }),
    });
    const txt = await res.text();
    if (!res.ok) { showOut('HTTP ' + res.status + '\n' + txt.slice(0, 400), true); return; }
    const j = JSON.parse(txt);
    const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    showOut('✓ 通了\n模型：' + (j.model || c.model) + '\n返回：' + (out || '(空)'));
  } catch (e) {
    showOut('× ' + String(e.message || e) +
      '\n\n常见原因：Base URL 不对、没联网、或该接口不允许扩展直连（需服务端开 CORS）。', true);
  }
};

$('#btnClearRoasts').onclick = async () => {
  await chrome.storage.local.remove('roasts');
  flash('点评缓存已清空');
};
$('#btnClearAll').onclick = async () => {
  if (!confirm('会清空本地所有沸点、点评与收藏，确定？')) return;
  await chrome.storage.local.clear();
  flash('本地数据已清空');
};

load();

/* _probe_providers.mjs — providers.js 的离线自检（开发用，不进扩展包）
 *
 * 为什么单独一个：协议适配的正确性全靠「请求形状对不对」，
 * 而这恰好是不打网络就能 100% 核验的 —— 把每种 api.type 的 url / 头 / body
 * 拼出来逐字段断言，比联调时对着厂商报错猜快得多。
 *
 * 用法： node scripts/_probe_providers.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import P from '../site/providers.js';   // CJS 默认导入：验证双端确实能共用同一份

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = [];
let pass = 0, fail = 0;

function ok(cond, label, extra) {
  if (cond) { pass++; lines.push('  ok   ' + label); }
  else { fail++; lines.push('  FAIL ' + label + (extra ? '  → ' + extra : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected));
}
function has(obj, key, label) {
  ok(obj && Object.prototype.hasOwnProperty.call(obj, key), label, '缺字段 ' + key);
}
function section(t) { lines.push(''); lines.push('== ' + t + ' =='); }

/* ---------------- 1) 模块本体 ---------------- */
section('模块导出');
eq(P.SCHEMA, 1, 'SCHEMA = 1');
ok(P.REV >= 1, 'REV >= 1');
ok(Array.isArray(P.PROVIDERS) && P.PROVIDERS.length >= 10, '内置厂商表非空（' + P.PROVIDERS.length + ' 家）');
eq(P.API_TYPES.length, 3, '三种 api.type');
ok(P.API_TYPES.every((a) => P.API_IDS.includes(a.id)), 'API_TYPES 与 API_IDS 一致');

/* 每条 provider 的必填字段与 id 唯一性 */
{
  let bad = [];
  const seen = new Set();
  for (const p of P.PROVIDERS) {
    if (!p.id || !p.name || !P.API_IDS.includes(p.api)) bad.push(p.id || '(无名)');
    if (seen.has(p.id)) bad.push('重复:' + p.id);
    seen.add(p.id);
    /* 除 custom 外都要有 baseUrl —— 空地址的只有「自定义」 */
    if (p.id !== 'custom' && !/^https?:\/\//.test(p.baseUrl || '')) bad.push('地址非法:' + p.id);
  }
  eq(bad.join(','), '', '所有厂商条目字段合法且 id 唯一');
}

/* ---------------- 2) normalizeBase ---------------- */
section('normalizeBase');
eq(P.normalizeBase('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1', '去尾斜杠');
eq(P.normalizeBase(' https://api.openai.com/v1/chat/completions '), 'https://api.openai.com/v1', '剥离误贴的完整 endpoint');
eq(P.normalizeBase('https://api.openai.com'), 'https://api.openai.com/v1', 'OpenAI 纯 host 补 /v1');
eq(P.normalizeBase('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4', '智谱版本段不被改写');
eq(P.normalizeBase(''), '', '空值原样返回');

/* ---------------- 3) resolve：老配置向后兼容 ---------------- */
section('resolve（向后兼容）');
{
  /* 老的三要素，没有 providerId / api —— 必须仍然落到 chat */
  const r = P.resolve({ baseUrl: 'https://api.moonshot.cn/v1/', token: 'sk-x', model: 'kimi-k2' });
  eq(r.api, 'chat', '老配置（无 api 字段）默认 chat');
  eq(r.baseUrl, 'https://api.moonshot.cn/v1', '老配置地址被规范化');
  eq(r.known, false, '没有 providerId 时不冒充内置厂商');
  eq(r.providerName, '自定义', '无名厂商显示「自定义」');
  ok(r.needsKey, '未知厂商默认需要 Key');
}
{
  /* 只给了 claude 模型名、没给 api / provider → 弱暗示成 anthropic */
  const r = P.resolve({ baseUrl: 'https://api.anthropic.com/v1', token: 'k', model: 'claude-sonnet-4-20250514' });
  eq(r.api, 'anthropic', 'claude 模型名被暗示为 anthropic 协议');
}
{
  /* provider 声明 chat + claude 模型 → provider 优先（弱暗示不生效） */
  const r = P.resolve({ providerId: 'siliconflow', token: 'k', model: 'claude-3-5-sonnet' });
  eq(r.api, 'chat', '厂商声明优先于模型的弱暗示');
}

/* ---------------- 4) resolve：新配置 + 硬约束 ---------------- */
section('resolve（provider 表与模型规则）');
{
  const r = P.resolve({ providerId: 'openai', token: 'k', model: 'gpt-5-codex' });
  eq(r.baseUrl, 'https://api.openai.com/v1', '选厂商自动带出 baseUrl');
  eq(r.api, 'responses', 'codex 硬约束成 responses（压过厂商的 chat 声明）');
  ok(r.rule.dropTemperature, 'gpt-5 系规则：dropTemperature');
  eq(r.rule.tokenParam, 'max_completion_tokens', 'gpt-5 系规则：tokenParam');
}
{
  const r = P.resolve({ providerId: 'openai', token: 'k', model: 'o3-mini' });
  ok(r.rule.dropTemperature, 'o 系列 dropTemperature');
  eq(r.rule.tokenParam, 'max_completion_tokens', 'o 系列 tokenParam');
}
{
  const r = P.resolve({ providerId: 'deepseek', token: 'k', model: 'deepseek-reasoner' });
  ok(r.rule.dropTemperature, 'deepseek-reasoner dropTemperature');
  eq(r.rule.tokenParam, '', 'deepseek 不改 token 字段名');
}
{
  const r = P.resolve({ providerId: 'anthropic', token: 'k', model: 'claude-opus-4' });
  eq(r.api, 'anthropic', 'anthropic 厂商走 Messages');
  eq(r.needsKey, true, 'anthropic 需要 Key');
  ok(!!r.keyUrl, '带上了申请 Key 的地址');
}
{
  const r = P.resolve({ providerId: 'ollama', model: 'qwen2.5:7b' });
  eq(r.needsKey, false, 'Ollama 不强制 Key');
}
{
  /* 用户手选协议，且与硬约束冲突 → 尊重用户 + 给出警告 */
  const r = P.resolve({ providerId: 'openai', token: 'k', model: 'gpt-5-codex', api: 'chat' });
  eq(r.api, 'chat', '用户手选协议优先');
  ok(r.warnings.length === 1, '与硬约束冲突时给出警告', JSON.stringify(r.warnings));
}

/* ---------------- 5) buildRequest：三种形状 ---------------- */
section('buildRequest · chat');
{
  const r = P.resolve({ providerId: 'deepseek', token: 'sk-t', model: 'deepseek-chat' });
  const q = P.buildRequest(r, { system: 'SYS', user: 'USER', maxTokens: 120, temperature: 0.9 });
  eq(q.url, 'https://api.deepseek.com/v1/chat/completions', 'chat url');
  eq(q.headers.authorization, 'Bearer sk-t', 'chat 用 Bearer');
  eq(q.body.messages.length, 2, 'chat 有 system + user');
  eq(q.body.messages[0].role, 'system', 'chat 第一条是 system');
  eq(q.body.max_tokens, 120, 'chat 用 max_tokens');
  eq(q.body.temperature, 0.9, 'chat 带 temperature');
  has(q.body, 'model', 'chat body 有 model');
}
{
  /* 推理模型：temperature 必须整个字段不出现，token 字段改名，
   * 且输出上限要被抬到下限（否则思考吃光配额 → 空内容） */
  const r = P.resolve({ providerId: 'openai', token: 'k', model: 'o3-mini' });
  const q = P.buildRequest(r, { system: 'S', user: 'U', maxTokens: 99, temperature: 0.9 });
  ok(!('temperature' in q.body), 'o 系列不传 temperature');
  eq(q.body.max_completion_tokens, 1024, 'o 系列用 max_completion_tokens 且抬到下限 1024');
  ok(!('max_tokens' in q.body), 'o 系列不再出现 max_tokens');

  const q2 = P.buildRequest(r, { system: 'S', user: 'U', maxTokens: 8000, temperature: 0.9 });
  eq(q2.body.max_completion_tokens, 8000, '够大的上限不被下限压回去');

  /* 非推理模型不受影响 */
  const rn = P.resolve({ providerId: 'deepseek', token: 'k', model: 'deepseek-chat' });
  const qn = P.buildRequest(rn, { system: 'S', user: 'U', maxTokens: 120, temperature: 0.9 });
  eq(qn.body.max_tokens, 120, '普通模型上限原样保留');
}
{
  /* 逃生舱：extra 合并进 body */
  const r = P.resolve({ providerId: 'deepseek', token: 'k', model: 'deepseek-chat', extra: { top_p: 0.5 } });
  const q = P.buildRequest(r, { system: 'S', user: 'U', temperature: 0.9 });
  eq(q.body.top_p, 0.5, 'extra 参数被合并进 body');
}

section('buildRequest · responses');
{
  const r = P.resolve({ providerId: 'openai', token: 'sk-r', model: 'gpt-5-codex' });
  const q = P.buildRequest(r, { system: 'SYS', user: 'USER', maxTokens: 500, temperature: 0.9 });
  eq(q.url, 'https://api.openai.com/v1/responses', 'responses url');
  eq(q.headers.authorization, 'Bearer sk-r', 'responses 用 Bearer');
  eq(q.body.instructions, 'SYS', 'responses 用 instructions 承载 system');
  eq(q.body.input.length, 1, 'responses 用 input 数组');
  eq(q.body.input[0].role, 'user', 'responses input[0].role = user');
  /* gpt-5-codex 命中 reasoning 规则，输出上限同样被抬到下限 */
  eq(q.body.max_output_tokens, 1024, 'responses 用 max_output_tokens（推理模型抬到下限）');
  ok(!('messages' in q.body), 'responses 不再出现 messages');
  ok(!('temperature' in q.body), 'gpt-5 系不传 temperature');

  /* 对照：同一个协议下的非推理模型，上限原样传递 */
  const r2 = P.resolve({ providerId: 'openai', token: 'k', model: 'gpt-4o-mini', api: 'responses' });
  const q2 = P.buildRequest(r2, { system: 'S', user: 'U', maxTokens: 500, temperature: 0.9 });
  eq(q2.body.max_output_tokens, 500, '非推理模型（responses）上限原样保留');
  eq(q2.body.temperature, 0.9, 'gpt-4o-mini 仍然带 temperature');
}

section('buildRequest · anthropic');
{
  const r = P.resolve({ providerId: 'anthropic', token: 'sk-a', model: 'claude-sonnet-4-20250514' });
  const q = P.buildRequest(r, { system: 'SYS', user: 'USER', maxTokens: 300, temperature: 0.9 });
  eq(q.url, 'https://api.anthropic.com/v1/messages', 'anthropic url');
  eq(q.headers['x-api-key'], 'sk-a', 'anthropic 用 x-api-key');
  eq(q.headers['anthropic-version'], '2023-06-01', 'anthropic-version 正确');
  ok(!q.headers.authorization, 'anthropic 不用 Bearer');
  eq(q.body.system, 'SYS', 'anthropic 用顶层 system');
  eq(q.body.max_tokens, 300, 'anthropic max_tokens');
  eq(q.body.messages.length, 1, 'anthropic messages 只有 user（system 不在 messages 里）');
  eq(q.body.temperature, 0.9, 'anthropic 带 temperature（范围内）');
}
{
  /* max_tokens 必填：不传也得给一个默认值，否则 400 */
  const r = P.resolve({ providerId: 'anthropic', token: 'k', model: 'claude-haiku' });
  const q = P.buildRequest(r, { system: 'S', user: 'U' });
  ok(q.body.max_tokens > 0, 'anthropic 缺省 max_tokens 有兜底值');
}
{
  /* temperature 超范围要被夹到 anthropic 的 0~1 */
  const r = P.resolve({ providerId: 'anthropic', token: 'k', model: 'claude-haiku' });
  const q = P.buildRequest(r, { system: 'S', user: 'U', temperature: 1.8 });
  eq(q.body.temperature, 1, 'anthropic temperature 夹到 1');
}

/* ---------------- 6) parseReply ---------------- */
section('parseReply');
{
  const r = P.resolve({ providerId: 'deepseek', token: 'k', model: 'deepseek-chat' });
  eq(P.parseReply(r, { choices: [{ message: { content: '甲' } }] }), '甲', 'chat 取 choices[0].message.content');
  eq(P.parseReply(r, { choices: [{ text: '乙' }] }), '乙', 'chat 兜底取 choices[0].text');
  eq(P.parseReply(r, { choices: [{ message: { content: '', reasoning_content: '丙' } }] }), '丙',
    'chat 正文为空时兜底 reasoning_content');
  eq(P.parseReply(r, null), '', '空响应返回空串');
}
{
  const r = P.resolve({ providerId: 'openai', token: 'k', model: 'gpt-5-codex' });
  eq(P.parseReply(r, {
    output: [
      { type: 'reasoning', content: [] },
      { type: 'message', content: [{ type: 'output_text', text: '甲' }, { type: 'output_text', text: '乙' }] },
    ],
  }), '甲乙', 'responses 遍历 output 拼接 output_text（跳过 reasoning 项）');
  eq(P.parseReply(r, { output_text: '快捷字段' }), '快捷字段', 'responses 优先用 output_text');
  /* 官方提示的坑：文本不在 output[0] —— 上面那条已经覆盖 */
}
{
  const r = P.resolve({ providerId: 'anthropic', token: 'k', model: 'claude-opus-4' });
  eq(P.parseReply(r, { content: [{ type: 'text', text: '甲' }, { type: 'thinking', text: '忽略' }, { type: 'text', text: '乙' }] }),
    '甲乙', 'anthropic 只拼 type=text 的块');
  eq(P.parseReply(r, { content: '裸字符串' }), '裸字符串', 'anthropic 兼容裸字符串 content');
}

/* ---------------- 7) parseError ---------------- */
section('parseError');
{
  const r = P.resolve({ providerId: 'deepseek', token: 'k', model: 'deepseek-chat' });
  const m401 = P.parseError(r, 401, { error: { message: 'invalid api key' } }, '');
  ok(/invalid api key/.test(m401) && /Key 无效/.test(m401), '401 保留原文并补提示', m401);
  const m404 = P.parseError(r, 404, { error: { message: 'model not found' } }, '');
  ok(/model not found/.test(m404) && /baseUrl/.test(m404), '404 提示检查地址/模型名', m404);
  const mHtml = P.parseError(r, 502, null, '<html>bad gateway</html>');
  ok(/bad gateway/.test(mHtml), '非 JSON 响应带出原文片段', mHtml);
}
{
  /* anthropic 的错误挂在 error.message / error.type */
  const r = P.resolve({ providerId: 'anthropic', token: 'k', model: 'claude-opus-4' });
  const m = P.parseError(r, 400, { error: { type: 'invalid_request_error', message: 'max_tokens: required' } }, '');
  ok(/max_tokens: required/.test(m), 'anthropic 错误原文被取出', m);
}

/* ---------------- 8) /models ---------------- */
section('模型列表');
{
  const r = P.resolve({ providerId: 'deepseek', token: 'sk-m', model: 'deepseek-chat' });
  const q = P.buildModelsRequest(r);
  eq(q.url, 'https://api.deepseek.com/v1/models', 'models url');
  eq(q.method, 'GET', 'models 用 GET');
  eq(q.headers.authorization, 'Bearer sk-m', 'models 带 Bearer');
}
{
  const r = P.resolve({ providerId: 'anthropic', token: 'sk-m', model: 'claude-opus-4' });
  const q = P.buildModelsRequest(r);
  eq(q.url, 'https://api.anthropic.com/v1/models', 'anthropic models url');
  eq(q.headers['x-api-key'], 'sk-m', 'anthropic models 用 x-api-key');
}
{
  eq(P.parseModels({ data: [{ id: 'a', display_name: 'A' }, 'b' ] }).length, 2, 'OpenAI/Anthropic 风格 data[]');
  eq(P.parseModels({ models: [{ name: 'c' }] })[0].id, 'c', '兼容 models[] 与 name 字段');
  eq(P.parseModels({}).length, 0, '无列表时返回空数组，不抛错');
}

/* ---------------- 9) 本地覆盖（providers.local.json） ---------------- */
section('本地厂商覆盖表');
{
  const merged = P.listProviders([
    { id: 'deepseek', baseUrl: 'https://my-gateway.example.com/v1', name: '公司网关' },
    { id: 'selfhost', name: '自建', api: 'chat', baseUrl: 'http://10.0.0.5:8000/v1' },
  ]);
  const ds = merged.find((x) => x.id === 'deepseek');
  eq(ds.baseUrl, 'https://my-gateway.example.com/v1', '同 id 被覆盖');
  eq(ds.name, '公司网关', '覆盖连 name 一起生效');
  eq(ds.api, 'chat', '未提供的字段保留原值');
  ok(!!merged.find((x) => x.id === 'selfhost'), '新 id 被追加');
  eq(merged.length, P.PROVIDERS.length + 1, '只多出一条（同 id 不新增）');

  const r = P.resolve({ providerId: 'selfhost', token: 'k', model: 'x' }, { providers: [{ id: 'selfhost', name: '自建', api: 'chat', baseUrl: 'http://10.0.0.5:8000/v1' }] });
  eq(r.baseUrl, 'http://10.0.0.5:8000/v1', '自定义厂商能参与 resolve');
}

/* ---------------- 10) describe ---------------- */
section('describe');
{
  const r = P.resolve({ providerId: 'deepseek', token: 'k', model: 'deepseek-chat' });
  eq(P.describe(r), 'DeepSeek · deepseek-chat · chat', '摘要格式');
}

/* ---------------- 汇总 ---------------- */
lines.push('');
lines.push('==== ' + (fail ? 'FAIL' : 'PASS') + ' · 通过 ' + pass + ' / 失败 ' + fail + ' ====');
const text = lines.join('\n');
console.log(text);

mkdirSync(join(ROOT, 'output'), { recursive: true });
writeFileSync(join(ROOT, 'output', 'probe-providers.txt'), text, 'utf8');
process.exit(fail ? 1 : 0);

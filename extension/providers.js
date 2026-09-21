/* providers.js — AI Provider 声明表 + 协议适配（全项目唯一实现）
 *
 * 设计参考 zai-org/ZCode 的 config/provider/*.json（见 README 的
 * "配置 / ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"）。概念一一对应：
 *
 *   ZCode 那一套                                    这里
 *   ────────────────────────────────────────────────────────────────────
 *   schemaVersion / revision                        SCHEMA / REV
 *   templateRules[].config.api.type                 PROVIDERS[].api        （协议）
 *   templateRules[].config.api.baseUrl              PROVIDERS[].baseUrl
 *   templateRules[].config.access.apiKeyManagementUrl  PROVIDERS[].keyUrl  （钥匙去哪申请）
 *   templateRules[].config.builtinModelIds          PROVIDERS[].models     （候选，仅提示）
 *   modelConfigRules.modelRules（modelMatch 正则）   MODEL_RULES
 *   config/provider/zcode-builtin.json 可被本地文件替换  → providers.local.json（在 serve.mjs 读，覆盖同 id 条目）
 *
 * 三条硬规矩，都是 ZCode 那套的核心，别改：
 *
 *   1) **密钥不进这张表。** 表里只声明「要不要 Key、去哪申请」（needsKey / keyUrl），
 *      与 access.type 的做法一致。Key 由用户从弹窗、localStorage、
 *      site/.ai-config.json 或环境变量注入，任何时候都不写进本文件。
 *
 *   2) **协议(api) 与厂商(provider) 解耦。** 请求的「形状」只由 api 决定，
 *      厂商只负责提供 baseUrl 和模型名。同一种协议被十几家厂商复用，
 *      同一个厂商也可能同时提供多种协议 —— 所以这两件事必须分开放。
 *      目前支持三种：
 *        chat       OpenAI Chat Completions  /chat/completions  （最通用）
 *        responses  OpenAI Responses          /responses
 *        anthropic  Anthropic Messages        /messages
 *
 *   3) **模型级差异写规则，不写代码。** 「这个模型不吃 temperature」
 *      「这个模型 token 字段改名了」一律进 MODEL_RULES 的正则表。
 *      与 modelApiRules 的 modelMatch + apiTypeMatch 同一思路。
 *
 * ⚠️ 双端共用，下面这个 UMD 头不能删：
 *      浏览器  <script src="providers.js">            → window.JBProviders
 *      Node    import providers from './providers.js' → CJS 默认导入
 *      扩展    import './providers.js'（副作用导入）  → globalThis.JBProviders
 *    （extension/providers.js 是 scripts/build_extension.py 从本文件复制的生成物）
 *
 * 接口形状的事实来源（写规则前先读官方文档，别凭印象）：
 *   Chat Completions  https://platform.openai.com/docs/api-reference/chat
 *   Responses         https://platform.openai.com/docs/guides/text-generation
 *                     （官方明确：文本可能不在 output[0].content[0].text，必须遍历 output）
 *   Anthropic Messages https://docs.claude.com/en/api/messages
 *                     （POST /v1/messages；x-api-key + anthropic-version: 2023-06-01；
 *                       max_tokens 必填；正文在 content[].text）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.JBProviders = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA = 1; // 表结构版本；字段增删要 +1（对齐 schemaVersion）
  var REV = 1;    // 表内容修订号；加厂商/改规则请 +1（对齐 revision）

  var ANTHROPIC_VERSION = '2023-06-01';

  /* ---------------- api.type：请求与响应的「形状」 ---------------- */

  var API_TYPES = [
    {
      id: 'chat', name: 'OpenAI Chat Completions', path: '/chat/completions',
      note: '最通用。Kimi / DeepSeek / 通义 / 智谱 / 硅基流动等的兼容接口都是它',
    },
    {
      id: 'responses', name: 'OpenAI Responses', path: '/responses',
      note: 'OpenAI 新接口，推理模型官方推荐；Codex 系列只能用这个',
    },
    {
      id: 'anthropic', name: 'Anthropic Messages', path: '/messages',
      note: 'Claude 原生协议（x-api-key + anthropic-version）',
    },
  ];
  var API_IDS = ['chat', 'responses', 'anthropic'];

  /* ---------------- 厂商表 ----------------
   * baseUrl 与 keyUrl 以各厂商官方文档为准，厂商改地址时改这里即可。
   * models 只是输入框的候选（下拉/联想用），不参与任何校验 ——
   * 它一定会过期，所以宁可少写几条也别当白名单用。
   * needsKey:false 的（本地 Ollama）不强制填 Key。
   */
  var PROVIDERS = [
    {
      id: 'openai', name: 'OpenAI', api: 'chat',
      baseUrl: 'https://api.openai.com/v1',
      keyUrl: 'https://platform.openai.com/api-keys',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    },
    {
      id: 'deepseek', name: 'DeepSeek', api: 'chat',
      baseUrl: 'https://api.deepseek.com/v1',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    },
    {
      id: 'moonshot', name: '月之暗面 Kimi', api: 'chat',
      baseUrl: 'https://api.moonshot.cn/v1',
      keyUrl: 'https://platform.moonshot.cn/console/api-keys',
      models: ['kimi-k2-turbo-preview', 'moonshot-v1-8k'],
    },
    {
      id: 'zhipu', name: '智谱 GLM', api: 'chat',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
      models: ['glm-4.5-flash', 'glm-4-plus'],
    },
    {
      id: 'dashscope', name: '阿里百炼（通义）', api: 'chat',
      // 注意：这个兼容端点的版本段是 /compatible-mode/v1，不是 /v1
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      keyUrl: 'https://bailian.console.aliyun.com/',
      models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    },
    {
      id: 'siliconflow', name: '硅基流动', api: 'chat',
      baseUrl: 'https://api.siliconflow.cn/v1',
      keyUrl: 'https://cloud.siliconflow.cn/account/ak',
      models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct'],
    },
    {
      id: 'volcengine', name: '火山方舟（豆包）', api: 'chat',
      // 版本段是 /api/v3；model 要填「接入点 ID」或模型 ID
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      keyUrl: 'https://console.volcengine.com/ark',
      models: [],
    },
    {
      id: 'hunyuan', name: '腾讯混元', api: 'chat',
      baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
      keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
      models: ['hunyuan-turbos-latest', 'hunyuan-lite'],
    },
    {
      id: 'openrouter', name: 'OpenRouter', api: 'chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      keyUrl: 'https://openrouter.ai/keys',
      models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'],
    },
    {
      id: 'gemini', name: 'Google Gemini（兼容层）', api: 'chat',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      keyUrl: 'https://aistudio.google.com/apikey',
      models: ['gemini-2.0-flash', 'gemini-2.5-flash'],
    },
    {
      id: 'anthropic', name: 'Anthropic Claude', api: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
    },
    {
      id: 'ollama', name: '本地 Ollama', api: 'chat', needsKey: false,
      baseUrl: 'http://127.0.0.1:11434/v1',
      keyUrl: '',
      models: ['qwen2.5:7b', 'llama3.1:8b'],
      note: '本地跑，不用 Key（随便填一个非空的也行）',
    },
    {
      id: 'custom', name: '自定义（自填地址）', api: 'chat',
      baseUrl: '', keyUrl: '', models: [],
      note: '任何 OpenAI 兼容网关：one-api / new-api / LiteLLM 之类都选它',
    },
  ];

  /* ---------------- 模型级规则（对应 modelApiRules） ----------------
   * match     模型名的正则
   * api       协议覆盖：
   *             apiForce = 硬约束，压过 provider 的声明（否则接口直接 404）
   *             apiHint  = 弱暗示，只在 provider 没声明协议时生效
   * params    dropTemperature  不传 temperature（传了会被拒或行为异常）
   *             tokenParam        chat 协议下输出上限的字段名
   *             minOutput        输出上限的下限值（推理模型专治「正文被思考挤空」）
   * why       依据（写清楚，别留"据说"）
   */
  var MODEL_RULES = [
    {
      match: /^o[1-9](?=[-.0-9]|$)/i,
      dropTemperature: true, tokenParam: 'max_completion_tokens', minOutput: 1024,
      why: 'OpenAI o 系列推理模型：不收 temperature，输出上限字段是 max_completion_tokens',
    },
    {
      match: /^(gpt-5|gpt-6)/i,
      dropTemperature: true, tokenParam: 'max_completion_tokens', minOutput: 1024,
      why: 'OpenAI gpt-5 起只接受默认 temperature，输出上限字段已改名',
    },
    {
      match: /codex/i, apiForce: 'responses',
      why: 'OpenAI Codex 系列只在 Responses 端点提供，打 Chat Completions 会 404',
    },
    {
      match: /^claude|^anthropic\//i, apiHint: 'anthropic',
      why: 'Claude 走 Messages 协议；但若所选厂商只提供 OpenAI 兼容端点，provider 的声明优先',
    },
    {
      match: /deepseek-(reasoner|r1)|^deepseek-r/i,
      dropTemperature: true, minOutput: 1024,
      why: 'DeepSeek 推理模型不收 temperature（官方会忽略并提示）',
    },
    {
      match: /(^|[-_/])r1([-_]|$)|reasoning|thinking/i,
      dropTemperature: true, minOutput: 1024,
      why: '推理型模型对采样参数普遍不敏感或直接拒绝，不传最稳',
    },
  ];

  /* ---------------- 基础工具 ---------------- */

  function toArray(x) { return Array.isArray(x) ? x : []; }

  function normalizeBase(baseUrl) {
    var s = String(baseUrl || '').trim().replace(/\s+/g, '');
    if (!s) return '';
    s = s.replace(/\/+$/, '');
    /* 用户常把完整 endpoint 直接贴进来（…/v1/chat/completions），剥掉后缀。
     * 各家版本段五花八门（/v1、/api/paas/v4、/api/v3、/compatible-mode/v1），
     * 所以除了下面那条 OpenAI 特例，一律不猜、不自动补版本段。 */
    s = s.replace(/\/(chat\/completions|responses|messages|completions)$/i, '');
    s = s.replace(/\/+$/, '');
    if (/^https?:\/\/api\.openai\.com$/i.test(s)) s += '/v1';
    return s;
  }

  function findProvider(id, extraProviders) {
    if (!id) return null;
    var all = toArray(extraProviders).concat(PROVIDERS);
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === id) return all[i];
    }
    return null;
  }

  /* 内置表 + 本地覆盖（providers.local.json）。同 id 覆盖，新 id 追加。
   * 对应 ZCode 用 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 替换内置配置的做法。 */
  function listProviders(extraProviders) {
    var out = PROVIDERS.slice();
    var extra = toArray(extraProviders);
    for (var i = 0; i < extra.length; i++) {
      var p = extra[i];
      if (!p || !p.id) continue;
      var hit = -1;
      for (var j = 0; j < out.length; j++) if (out[j].id === p.id) { hit = j; break; }
      var merged = {};
      if (hit >= 0) {
        for (var k in out[hit]) if (Object.prototype.hasOwnProperty.call(out[hit], k)) merged[k] = out[hit][k];
      }
      for (var k2 in p) if (Object.prototype.hasOwnProperty.call(p, k2)) merged[k2] = p[k2];
      if (hit >= 0) out[hit] = merged; else out.push(merged);
    }
    return out;
  }

  function modelRule(model) {
    var m = String(model || '');
    var out = { dropTemperature: false, tokenParam: '', apiForce: '', apiHint: '', minOutput: 0, why: [] };
    if (!m) return out;
    for (var i = 0; i < MODEL_RULES.length; i++) {
      var r = MODEL_RULES[i];
      if (!r.match.test(m)) continue;
      if (r.dropTemperature) out.dropTemperature = true;
      if (r.tokenParam && !out.tokenParam) out.tokenParam = r.tokenParam;
      if (r.apiForce && !out.apiForce) out.apiForce = r.apiForce;
      if (r.apiHint && !out.apiHint) out.apiHint = r.apiHint;
      if (r.minOutput > out.minOutput) out.minOutput = r.minOutput;
      if (r.why) out.why.push(r.why);
    }
    return out;
  }

  /* 老配置没有 api 字段时的兜底判断（向后兼容用） */
  function guessApi(model, baseUrl) {
    var m = String(model || ''), b = String(baseUrl || '');
    if (/anthropic\.com|\/messages$/i.test(b)) return 'anthropic';
    if (/^claude/i.test(m)) return 'anthropic';
    return 'chat';
  }

  /* ---------------- 配置归一化 ----------------
   * cfg 可以是老的三要素（baseUrl/token/model），也可以是
   * 新的 { providerId, baseUrl, token, model, api }。
   * 输出一份「描述怎么调」的完整对象，后面所有函数只认它。
   */
  function resolve(cfg, opts) {
    cfg = cfg || {};
    var extra = (opts && opts.providers) || [];
    var p = findProvider(String(cfg.providerId || ''), extra);
    var model = String(cfg.model || '').trim();
    var baseUrl = normalizeBase(cfg.baseUrl) ||
                  normalizeBase(p ? p.baseUrl : '');
    var rule = modelRule(model);
    var warnings = [];

    /* 协议优先级：用户手选 > 模型硬约束 > 厂商声明 > 模型弱暗示 > 猜测
     * 用户手选永远最大；模型的硬约束（codex 只能 responses）压过厂商声明，
     * 因为压不过去就是直接 404 —— 那是错误，不是选择。 */
    var api = String(cfg.api || '') || rule.apiForce || (p && p.api) || rule.apiHint || guessApi(model, baseUrl);
    if (API_IDS.indexOf(api) < 0) api = 'chat';
    if (rule.apiForce && cfg.api && cfg.api !== rule.apiForce) {
      warnings.push('这个模型通常只支持 ' + rule.apiForce + ' 协议，已在按 ' + cfg.api + ' 发送，若报 404 请改回');
    }

    var needsKey = p ? p.needsKey !== false : true;
    var token = String(cfg.token || '');

    return {
      providerId: p ? p.id : (cfg.providerId || ''),
      providerName: p ? p.name : (cfg.providerId ? String(cfg.providerId) : '自定义'),
      known: !!p,
      baseUrl: baseUrl,
      token: token,
      model: model,
      api: api,
      needsKey: needsKey,
      keyUrl: p ? (p.keyUrl || '') : '',
      models: p ? toArray(p.models) : [],
      extra: cfg.extra && typeof cfg.extra === 'object' ? cfg.extra : null,
      rule: rule,
      warnings: warnings,
    };
  }

  /* 一眼能看懂的一行摘要，给 toast / 错误提示用 */
  function describe(r) {
    if (!r) return '';
    var parts = [];
    if (r.providerName) parts.push(r.providerName);
    if (r.model) parts.push(r.model);
    parts.push(r.api);
    return parts.join(' · ');
  }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  /* ---------------- 组装请求 ----------------
   * opts: { system, user, maxTokens, temperature }
   * 返回 { url, method, headers, body }，直接喂给 fetch 即可。
   */
  function buildRequest(r, opts) {
    opts = opts || {};
    var sys = String(opts.system || '');
    var user = String(opts.user || '');
    var maxTokens = Number(opts.maxTokens) || 0;
    var hasTemp = (typeof opts.temperature === 'number');
    var rule = r.rule || {};
    /* 推理模型去掉 temperature —— 不是设成 1，是整个字段不出现 */
    var keepTemp = hasTemp && !rule.dropTemperature;
    /* 推理模型的「思考」也计入输出上限：单条点评只给 120 会被思考吃光，
     * 表现成「AI 返回了空内容」。命中推理规则的模型抬一个下限。 */
    if (rule.minOutput && maxTokens > 0 && maxTokens < rule.minOutput) maxTokens = rule.minOutput;

    var headers = { 'content-type': 'application/json' };
    var body = { model: r.model };
    var url;

    if (r.api === 'anthropic') {
      url = r.baseUrl + '/messages';
      headers['x-api-key'] = r.token;
      headers['anthropic-version'] = ANTHROPIC_VERSION;
      /* max_tokens 是必填项，缺了直接 400，所以这里一定要给值 */
      body.max_tokens = maxTokens || 1024;
      if (sys) body.system = sys;
      body.messages = [{ role: 'user', content: user }];
      if (keepTemp) body.temperature = clamp(opts.temperature, 0, 1);
    } else if (r.api === 'responses') {
      url = r.baseUrl + '/responses';
      headers.authorization = 'Bearer ' + r.token;
      /* Responses 用 instructions 承载 system，用 input 承载对话，
       * 输出上限叫 max_output_tokens（不是 max_tokens） */
      if (sys) body.instructions = sys;
      body.input = [{ role: 'user', content: user }];
      body.max_output_tokens = maxTokens || 4096;
      if (keepTemp) body.temperature = clamp(opts.temperature, 0, 2);
    } else {
      url = r.baseUrl + '/chat/completions';
      headers.authorization = 'Bearer ' + r.token;
      body.messages = [];
      if (sys) body.messages.push({ role: 'system', content: sys });
      body.messages.push({ role: 'user', content: user });
      if (maxTokens) body[rule.tokenParam || 'max_tokens'] = maxTokens;
      if (keepTemp) body.temperature = clamp(opts.temperature, 0, 2);
    }

    /* 逃生舱：模型规则没覆盖到的怪参数，让用户自己塞（对应 modelApiRules 的 config） */
    if (r.extra) {
      for (var k in r.extra) {
        if (Object.prototype.hasOwnProperty.call(r.extra, k)) body[k] = r.extra[k];
      }
    }

    return { url: url, method: 'POST', headers: headers, body: body, api: r.api };
  }

  /* ---------------- 解析回复 ---------------- */

  function parseReply(r, data) {
    if (!data || typeof data !== 'object') return '';

    if (r.api === 'anthropic') {
      var c = data.content;
      if (typeof c === 'string') return c;
      var parts = [];
      c = toArray(c);
      for (var i = 0; i < c.length; i++) {
        if (c[i] && c[i].type === 'text' && c[i].text) parts.push(String(c[i].text));
      }
      return parts.join('');
    }

    if (r.api === 'responses') {
      /* 官方明说：文本不保证在 output[0].content[0].text，
       * 必须遍历 output 找 type=message 的 output_text 块 */
      if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
      var buf = [];
      var out = toArray(data.output);
      for (var j = 0; j < out.length; j++) {
        var item = out[j] || {};
        if (item.type && item.type !== 'message') continue;
        var cc = toArray(item.content);
        for (var k = 0; k < cc.length; k++) {
          if (cc[k] && cc[k].type === 'output_text' && cc[k].text) buf.push(String(cc[k].text));
        }
      }
      return buf.join('');
    }

    /* chat */
    var ch = toArray(data.choices)[0] || {};
    var msg = ch.message || {};
    var text = String(msg.content || ch.text || '');
    if (!text && msg.reasoning_content) {
      /* 推理模型的正文偶发只落在 reasoning_content 里（content 空）。
       * 这不是规范行为，所以只当兜底：调用方仍会做「提取 JSON」的容错。 */
      text = String(msg.reasoning_content);
    }
    return text;
  }

  /* ---------------- 错误翻译 ----------------
   * 上游原文照旧带出来（排障要靠它），只补一句可操作的提示。
   */
  function parseError(r, httpStatus, data, rawText) {
    var d = (data && typeof data === 'object') ? data : {};
    var msg = '';
    if (typeof d.error === 'string') msg = d.error;
    else if (d.error && typeof d.error === 'object') msg = d.error.message || d.error.msg || d.error.type || '';
    if (!msg) msg = d.message || d.msg || '';
    if (!msg && rawText) msg = String(rawText).slice(0, 200).replace(/\s+/g, ' ').trim();

    var hint = '';
    var http = Number(httpStatus) || 0;
    if (http === 401 || http === 403) hint = '（Key 无效 / 过期 / 无该模型权限）';
    else if (http === 404) hint = '（接口地址或模型名不对：多数厂商的 baseUrl 要以 /v1 结尾，模型名要与厂商文档一致）';
    else if (http === 429) hint = '（触发限流或余额不足）';
    else if (http >= 500) hint = '（上游服务故障，稍后重试）';

    return (msg || ('HTTP ' + http)) + hint;
  }

  /* ---------------- 模型列表（可选的便利功能） ---------------- */

  function buildModelsRequest(r) {
    var headers = {};
    if (r.api === 'anthropic') {
      headers['x-api-key'] = r.token;
      headers['anthropic-version'] = ANTHROPIC_VERSION;
    } else {
      headers.authorization = 'Bearer ' + r.token;
    }
    return { url: r.baseUrl + '/models', method: 'GET', headers: headers };
  }

  function parseModels(data) {
    var arr = (data && (data.data || data.models)) || [];
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      if (!m) continue;
      if (typeof m === 'string') { out.push({ id: m, name: m }); continue; }
      var id = String(m.id || m.name || m.model || '');
      if (!id) continue;
      out.push({ id: id, name: String(m.display_name || m.name || id) });
    }
    return out;
  }

  return {
    SCHEMA: SCHEMA,
    REV: REV,
    ANTHROPIC_VERSION: ANTHROPIC_VERSION,
    API_TYPES: API_TYPES,
    API_IDS: API_IDS,
    PROVIDERS: PROVIDERS,
    MODEL_RULES: MODEL_RULES,
    listProviders: listProviders,
    findProvider: findProvider,
    normalizeBase: normalizeBase,
    modelRule: modelRule,
    guessApi: guessApi,
    resolve: resolve,
    describe: describe,
    buildRequest: buildRequest,
    parseReply: parseReply,
    parseError: parseError,
    buildModelsRequest: buildModelsRequest,
    parseModels: parseModels,
  };
});

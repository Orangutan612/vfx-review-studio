/**
 * llm.mjs —— 最小可用的 OpenAI 兼容多模态客户端（只用内置 fetch，零依赖）。
 *
 * 兼容面刻意做窄但做稳：
 *   - 图片以 image_url 内容块发送（OpenAI / DeepSeek / 通义 / 智谱 / Kimi / 火山 都认这套）
 *   - 有些服务商不认 response_format: json_object，遇到就自动去掉重试一次
 *   - 模型回复常带 \`\`\`json 包裹或寒暄，用宽松解析兜住，再不行就要求它只输出 JSON 重试
 */
import { config } from './config.mjs?v=1791823158551';

export class LlmError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.body = body;
  }
}

/** 把 data URL 变成 OpenAI 的 image_url 内容块。 */
export function imagePart(dataUrl, detail = 'high') {
  return { type: 'image_url', image_url: { url: dataUrl, detail } };
}

export function textPart(text) {
  return { type: 'text', text };
}

function resolveCredentials(overrides) {
  const baseUrl = (overrides.baseUrl || config.baseUrl || '').replace(/\/+$/, '');
  // apiKey === undefined 表示「用配置文件里的」；显式传空串表示「这次本来就不需要 Key」（如本地 Ollama）。
  const apiKey = overrides.apiKey === undefined ? config.apiKey : overrides.apiKey;
  if (!baseUrl) throw new LlmError('还没有填写模型服务的接口地址。', 0, null);
  if (overrides.apiKey === undefined && !config.apiKey) {
    throw new LlmError('还没有配置 API Key。请在网页顶部的「配置模型」里粘贴一个，或设 LLM_MOCK=1 先用离线演示模式。', 0, null);
  }
  // 离线保险：自检 / 生成示例脚本会设 DSH_BLOCK_NETWORK=1。
  // 必须在**发请求的这一刻**判断，而不是靠 import 前改 process.env ——
  // config.mjs 一旦加载完，baseUrl/apiKey 就已经进内存了，之后再改环境变量是没用的。
  // 只放行本地环回，这样自检里的假端点照常工作，真实服务商一个字节都碰不到。
  // ⚠️ 浏览器里没有 process —— 直接读会炸「process is not defined」。
  // 这也是链接版配置模型时报错的原因。
  const blockNetwork = typeof process !== 'undefined' && process.env && process.env.DSH_BLOCK_NETWORK === '1';
  if (blockNetwork
    && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(baseUrl)) {
    throw new LlmError('已启用离线保险，拒绝向 ' + baseUrl + ' 发起请求（避免花掉你的 API 额度）。', 0, null);
  }
  return { baseUrl, apiKey };
}

async function postChat({ messages, model, temperature, maxTokens, json, baseUrl, apiKey, timeoutMs, signal, reasoningEffort }) {
  const body = { model: model || config.model, messages, temperature, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  // 思考强度。DeepSeek 的思考模式默认打开且 effort=high，思维链会先吃掉 max_tokens，
  // 给太少正文就是空的。留空表示不干预（各服务商用默认值）；
  // 想省时间省钱可以在 .env 里设 LLM_REASONING_EFFORT=low。
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

  const timeout = AbortSignal.timeout(timeoutMs || config.requestTimeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response;
  try {
    response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal: composed,
    });
  } catch (error) {
    throw new LlmError('连不上模型服务（' + baseUrl + '）：' + (error?.message || error), 0, null);
  }
  const text = await response.text();
  return { response, text };
}

/**
 * 调一次 /chat/completions。
 * overrides: { baseUrl, apiKey, timeoutMs } —— 供「测试连接」用别的凭据，不动全局配置。
 */
export async function chat(params) {
  const { messages, model, temperature = 0.3, maxTokens = 8000, json = false, signal } = params;
  const { baseUrl, apiKey } = resolveCredentials(params);
  const effort = params.reasoningEffort ?? (config.reasoningEffort || '');

  const send = options => postChat({
    messages, model, temperature, baseUrl, apiKey,
    timeoutMs: params.timeoutMs, signal, reasoningEffort: effort, ...options,
  });

  let budget = maxTokens;
  let wantJson = json;
  let lastError = null;

  // 最多让两件事各退一步：服务商不认 response_format、服务商对 max_tokens 有更小的硬上限。
  // 这两件都不是用户的错，不该把整次评审卡死。
  for (let attempt = 0; attempt < 5; attempt++) {
    const { response, text } = await send({ maxTokens: budget, json: wantJson });
    if (response.ok) return readChoice(text, response.status);

    const detail = text.slice(0, 600);
    if (wantJson && response.status === 400 && /response_format|json_object|json mode/i.test(text)) {
      wantJson = false;
      lastError = new LlmError('模型服务返回 400：' + detail, 400, text);
      continue;
    }
    if (response.status === 400 && budget > 2048
      && /max_tokens|max_completion_tokens|maximum context|too large|exceed/i.test(text)) {
      budget = Math.max(2048, Math.floor(budget / 2));
      lastError = new LlmError('模型服务返回 400：' + detail, 400, text);
      continue;
    }
    throw new LlmError('模型服务返回 ' + response.status + '：' + detail, response.status, text);
  }
  throw lastError || new LlmError('模型服务连续拒绝了请求。', 0, null);
}

function readChoice(text, status) {
  let data;
  try { data = JSON.parse(text); } catch {
    throw new LlmError('模型服务返回的不是 JSON：' + text.slice(0, 300), status, text);
  }
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message) throw new LlmError('模型服务没有返回 choices[0].message。', status, text);
  const content = typeof message.content === 'string' ? message.content : contentToText(message.content);
  // 思考型模型（DeepSeek 的思考模式默认打开）把思维链放在 reasoning_content 里，与 content 同级。
  // 「正文空、思维链有内容」一般意味着 max_tokens 被思考过程吃光了 —— 必须和「模型没回答」区分开，
  // 否则会把一个完全正常的模型误报成「读不出图」。
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content
    : typeof message.reasoning === 'string' ? message.reasoning : '';
  return {
    content,
    reasoning,
    text: content || reasoning,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage: data.usage || null,
    raw: data,
  };
}

function contentToText(content) {
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
  return '';
}

/**
 * 从模型回复里抠出 JSON。模型经常在 JSON 外面包一层代码块或加一句寒暄，
 * 所以先直接 parse，失败再退到「第一个 { 到最后一个 }」。
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') throw new Error('模型没有返回文本内容。');
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed);
  if (fence) candidates.push(fence[1]);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error('模型返回的内容不是合法 JSON：' + trimmed.slice(0, 400));
}

/** 调模型并要求 JSON；失败重试一次，第二次明确要求「只输出 JSON」。 */
export async function chatJson(params, { retries = 1 } = {}) {
  const ceiling = Math.max(2048, Number(params.maxTokensCeiling) || config.maxOutputTokens);
  let budget = Math.max(1024, Number(params.maxTokens) || 8000);
  let lastError;
  let lastRaw = '';
  let lastReasoning = '';
  let messages = params.messages;

  for (let call = 0; call < 4; call++) {
    const result = await chat({ ...params, messages, maxTokens: budget, json: true });
    lastRaw = result.text;
    lastReasoning = result.reasoning || '';

    // finish_reason=length 表示输出被 max_tokens 硬截断了 —— 这时候重试一样的预算只会再被
    // 截断一次，必须直接把预算加倍。思考型模型（DeepSeek 默认 effort=high）最容易撞上这个。
    if (result.finishReason === 'length') {
      if (budget < ceiling) {
        budget = Math.min(ceiling, budget * 2);
        messages = params.messages;
        continue;
      }
      throw new LlmError(
        '模型的输出被 max_tokens（' + budget + '）截断了，JS' + 'ON 都没写完就被切掉。'
        + '这通常是思考型模型把预算吃掉了（DeepSeek 的思考模式默认打开、强度 high）。三个办法：'
        + '① 在 .env 里加一行 LLM_REASONING_EFFORT=low 再重启服务；'
        + '② 把「写几条建议」调低一档；'
        + '③ 提高 .env 里的 LLM_MAX_OUTPUT_TOKENS（DeepSeek 最大 384K，当前上限 ' + ceiling + '）。',
        0,
        lastRaw,
      );
    }
    try {
      return { value: parseJsonLoose(result.text), usage: result.usage, finishReason: result.finishReason };
    } catch (error) {
      lastError = error;
      if (call >= retries) break;
      messages = [
        ...params.messages,
        { role: 'assistant', content: result.text.slice(0, 2000) },
        { role: 'user', content: '上一条回复无法被解析为 JSON。请只输出一个合法的 JSON 对象，不要任何解释、前后缀或 Markdown 代码块。' },
      ];
    }
  }
  if (!lastRaw) {
    throw new LlmError(
      '模型的正文是空的' + (lastReasoning ? '，但思维链有 ' + lastReasoning.length + ' 个字' : '，思维链也是空的') + '。'
      + (lastReasoning ? '这说明 max_tokens 被思考过程吃光了 —— DeepSeek 的思考模式默认打开且强度是 high。'
          + '可以在 .env 里加一行 LLM_REASONING_EFFORT=low，或把 LLM_MODEL 换成非思考模型。' : '模型名可能不对，或者这家不支持这种请求格式。'),
      lastError?.status || 0,
      lastReasoning,
    );
  }
  throw new LlmError(
    '模型连着两次都没有按要求返回 JSON，可能是这个模型不支持 JSON 输出、或者把答案写成了散文。'
    + '可以点「开始评审」再试一次，或者换一个模型（DeepSeek 的 deepseek-flash 实测正常）。'
    + '它这次回的是：' + String(lastRaw).slice(0, 160),
    lastError?.status || 0,
    lastRaw,
  );
}

/** 并发上限受控的 map。 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

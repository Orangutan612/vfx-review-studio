/**
 * setup.mjs —— 「配置模型」向导的后端。
 *
 * 存在的理由：这个工具唯一的门槛就是从服务商那里拿一个 API Key 并填对地址。
 * 对不熟命令行的人来说，「编辑 .env 文件」这一步就足以劝退，所以把它做成了网页上的
 * 一个对话框：选一家 → 粘贴 Key → 点一下 → 当场验证模型真的能读图 → 写盘 → 热生效。
 */
import { config, configStatus, writeEnvFile, reloadConfig, ENV_PATH } from './config.mjs?v=1791827165322';
import { chat, textPart, imagePart, LlmError } from './llm.mjs?v=1791827165322';
import { PROVIDERS, publicProviders, findProvider, TEST_IMAGE, TEST_QUESTION } from './providers.mjs?v=1791827165322';

export function setupState() {
  return {
    ...configStatus(),
    envPath: ENV_PATH,
    providers: publicProviders(),
  };
}

const clean = value => (typeof value === 'string' ? value.trim() : '');

/**
 * 用真实请求验证凭据 —— 而且刻意发一张图，因为「Key 有效」不等于「这个模型能读图」，
 * 而读图是整套流程唯一的硬需求。
 */
export async function testConnection(input = {}) {
  const baseUrl = clean(input.baseUrl) || config.baseUrl;
  const model = clean(input.model) || config.model;
  let apiKey = input.apiKey === undefined ? undefined : clean(input.apiKey);
  // 已经保存过 Key 的用户重新打开向导时输入框是空的，这时沿用已保存的那个，不该判定成 401。
  if (apiKey === '' && config.apiKey) apiKey = undefined;

  if (!baseUrl) return { ok: false, error: '还没有填写接口地址。' };
  if (!model) return { ok: false, error: '还没有填写模型名。' };

  try {
    const result = await chat({
      messages: [{
        role: 'user',
        content: [textPart(TEST_QUESTION), imagePart(TEST_IMAGE, 'low')],
      }],
      model,
      baseUrl,
      apiKey,
      temperature: 0,
      // ⚠️ 这里必须给足 token。DeepSeek 的思考模式默认打开且 effort=high，
      // 模型会先输出一长段思维链再给正文，两者共用 max_tokens。
      // 之前设成 60，思考就用光了预算、content 返回空串，被误判成「模型读不出图」。
      maxTokens: 4096,
      timeoutMs: 120000,
    });
    const reply = (result.content || '').trim().slice(0, 200);
    const reasoning = (result.reasoning || '').trim();
    const haystack = (reply + ' ' + reasoning).trim();
    const finish = result.finishReason ? '，finish_reason=' + result.finishReason : '';

    // 正文和思维链都是空的：这才是真的「没拿到东西」，别赖在模型不会读图上。
    if (!haystack) {
      return {
        ok: false,
        error: '模型没有返回任何内容' + finish + '。',
        hint: '两边都试过了：正文和思维链都是空的。通常是模型名填错了，或者这家服务不支持这种请求格式。',
      };
    }
    const denied = /无法(查看|看到|识别|读取|处理).{0,6}图|不能(查看|看到|识别|读取).{0,6}图|cannot (view|see|process|read)|no vision|不支持图|not support image|image input/i.test(haystack);
    const sawRed = /红|red/i.test(haystack);
    const shown = reply || reasoning.slice(0, 200);
    if (denied) {
      return {
        ok: true, visionOk: false, model, reply: shown, finishReason: result.finishReason,
        hint: '接口通了，但这个模型明确说自己读不了图。请换一个多模态模型，比如 DeepSeek 的 deepseek-flash、通义的 qwen-vl-max-latest、智谱的 glm-4v-plus。',
      };
    }
    if (!sawRed) {
      return {
        ok: true, visionOk: false, model, reply: shown, finishReason: result.finishReason,
        hint: '接口通了，但模型没有对图片作出回答（正确回答应该提到「红色」）'
          + (reply ? '。' : '；而且它只输出了思维链、没有正文，说明 max_tokens 还不够，可以把 .env 里的 LLM_REASONING_EFFORT 设成 low。'),
      };
    }
    return { ok: true, visionOk: true, model, reply: shown, finishReason: result.finishReason, hint: '连接正常，模型能读图。' };
  } catch (error) {
    const message = error instanceof LlmError ? error.message : (error?.message || '未知错误');
    let hint = '';
    if (/401|403|invalid.*key|unauthorized|authentication/i.test(message)) hint = '看起来是 API Key 不对或没有权限，回去检查有没有复制完整（注意别把空格或换行带进去）。';
    else if (/model|404|not found/i.test(message)) hint = '地址通了，但模型名可能不对。去服务商控制台复制准确的模型名填到「模型名」这一栏。';
    else if (/insufficient|balance|quota|余额|欠费/i.test(message)) hint = '账户余额不足，需要先充值。';
    else if (/connect|ENOTFOUND|fetch failed|timeout|abort/i.test(message)) hint = '连不上这个地址。检查接口地址有没有写错、网络能不能访问该服务。';
    return { ok: false, error: message, hint };
  }
}

/** 保存到 .env 并热生效（不用重启服务）。 */
export function saveSetup(input = {}) {
  const providerId = clean(input.provider) || 'custom';
  const preset = findProvider(providerId);
  const patch = {
    LLM_PROVIDER: providerId,
    LLM_BASE_URL: clean(input.baseUrl) || preset?.baseUrl || config.baseUrl,
    LLM_MODEL: clean(input.model) || preset?.model || config.model,
  };
  const apiKey = clean(input.apiKey);
  if (apiKey) patch.LLM_API_KEY = apiKey;
  // 一律重写：换服务商时，上一家的「取证小模型」在这里会被清空，不会残留成无效模型名。
  patch.LLM_SELECT_MODEL = clean(input.selectModel || '');

  writeEnvFile(patch);
  const status = reloadConfig();
  return { ...status, providers: publicProviders(), envPath: ENV_PATH };
}

export { PROVIDERS };

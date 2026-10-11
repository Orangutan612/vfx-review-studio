/**
 * config.mjs（浏览器版）—— 让 server/ 里那套评审逻辑原样在浏览器里跑。
 *
 * 为什么这么做：server/review.mjs 和 server/llm.mjs 只依赖 './config.mjs' 这一个东西。
 * 在同名路径放一个浏览器版，它们就变成**同构模块** —— Node 和浏览器共用同一份提示词、
 * 同一份归一化逻辑，不会出现「两边各改各的、结果跑偏」。
 *
 * ⚠️ 安全边界（这是硬约束，不是「尽量」）：
 *   这里所有数据只写进**本机浏览器的 localStorage**，永远不会离开这台电脑，
 *   唯一的例外是发给用户自己选择的模型服务（那是 AI 评审的物理前提）。
 *   没有「我们的服务器」，所以也没有任何地方能收集它。
 */

const STORE_KEY = 'vfx-config-v1';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 0,
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  selectModel: '',
  provider: 'deepseek',
  reasoningEffort: '',
  maxOutputTokens: 32768,
  maxRequestBytes: 24 * 1024 * 1024,
  maxBodyBytes: 40 * 1024 * 1024,
  requestTimeoutMs: 300000,
  concurrency: 2,
  updateRepo: '',
  mock: false,
  open: false,
};

const NUMERIC = new Set(['maxOutputTokens', 'maxRequestBytes', 'maxBodyBytes', 'requestTimeoutMs', 'concurrency']);

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function persist() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = config[key];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(out)); } catch {}
}

export const config = { ...DEFAULTS, ...read() };

/** 浏览器没有 .env 文件，这里用 localStorage 顶上。 */
export const ENV_PATH = '浏览器 localStorage（vfx-config-v1）—— 不落盘、不上传';

/** 环境变量名 → config 字段名。和 Node 版 writeEnvFile 的语义保持一致。 */
const ENV_TO_FIELD = {
  LLM_PROVIDER: 'provider',
  LLM_BASE_URL: 'baseUrl',
  LLM_MODEL: 'model',
  LLM_API_KEY: 'apiKey',
  LLM_SELECT_MODEL: 'selectModel',
  LLM_REASONING_EFFORT: 'reasoningEffort',
  LLM_MAX_OUTPUT_TOKENS: 'maxOutputTokens',
  LLM_MOCK: 'mock',
  UPDATE_REPO: 'updateRepo',
};

/**
 * 和 Node 版同名的函数：server/setup.mjs 保存时调用的就是它。
 * 这样 setup.mjs 也能原样在浏览器里跑。
 */
export function writeEnvFile(patch = {}) {
  for (const [envKey, value] of Object.entries(patch)) {
    const field = ENV_TO_FIELD[envKey];
    if (!field) continue;
    if (field === 'mock') config.mock = value === '1' || value === true;
    else if (NUMERIC.has(field)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) config[field] = n;
    } else config[field] = typeof value === 'string' ? value : String(value ?? '');
  }
  persist();
  return JSON.stringify(patch, null, 2);
}

export function reloadConfig() {
  Object.assign(config, DEFAULTS, read());
  return configStatus();
}

export function configStatus() {
  return {
    mock: config.mock,
    configured: Boolean(config.apiKey),
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    selectModel: config.selectModel || config.model,
  };
}

/** 只给「设置」界面用：把当前配置读出一份可编辑的副本。 */
export function currentSettings() {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    selectModel: config.selectModel,
    reasoningEffort: config.reasoningEffort,
    updateRepo: config.updateRepo,
  };
}

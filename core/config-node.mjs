/**
 * config.mjs —— 配置读取（.env + 环境变量 + 命令行开关）。
 * 刻意不依赖 dotenv：整个项目零 npm 依赖。
 *
 * 配置可以在运行时被「配置向导」改掉：writeEnvFile() 写盘 → reloadConfig() 重新读，
 * 因此用户粘完 API Key 不需要重启服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

export const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const ENV_PATH = path.join(ROOT, '.env');

/** 极简 .env 解析：KEY=VALUE，支持 # 注释与引号。 */
function parseEnvFile(file) {
  const map = new Map();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return map; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

/** force=false 时不覆盖真实环境变量（Docker / CI 传进来的优先）。 */
function loadEnvFile(file, force) {
  for (const [key, value] of parseEnvFile(file)) {
    if (force || !(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(ENV_PATH, false);

/** 命令行开关，跨平台（Windows 上没法写 LLM_MOCK=1 node ...）。 */
const flag = name => process.argv.includes('--' + name);
const option = name => {
  const hit = process.argv.find(arg => arg.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const portArg = option('port');

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** 默认值集中在 hasDefault 里，方便被 .env / 向导覆盖后重新计算。 */
export const config = {
  host: '127.0.0.1',
  port: 8787,
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  selectModel: '',
  provider: 'deepseek',
  reasoningEffort: '',
  maxOutputTokens: 32768,
  updateRepo: '',
  mock: false,
  open: false,
  maxRequestBytes: 24 * 1024 * 1024,
  maxBodyBytes: 40 * 1024 * 1024,
  requestTimeoutMs: 300000,
  concurrency: 2,
};

function applyEnv() {
  config.host = process.env.HOST || '127.0.0.1';
  config.port = num(portArg || process.env.PORT, 8787);
  config.baseUrl = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  config.apiKey = process.env.LLM_API_KEY || '';
  config.model = process.env.LLM_MODEL || 'deepseek-flash';
  config.selectModel = process.env.LLM_SELECT_MODEL || '';
  config.provider = process.env.LLM_PROVIDER || 'custom';
  config.reasoningEffort = process.env.LLM_REASONING_EFFORT || '';
  // 单次输出上限。DeepSeek 的 deepseek-flash 允许到 384K，但 gpt-4o 只有 16384，
  // 所以默认取 32768（够 DeepSeek 用），遇到更小硬上限的会由 chat() 自动降档重试。
  config.maxOutputTokens = num(process.env.LLM_MAX_OUTPUT_TOKENS, 32768);
  // 分享到 GitHub 之后填「用户名/仓库名」，网页上的「检查更新」才知道去哪问
  config.updateRepo = process.env.UPDATE_REPO || '';
  config.mock = flag('mock') || process.env.LLM_MOCK === '1';
  config.open = flag('open');
  config.maxRequestBytes = num(process.env.MAX_REQUEST_BYTES, 24 * 1024 * 1024);
  config.maxBodyBytes = num(process.env.MAX_BODY_BYTES, 40 * 1024 * 1024);
  config.requestTimeoutMs = num(process.env.REQUEST_TIMEOUT_MS, 300000);
  config.concurrency = num(process.env.CONCURRENCY, 2);
}
applyEnv();

/** 向导保存后调用：强制用 .env 覆盖 process.env，并重新算一遍 config。 */
export function reloadConfig() {
  loadEnvFile(ENV_PATH, true);
  applyEnv();
  return configStatus();
}

/** 把一组键值合并写回 .env（保留注释与其它设置），返回写入后的文本。 */
export function writeEnvFile(patch) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/); } catch { lines = []; }
  const pending = new Map(Object.entries(patch));
  const out = lines.map(line => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && pending.has(match[1])) {
      const value = pending.get(match[1]);
      pending.delete(match[1]);
      return match[1] + '=' + value;
    }
    return line;
  });
  if (pending.size) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    for (const [key, value] of pending) out.push(key + '=' + value);
  }
  fs.writeFileSync(ENV_PATH, out.join('\n'), 'utf8');
  return out.join('\n');
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

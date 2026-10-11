/**
 * config.mjs —— 配置的「门面」。
 *
 * 同一个文件要在两种环境里工作：
 *   Node   → 读写 .env 文件（config-node.mjs）
 *   浏览器 → 读写 localStorage（config-browser.mjs）
 *
 * 为什么要合成一个：server/llm.mjs、server/review.mjs 这些只 import './config.mjs'。
 * 把门面放在这里，它们搬进 public/core/ 之后就**一份代码两处可用**，
 * 不会出现「Node 和浏览器各一份、改一边忘一边」。
 *
 * ⚠️ 安全边界：浏览器分支只碰 localStorage，不落盘、不上传。
 */
const isNode = typeof window === 'undefined'
  && typeof process !== 'undefined'
  && Boolean(process.versions && process.versions.node);

const impl = isNode
  ? await import('./config-node.mjs?v=1791745425776')
  : await import('./config-browser.mjs?v=1791745425776');

export const platform = isNode ? 'node' : 'browser';
export const config = impl.config;
export const ROOT = impl.ROOT;
export const PUBLIC_DIR = impl.PUBLIC_DIR;
export const ENV_PATH = impl.ENV_PATH;
export const writeEnvFile = impl.writeEnvFile;
export const reloadConfig = impl.reloadConfig;
export const configStatus = impl.configStatus;

/**
 * bridge.mjs —— 一套前端代码，两种跑法。
 *
 *   本地版：前面有个 Node 服务，/api/* 是真接口
 *   链接版：没有任何服务端，所有活都在本页干
 *
 * 做法是**拦截 fetch**，而不是把 app.js 里十几处调用全改一遍 ——
 * 拦截的好处是 app.js 一行都不用动，两种模式共用同一个文件，
 * 从根上避免「改了本地版忘了链接版」。
 *
 * ⚠️ 安全边界：
 *   - API Key 只进 localStorage（config-browser.mjs）
 *   - 参考素材只进 IndexedDB（references.mjs）
 *   - 作品视频从头到尾没离开过浏览器（逐帧解码用的是 WebCodecs）
 *   - 没有「我们的服务器」，所以也没有任何地方能收集这些数据
 */
import { config, configStatus, ENV_PATH, reloadConfig, writeEnvFile } from './config.mjs';
import { PROVIDERS, publicProviders } from './providers.mjs';
import { testConnection, saveSetup, setupState } from './setup.mjs';
import { selectEvidence, runReview, FEEDBACK_COUNTS, EVIDENCE_FRAMES } from './review.mjs';
import { listReferences, saveReference, deleteReference, readReferenceBlob, MAX_REFERENCE_BYTES } from './references.mjs';

export let MODE = 'unknown';   // 'local' | 'static'

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

const readJson = init => {
  try { return init && init.body ? JSON.parse(init.body) : {}; } catch { return {}; }
};

/** 链接版的版本号来自 public/version.json（静态部署没有服务端可读 package.json）。 */
let versionCache = null;
async function staticVersion() {
  if (versionCache) return versionCache;
  try {
    const response = await fetch('./version.json', { cache: 'no-cache' });
    if (response.ok) {
      const data = await response.json();
      if (data && data.version) { versionCache = String(data.version); return versionCache; }
    }
  } catch { /* 取不到就退回一个诚实的占位 */ }
  versionCache = '链接版';
  return versionCache;
}

/** 链接版靠这个判断：浏览器直连模型服务行不行（Kimi 之类不返回 CORS 头的就不行）。 */
export async function detectMode() {
  try {
    const response = await fetch('/api/health', { method: 'GET' });
    if (response.ok) { MODE = 'local'; return MODE; }
  } catch { /* 没有服务端，走链接版 */ }
  MODE = 'static';
  return MODE;
}

/* ───────────── 链接版：本页把 /api/* 全部接管 ───────────── */

async function handleLocal(pathname, search, init) {
  const method = String(init?.method || 'GET').toUpperCase();

  if (pathname === '/api/health') {
    return json({
      ok: true, version: await staticVersion(), mode: 'static', ...configStatus(),
      limits: {
        feedbackLevels: Object.keys(FEEDBACK_COUNTS),
        feedbackCounts: FEEDBACK_COUNTS,
        evidenceFrames: EVIDENCE_FRAMES,
        maxRequestBytes: config.maxRequestBytes,
      },
      storage: ENV_PATH,
    });
  }

  if (pathname === '/api/setup' && method === 'GET') {
    return json({ ...setupState(), envPath: ENV_PATH, mode: 'static' });
  }
  if (pathname === '/api/setup/test' && method === 'POST') {
    return json(await testConnection(readJson(init)));
  }
  if (pathname === '/api/setup/save' && method === 'POST') {
    const saved = saveSetup(readJson(init));
    return json({ ...saved, envPath: ENV_PATH, mode: 'static' });
  }

  if (pathname === '/api/references' && method === 'GET') {
    return json({ references: await listReferences(), maxBytes: MAX_REFERENCE_BYTES, mode: 'static' });
  }
  if (pathname === '/api/references' && method === 'POST') {
    const name = new URLSearchParams(search).get('name');
    const blob = init.body instanceof Blob ? init.body : new Blob([init.body]);
    return json({ reference: await saveReference(name, blob) });
  }
  if (pathname === '/api/references' && method === 'DELETE') {
    return json({ removed: await deleteReference(new URLSearchParams(search).get('name')) });
  }

  if (pathname === '/api/select-evidence' && method === 'POST') {
    const body = readJson(init);
    const result = await selectEvidence({
      sheets: body.sheets || [],
      series: body.series || [],
      context: body.context || {},
      settings: body.settings || {},
      batchIndex: Number(body.batchIndex) || 0,
      batchCount: Number(body.batchCount) || 1,
    });
    return json({ frames: result.frames, note: result.note, usage: result.usage });
  }

  if (pathname === '/api/review' && method === 'POST') {
    const body = readJson(init);
    const result = await runReview({
      sheets: body.sheets || [],
      frames: body.frames || [],
      series: body.series || [],
      context: body.context || {},
      settings: body.settings || {},
      range: body.range || {},
      references: body.references || [],
    });
    return json({ report: result.report, usage: result.usage });
  }

  if (pathname === '/api/updates' && method === 'GET') {
    return json(await checkUpdateInBrowser());
  }

  return json({ error: '链接版没有这个接口：' + pathname }, 404);
}

/** 链接版的版本检查。GitHub 的 API 允许浏览器直接调用。 */
async function checkUpdateInBrowser() {
  const repo = String(config.updateRepo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { ok: false, reason: 'no-repo', message: '链接版没有内置更新源。在你自己的 fork 里改 package.json 的 version 即可。' };
  }
  try {
    const response = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return { ok: false, reason: 'http', message: 'GitHub 返回 ' + response.status };
    const data = await response.json();
    const latest = String(data.tag_name || data.name || '').replace(/^v/i, '');
    return { ok: true, repo, latest, version: latest, upToDate: true, pageUrl: data.html_url, message: '最新发布版本：' + latest };
  } catch (error) {
    return { ok: false, reason: 'network', message: '检查更新失败：' + (error?.message || error) };
  }
}

/**
 * 盯着版本号：作者那边一部署，已打开的页面就能知道「有新版本了」。
 *
 * 做法很朴素但可靠 —— version.json 每次部署都会刷新 build 时间戳，
 * 定期（以及页面重新获得焦点时）拿一份新的来比。不一样就提示刷新。
 * 不自动刷新：用户可能正在看报告，硬刷会把内容冲掉。
 */
export function watchForUpdates(onChange) {
  let current = null;
  const read = async () => {
    try {
      const response = await fetch('./version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) return null;
      const data = await response.json();
      return String(data.build || data.version || '');
    } catch { return null; }
  };
  read().then(value => { current = value; });
  const check = async () => {
    const value = await read();
    if (!value) return;
    if (current === null) { current = value; return; }
    if (value !== current) { current = value; onChange(); }
  };
  setInterval(check, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
}

/**
 * 给图标链接打上构建版本号。
 *
 * 为什么需要：GitHub Pages 给所有资源设了 cache-control: max-age=600（10 分钟），
 * 浏览器在这期间根本不会去问服务器。favicon 更顽固 —— 它存在独立的图标缓存里，
 * 普通刷新（F5）常常不管用。表现就是「代码部署了、页面上标没变」。
 *
 * 做法：拿 version.json 里的 build 时间戳当查询参数。参数一变，URL 就变了，
 * 浏览器就会重新去取。这样每次部署后图标都是自动最新的。
 */
export async function stampAssetVersions() {
  try {
    const response = await fetch('./version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    const build = data && data.build;
    if (!build) return null;
    for (const link of document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')) {
      const href = link.getAttribute('href') || '';
      // 只处理本地相对资源；内联 data: 的不用管，它随 HTML 一起更新
      if (!href.startsWith('./') || href.includes('?')) continue;
      link.setAttribute('href', href + '?v=' + build);
    }
    return build;
  } catch { return null; }
}

/** 拦截 fetch：把 /api/* 和 /reference/* 接到本页实现上。其余请求原样放行。 */
export function installStaticBackend() {
  if (window.__vfxBridgeInstalled) return;
  window.__vfxBridgeInstalled = true;
  const original = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : (input && input.url) || '';
    let parsed;
    try { parsed = new URL(raw, location.href); } catch { return original(input, init); }

    if (parsed.origin === location.origin && parsed.pathname.startsWith('/api/')) {
      try {
        return await handleLocal(parsed.pathname, parsed.search, init);
      } catch (error) {
        return json({ error: (error && error.message) || String(error) }, error?.status || 500);
      }
    }
    if (parsed.origin === location.origin && parsed.pathname.startsWith('/reference/')) {
      try {
        const blob = await readReferenceBlob(decodeURIComponent(parsed.pathname.slice('/reference/'.length)));
        return new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } });
      } catch (error) {
        return json({ error: (error && error.message) || String(error) }, error?.status || 404);
      }
    }
    return original(input, init);
  };
}

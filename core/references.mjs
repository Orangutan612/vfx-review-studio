/**
 * references.mjs（浏览器版）—— 参考库的 IndexedDB 实现。
 *
 * 和 Node 版同名同接口，所以 bridge 可以两边无差别调用。
 *
 * ⚠️ 安全边界（硬约束）：
 *   参考素材只存在**这个浏览器的 IndexedDB** 里。不落盘到任何服务器、不上传。
 *   唯一离开这台电脑的东西是评审时抽出来的那几张截图 —— 那是 AI 评审的物理前提，
 *   而且只发给用户自己选的模型服务。
 */
const DB_NAME = 'vfx-references-v1';
const STORE = 'files';

const VIDEO_EXT = /\.(mp4|mov|m4v)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const ALLOWED = /\.(mp4|mov|m4v|png|jpe?g|webp|gif)$/i;

export const MAX_IMAGES = 15;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_REFERENCE_BYTES = 100 * 1024 * 1024;

export const kindOf = name => (IMAGE_EXT.test(String(name || '')) ? 'image' : 'video');

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function safeName(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.includes('/') || raw.includes('\\')) throw fail('文件名不合法：不能带路径。');
  if (!ALLOWED.test(raw)) throw fail('参考库只支持 MP4 / MOV 视频，或 PNG / JPG / WebP / GIF 图片。');
  if (raw.length > 120) throw fail('文件名太长。');
  return raw;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打不开本机数据库。'));
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    let result;
    try { result = run(store); } catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    transaction.onerror = () => reject(transaction.error || new Error('本机数据库写入失败。'));
  });
}

export async function listReferences() {
  const db = await openDb();
  try {
    const all = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    return all.map(entry => ({
      name: entry.name,
      kind: kindOf(entry.name),
      size: entry.blob ? entry.blob.size : 0,
      modifiedAt: entry.modifiedAt || 0,
    })).sort((a, b) => a.name.localeCompare(b.name));
  } finally { db.close(); }
}

const MIME_BY_EXT = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

/**
 * 浏览器给的 blob.type 常常是空的（尤其是 .mov），
 * 一旦为空，后续 Content-Type 就变成 application/octet-stream，
 * 浏览器不会把它当视频播 —— 所以这里按扩展名补上。
 */
function withType(blob, name) {
  if (blob.type && blob.type !== 'application/octet-stream') return blob;
  const ext = String(name).split('.').pop().toLowerCase();
  const type = MIME_BY_EXT[ext];
  return type ? new Blob([blob], { type }) : blob;
}

export async function saveReference(name, bufferOrBlob) {
  const safe = safeName(name);
  const raw = bufferOrBlob instanceof Blob ? bufferOrBlob : new Blob([bufferOrBlob]);
  const blob = withType(raw, safe);
  if (!blob.size) throw fail('收到的文件是空的。');
  const kind = kindOf(safe);
  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_REFERENCE_BYTES;
  if (blob.size > limit) {
    throw fail('单个参考' + (kind === 'image' ? '图' : '视频') + '不能超过 ' + Math.round(limit / 1024 / 1024) + ' MB。');
  }
  const db = await openDb();
  try {
    if (kind === 'image') {
      const existing = (await listReferences()).filter(entry => entry.kind === 'image');
      const already = existing.some(entry => entry.name === safe);
      if (!already && existing.length >= MAX_IMAGES) throw fail('静态参考图最多 ' + MAX_IMAGES + ' 张，先删掉几张再加。');
    }
    await tx(db, 'readwrite', store => store.put({ name: safe, blob, modifiedAt: Date.now() }));
    return { name: safe, kind, size: blob.size };
  } finally { db.close(); }
}

export async function deleteReference(name) {
  const safe = safeName(name);
  const db = await openDb();
  try {
    await tx(db, 'readwrite', store => store.delete(safe));
    return { name: safe };
  } finally { db.close(); }
}

/** 浏览器新增：把文件取回来做预览 / 解码（Node 版是靠 /reference/ 路由发的）。 */
export async function readReferenceBlob(name) {
  const safe = safeName(name);
  const db = await openDb();
  try {
    const entry = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(safe);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!entry) throw Object.assign(new Error('参考库里没有这个文件。'), { status: 404 });
    return entry.blob;
  } finally { db.close(); }
}

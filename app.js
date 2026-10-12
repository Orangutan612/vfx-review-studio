/**
 * app.js —— 前端流程编排。
 *
 * 一次评审的四步（与界面上的步骤条一一对应）：
 *   1. 逐帧解码 → 接触表 + 全帧亮度序列（全在本地浏览器里做，视频不上传）
 *   2. 接触表分批交给模型「取证」，只让它挑出值得放大的时刻
 *   3. 把挑中的时刻按原分辨率抽帧，带上逐像素实算数值
 *   4. 全部证据交给模型终审，返回结构化报告并渲染
 */
import { inspectVideo, decodeSequence, oneContactBatch, scanRatios, dataUrlBitmap } from './frame-sequence.js?v=1791820834604';
import { referenceObjectURL } from './core/bridge.mjs?v=1791820834604';
import { renderReport, buildStandaloneHTML, reportToMarkdown } from './report-document.js?v=1791820834604';

const $ = id => document.getElementById(id);

// 链接版没有本地服务、没有 reference 文件夹、也没有启动窗口 ——
// 凡是提到这些的文案，都要按模式分开写，否则链接版会说一些根本不存在的事。
const LINK_MODE = document.documentElement.dataset.mode === 'static';
const byMode = (localText, linkText) => (LINK_MODE ? linkText : localText);
const video = $('video');

const LEVELS = [
  { value: 'low', label: '3 条', hint: '先看个大概' },
  { value: 'medium', label: '6 条', hint: '日常够用' },
  { value: 'high', label: '10 条', hint: '仔细过一遍' },
  { value: 'ultra', label: '15 条', hint: '尽量全面' },
];
const REASONING = [
  { value: 'fast', label: '快速', hint: '最快' },
  { value: 'standard', label: '标准', hint: '均衡' },
  { value: 'deep', label: '深入', hint: '最细也最慢' },
];
const STEP_NAMES = [
  '逐帧解码，制作连续接触表',
  '模型精读接触表，定位变化时刻',
  '抽取原尺寸关键帧',
  '生成修改建议与验证方法',
];

const state = {
  file: null, url: null, mediaDuration: 0, busy: false,
  sheets: [], series: [], sourceManifest: [], hdFrames: [], report: null,
  range: null, settings: { feedbackLevel: 'medium', reasoning: 'standard' },
  health: null, references: [], captured: [], recording: false,
};

/* ───────────────────────── 小工具 ───────────────────────── */

const timeLabel = t => Number(t).toFixed(2) + ' s';
const status = (text, isError = false) => {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
};
const setProgress = ratio => {
  $('progress-track').hidden = false;
  $('progress-fill').style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
};
const hideProgress = () => { $('progress-track').hidden = true; $('progress-fill').style.width = '0'; };

/** 二分找最近的源帧时间：模型读到的是 4 位小数的时间标签，必须吸附回真实帧时间。 */
function nearestSorted(sorted, value) {
  if (!sorted.length) return null;
  let lo = 0, hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] > value) hi = mid; else lo = mid;
  }
  return Math.abs(sorted[lo] - value) <= Math.abs(sorted[hi] - value) ? sorted[lo] : sorted[hi];
}

function snapTimes(times, manifest) {
  const sorted = manifest.map(entry => entry.time).sort((a, b) => a - b);
  const snapped = [];
  for (const time of times) {
    const near = nearestSorted(sorted, time);
    if (near === null) continue;
    if (snapped.every(existing => Math.abs(existing - near) > 0.000001)) snapped.push(near);
  }
  return snapped.sort((a, b) => a - b);
}

function evenSample(list, max) {
  if (list.length <= max) return list;
  const out = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round(i * (list.length - 1) / (max - 1))]);
  return [...new Set(out)];
}

function download(text, filename, type = 'text/html;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || ('服务端返回 ' + response.status));
  return data;
}

/* ───────────────────────── 步骤条 ───────────────────────── */

function renderSteps(activeIndex, failedIndex = -1, doneCount = 0) {
  $('task-panel').hidden = false;
  const list = $('task-steps');
  list.replaceChildren();
  STEP_NAMES.forEach((name, index) => {
    const item = document.createElement('li');
    item.textContent = name;
    if (index === failedIndex) item.className = 'failed';
    else if (index < doneCount) item.className = 'done';
    else if (index === activeIndex) item.className = 'active';
    list.appendChild(item);
  });
}

/* ───────────────────────── 选择作品 ───────────────────────── */

/** 等浏览器报出时长 —— 它才是"你看到的那个时长"。
    容器里的 track.duration/timescale 在 movie 与 media 两个 timescale 不一致时会差几十倍
    （不同软件导出的片子经常不一致），那正是"换个视频就报超过 2 分钟"的根因。读不到就返回 NaN，交给调用方回退。 */
function waitDuration(el, timeout = 8000) {
  return new Promise(resolve => {
    if (Number.isFinite(el.duration) && el.duration > 0) return resolve(el.duration);
    let done = false;
    const finish = value => { if (done) return; done = true; el.removeEventListener('loadedmetadata', onMeta); el.removeEventListener('durationchange', onMeta); resolve(value); };
    const onMeta = () => { if (Number.isFinite(el.duration) && el.duration > 0) finish(el.duration); };
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    setTimeout(() => finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : NaN), timeout);
  });
}

async function loadFile(file) {
  if (!file || state.busy) return;
  if (file.size > 100 * 1024 * 1024 || !/\.(mp4|mov)$/i.test(file.name)) {
    status('请选择不超过 100 MB 的 MP4 或 MOV 文件。', true);
    return;
  }
  setBusy(true);
  status('正在读取视频…');
  try {
    const meta = await inspectVideo(file);
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = URL.createObjectURL(file);
    video.src = state.url;
    video.load();
    // 时长以浏览器为准；容器值只作兜底（读不到才用）
    const browserDuration = await waitDuration(video);
    const duration = Number.isFinite(browserDuration) && browserDuration > 0 ? browserDuration : meta.duration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 120) {
      throw new Error('支持最长 2 分钟的视频，请先裁短再试。');
    }
    state.file = file;
    state.mediaDuration = duration;
    state.report = null;
    state.sheets = []; state.series = []; state.hdFrames = [];
    $('results').hidden = true;
    $('task-panel').hidden = true;
    hideProgress();

    $('dropzone').hidden = true;
    $('video-wrap').hidden = false;
    $('replace').hidden = false;
    $('remove-video').hidden = false;
    $('range-panel').hidden = false;
    $('file-name').textContent = file.name;
    $('file-name').title = file.name;
    $('file-meta').textContent = meta.width + ' × ' + meta.height + ' · ' + timeLabel(duration)
      + ' · ' + meta.total + ' 帧 · ' + (file.size / 1024 / 1024).toFixed(1) + ' MB';

    resetRange();
    status(duration > 15
      ? '视频已就绪。选一段连续画面（选区越短越快越省，选区框下面会实时标出预计页数和档位），填好右侧需求再开始评审。'
      : '视频已就绪。填好右侧需求，就可以开始评审。');
  } catch (error) {
    video.removeAttribute('src');
    status(error.message, true);
  } finally {
    setBusy(false);
    updateButtons();
  }
}

/* ───────────────────────── 选区 ───────────────────────── */

/* 选区不设人为上限：能选多长由视频本身决定（上传上限 2 分钟）。
   代价交给界面实时算 —— 选区越长，接触表页数越多，模型要读的图越多，耗时和费用越高。 */
import { estimateWork, MIN_CLIP_SECONDS } from './core/clip-cost.mjs?v=1791820834604';

const videoDuration = () => state.mediaDuration || video.duration || 0;
const selectedRange = () => ({ start: Number($('range-start').value), end: Number($('range-end').value) });

function validRange() {
  const { start, end } = selectedRange();
  return $('range-start').value.trim() !== '' && $('range-end').value.trim() !== ''
    && Number.isFinite(start) && Number.isFinite(end)
    && start >= 0 && end <= videoDuration() + 0.001
    && end - start >= MIN_CLIP_SECONDS && end - start <= videoDuration() + 0.001;
}

function showRange() {
  const { start, end } = selectedRange();
  const span = end - start;
  const summary = $('range-summary');
  const chip = $('range-cost');
  if (validRange()) {
    // 让用户看见代价：档位标签 + 一句话（多少帧 / 多少页接触表）—— 自己权衡选多长
    const est = estimateWork(span);
    summary.textContent = '只评审 ' + timeLabel(start) + ' — ' + timeLabel(end) + '，共 ' + timeLabel(span)
      + ' · 约 ' + est.frames + ' 帧 / ' + est.sheets + ' 页接触表。';
    if (chip) {
      chip.hidden = false;
      chip.dataset.tier = est.tier.name;
      chip.textContent = est.tier.name + ' · ' + est.sheets + ' 页';
      chip.title = est.tier.note + '（约 ' + est.frames + ' 帧接触表）';
    }
  } else if (chip) { chip.hidden = true; }
  if (!validRange() && span > videoDuration() + 0.001) {
    summary.textContent = '选区超出了视频长度（共 ' + timeLabel(videoDuration()) + '），请缩短。';
  } else {
    summary.textContent = '请选一段 ' + MIN_CLIP_SECONDS + ' 秒以上的连续画面，起点要早于终点，且不能超出视频长度。';
  }
  summary.classList.toggle('error', !validRange());
  updateButtons();
}

function resetRange() {
  const end = Math.floor(videoDuration() * 1000) / 1000;
  for (const [edge, value] of [['start', 0], ['end', end]]) {
    const number = $('range-' + edge);
    const slider = $('range-' + edge + '-slider');
    number.max = String(end);
    slider.max = String(end);
    number.value = String(value);
    slider.value = String(value);
  }
  showRange();
}

function changeRange(edge, value) {
  if (state.busy || !state.file) return;
  const clamped = Math.max(0, Math.min(Number(value) || 0, videoDuration()));
  $('range-' + edge).value = String(clamped);
  $('range-' + edge + '-slider').value = String(clamped);
  video.pause();
  showRange();
}

/* ───────────────────────── 设置面板 ───────────────────────── */

function renderOptionGroup(containerId, options, current, onPick) {
  const container = $(containerId);
  container.replaceChildren();
  options.forEach(option => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-pressed', String(option.value === current));
    button.innerHTML = option.label + (option.hint ? '<small>' + option.hint + '</small>' : '');
    button.addEventListener('click', () => onPick(option.value));
    container.appendChild(button);
  });
}

function updateButtons() {
  $('analyze').disabled = state.busy || !state.file || !validRange() || !$('consent').checked;
  $('analyze').textContent = state.busy ? '正在评审…' : '开始评审';
  $('dropzone').disabled = state.busy;
  $('replace').disabled = state.busy;
  for (const id of ['purpose', 'style', 'camera', 'description', 'concern', 'range-start', 'range-end', 'range-start-slider', 'range-end-slider', 'range-reset', 'range-use-start', 'range-use-end', 'consent']) {
    $(id).disabled = state.busy;
  }
}

function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle('busy', value);
  updateButtons();
}

/* ───────────────────────── 评审主流程 ───────────────────────── */

async function selectTimes(batches, context, settings) {
  const cap = state.health?.limits?.evidenceFrames?.[settings.feedbackLevel] ?? 10;
  const picked = [];
  const errors = [];
  for (let index = 0; index < batches.length; index++) {
    try {
      const data = await post('/api/select-evidence', {
        sheets: batches[index],
        series: state.series,
        context,
        settings,
        batchIndex: index,
        batchCount: batches.length,
      });
      for (const frame of data.frames || []) picked.push(Number(frame.time));
    } catch (error) {
      errors.push('第 ' + (index + 1) + ' 批：' + error.message);
    }
    setProgress((index + 1) / batches.length);
    status('模型精读接触表 ' + (index + 1) + ' / ' + batches.length + ' 批……');
  }
  if (!picked.length) throw new Error('取证阶段没有挑出任何时刻。' + (errors[0] || ''));
  const merged = [];
  for (const time of picked.filter(Number.isFinite).sort((a, b) => a - b)) {
    if (merged.every(existing => Math.abs(existing - time) > 0.05)) merged.push(time);
  }
  return evenSample(merged, cap);
}

async function reencode(frame, quality, longEdge) {
  const bitmap = await createImageBitmap(await (await fetch(frame.image)).blob());
  try {
    const scale = longEdge ? Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height)) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { ...frame, image: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

/** 出站请求过大时按「先压接触表 → 再减页 → 最后降采样关键帧」的顺序退让。 */
async function fitBudget(sheets, frames, budget) {
  const size = list => new Blob([JSON.stringify(list)]).size;
  let currentSheets = sheets;
  let currentFrames = frames;
  const total = () => size(currentSheets) + size(currentFrames);
  if (!budget || total() <= budget) return { sheets: currentSheets, frames: currentFrames, note: '' };

  for (const quality of [0.62, 0.45, 0.3]) {
    currentSheets = await Promise.all(sheets.map(sheet => reencode(sheet, quality)));
    if (total() <= budget) return { sheets: currentSheets, frames: currentFrames, note: '接触表已压到 q' + Math.round(quality * 100) + ' 以适配请求体积。' };
  }
  currentSheets = currentSheets.filter((_, index) => index % 2 === 0);
  if (total() <= budget) return { sheets: currentSheets, frames: currentFrames, note: '只发送一半接触表页以适配请求体积。' };

  for (const longEdge of [1600, 1280, 1080]) {
    currentFrames = await Promise.all(frames.map(frame => reencode(frame, 0.72, longEdge)));
    if (total() <= budget) return { sheets: currentSheets, frames: currentFrames, note: '关键帧已降采样到长边 ' + longEdge + ' 以适配请求体积。' };
  }
  return { sheets: currentSheets, frames: currentFrames, note: '证据仍然超过请求体积预算，这一步可能失败。' };
}

async function analyze() {
  if (state.busy || !state.file || !validRange()) return;
  if (state.health && !state.health.configured && !state.health.mock) {
    status('还没有配置 AI 模型，请先点右上角「配置模型」粘贴一个 API Key。', true);
    openSetup();
    return;
  }
  if (!$('consent').checked) { status('请先勾选同意把截图发送给模型服务。', true); return; }

  setBusy(true);
  $('results').hidden = true;
  $('result-note').textContent = '';
  const range = selectedRange();
  const settings = { feedbackLevel: state.settings.feedbackLevel, reasoning: state.settings.reasoning };
  const context = {
    purpose: $('purpose').value,
    style: $('style').value,
    camera: $('camera').value,
    description: $('description').value,
    concern: $('concern').value,
  };
  const file = state.file;
  let step = 0;

  try {
    /* 1) 逐帧解码 → 接触表 + 序列 */
    step = 0;
    renderSteps(0, -1, 0);
    status('正在逐帧解码……');
    showRange();
    const decoded = await decodeSequence(file, range, (done, total) => {
      setProgress(done / total);
      status('正在逐帧解码并制作接触表 ' + done + ' / ' + total + ' 帧……');
    }, { mode: 'sheets', series: true });

    const manifest = decoded.sourceManifest;
    state.sourceManifest = manifest;
    state.series = decoded.series;
    state.sheets = decoded.frames.map(unit => {
      const first = manifest[unit.sourceFrames[0]];
      const last = manifest[unit.sourceFrames[unit.sourceFrames.length - 1]];
      return { ...unit, start: first.time, end: last.time + last.duration };
    });
    renderSteps(1, -1, 1);
    status('已解码 ' + manifest.length + ' 帧，生成 ' + state.sheets.length + ' 页接触表和 ' + state.series.length + ' 个逐帧数值。');

    if (!state.sheets.length) throw new Error('没有生成任何接触表，请缩短选区后重试。');

    /* 2) 取证 */
    step = 1;
    setProgress(0);
    const batches = await oneContactBatch(state.sheets);
    const times = await selectTimes(batches, context, settings);
    const snapped = snapTimes(times, manifest);
    if (!snapped.length) throw new Error('模型挑出的时刻没有对上任何源帧，请重试。');
    renderSteps(2, -1, 2);
    status('已定位 ' + snapped.length + ' 个值得放大细看的时刻。');

    /* 3) 原尺寸关键帧 */
    step = 2;
    setProgress(0);
    status('正在抽取原尺寸关键帧……');
    const extracted = await decodeSequence(file, range, (done, total) => {
      setProgress(done / total);
      status('正在抽取原尺寸关键帧 ' + done + ' / ' + total + ' 帧……');
    }, { mode: 'frames', times: snapped });
    const frames = extracted.frames.filter(Boolean);
    if (frames.length < 2) throw new Error('可用的原尺寸关键帧少于 2 张，请缩短选区后重试。');
    state.hdFrames = frames;
    renderSteps(3, -1, 3);
    status('已抽取 ' + frames.length + ' 张原尺寸关键帧。');

    /* 4) 终审 */
    step = 3;
    setProgress(0);
    const budget = state.health?.limits?.maxRequestBytes || 24 * 1024 * 1024;
    const fitted = await fitBudget(state.sheets, frames, budget);
    if (fitted.note) status('正在整理证据……' + fitted.note);
    const references = await fillSamplesFromSheets(await loadSelectedReferences());
    state.references = references;
    const result = await post('/api/review', {
      sheets: fitted.sheets,
      frames: fitted.frames,
      series: state.series,
      context,
      settings,
      range,
      references,
    });
    state.report = result.report;
    state.range = range;
    state.hdFrames = fitted.frames;
    state.sheets = fitted.sheets;

    renderSteps(-1, -1, 4);
    hideProgress();
    status('评审完成。');
    renderResults(fitted.note);
  } catch (error) {
    renderSteps(-1, step, step);
    hideProgress();
    status(error.message, true);
    console.error(error);
  } finally {
    setBusy(false);
  }
}

/* ───────────────────────── 渲染结果 ───────────────────────── */

function currentMeta() {
  return {
    file: state.file?.name,
    range: state.range,
    style: $('style').value,
    model: state.health?.model,
    createdAt: Date.now(),
  };
}

function renderResults(note = '') {
  const meta = currentMeta();
  $('report').innerHTML = renderReport(state.report, state.hdFrames, {
    interactive: true,
    series: state.series,
    meta,
    references: state.references,
  });
  $('results').hidden = false;
  $('result-note').textContent = note;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function reportFilename(extension) {
  const base = (state.file?.name || 'vfx').replace(/\.[^.]+$/, '');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return base + '-评审报告-' + stamp + '.' + extension;
}

/* ───────────────────────── 事件绑定 ───────────────────────── */

$('dropzone').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) loadFile(file);
  event.target.value = '';
});
$('replace').addEventListener('click', () => $('file').click());

/** 移除已选作品：把状态和界面都退回"还没选"的样子。 */
function removeVideo() {
  if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
  state.file = null;
  state.mediaDuration = 0;
  state.report = null;
  video.removeAttribute('src');
  video.load();
  $('file').value = '';
  $('video-wrap').hidden = true;
  $('range-panel').hidden = true;
  $('replace').hidden = true;
  $('remove-video').hidden = true;
  $('dropzone').hidden = false;
  $('file-name').textContent = '还没有选择作品';
  $('file-meta').textContent = '等待选择';
  $('results').hidden = true;
  $('task-panel').hidden = true;
  hideProgress();
  status('已移除作品。重新拖入或点选一个视频即可。');
  updateButtons();
}
$('remove-video').addEventListener('click', removeVideo);

const dropzone = $('dropzone');
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('dragover'); });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('dragover'));
}
dropzone.addEventListener('drop', event => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

$('range-reset').addEventListener('click', () => { if (!state.busy) resetRange(); });
$('range-start').addEventListener('input', event => changeRange('start', event.target.value));
$('range-end').addEventListener('input', event => changeRange('end', event.target.value));
$('range-start-slider').addEventListener('input', event => changeRange('start', event.target.value));
$('range-end-slider').addEventListener('input', event => changeRange('end', event.target.value));
$('range-use-start').addEventListener('click', () => changeRange('start', video.currentTime));
$('range-use-end').addEventListener('click', () => changeRange('end', video.currentTime));

video.addEventListener('loadedmetadata', () => showRange());

$('consent').addEventListener('change', () => {
  try { localStorage.setItem('vfx-consent', $('consent').checked ? '1' : '0'); } catch {}
  updateButtons();
});
$('analyze').addEventListener('click', analyze);

// 报告里的时间链接：点一下就把视频跳到那一刻。
$('report').addEventListener('click', event => {
  const button = event.target.closest('.time-link');
  if (!button) return;
  const time = Number(button.dataset.time);
  if (!Number.isFinite(time) || !state.file) return;
  video.currentTime = time;
  video.play().catch(() => {});
  video.classList.add('flash');
  setTimeout(() => video.classList.remove('flash'), 900);
  video.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('export-html').addEventListener('click', () => {
  if (!state.report) return;
  download(buildStandaloneHTML({
    report: state.report,
    frames: state.hdFrames,
    series: state.series,
    meta: currentMeta(),
  }), reportFilename('html'));
});

$('export-md').addEventListener('click', async () => {
  if (!state.report) return;
  const text = reportToMarkdown(state.report, currentMeta());
  try {
    await navigator.clipboard.writeText(text);
    $('result-note').textContent = '建议已复制到剪贴板（Markdown）。';
  } catch {
    download(text, reportFilename('md'), 'text/markdown;charset=utf-8');
    $('result-note').textContent = '剪贴板不可用，已改为下载 .md 文件。';
  }
});

$('print').addEventListener('click', () => window.print());

/* ───────────────────────── 启动 ───────────────────────── */

async function checkHealth() {
  const el = $('health');
  let data;
  try {
    data = await (await fetch('/api/health')).json();
  } catch {
    el.className = 'health bad';
    el.textContent = '连不上本地服务';
    showSetupBanner(
    byMode('连不上本地服务', '页面没能正常启动'),
    byMode('请确认那个黑色启动窗口还开着。如果已经关掉了，重新双击「启动.cmd」即可。', '刷新一下页面试试。如果还是这样，清空本站数据后重新打开。'),
    false,
  );
    return;
  }
  state.health = data;
  if (data.version) $('version-badge').textContent = 'v' + data.version;
  if (data.mock) {
    el.className = 'health mock';
    el.textContent = '离线演示模式';
    showSetupBanner('当前是离线演示模式', '流程和真实评审完全一样，但报告内容是示例、不会真的调用模型。想用真正的 AI 评审，点右边配置一个 API Key。', true);
  } else if (!data.configured) {
    el.className = 'health bad';
    el.textContent = '还没配置模型';
    showSetupBanner('还差一步就能用了', '需要配置一个能读图的 AI 模型。点右边的按钮，选一家服务商、粘贴 API Key 就行 —— 不用编辑任何文件。', true);
  } else {
    el.className = 'health ok';
    el.textContent = '已配置 · ' + data.model;
    // 这条现在真的生效了（见 style.css 里 [hidden] 的 !important 兜底）
    $('setup-banner').hidden = true;
    $('setup-banner').setAttribute('aria-hidden', 'true');
  }
}

function showSetupBanner(title, body, showButton) {
  $('setup-banner-title').textContent = title;
  $('setup-banner-body').textContent = body;
  $('setup-banner-open').hidden = !showButton;
  $('setup-banner').hidden = false;
}

/* ───────────────────────── 参考库 ───────────────────────── */

const MAX_REFERENCES = 3;
const MAX_IMAGE_REFERENCES = 15;
let referenceFiles = [];

async function loadReferences() {
  try {
    referenceFiles = (await (await fetch('/api/references')).json()).references || [];
  } catch { referenceFiles = []; }
  renderReferences();
}

function renderReferences() {
  const list = $('reference-list');
  list.replaceChildren();
  if (!referenceFiles.length) {
    const empty = document.createElement('p');
    empty.className = 'help';
    empty.textContent = byMode(
    '参考库还是空的。可以拖文件进来，或者直接把文件丢进项目的 reference 文件夹。',
    '参考库还是空的。点右上角「＋ 本地上传」从电脑里选文件（视频或图片都行）。',
  );
    list.appendChild(empty);
    return;
  }
  for (const item of referenceFiles) {
    const row = document.createElement('div');
    row.className = 'reference-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = item.name;
    box.addEventListener('change', () => {
      const checked = [...list.querySelectorAll('input:checked')]
        .map(input => referenceFiles.find(entry => entry.name === input.value))
        .filter(Boolean);
      const videos = checked.filter(entry => entry.kind !== 'image').length;
      const images = checked.filter(entry => entry.kind === 'image').length;
      if (videos > MAX_REFERENCES) {
        box.checked = false;
        status('最多同时对比 ' + MAX_REFERENCES + ' 个参考视频。', true);
      } else if (images > MAX_IMAGE_REFERENCES) {
        box.checked = false;
        status('最多同时使用 ' + MAX_IMAGE_REFERENCES + ' 张静态参考图。', true);
      }
    });

    const name = document.createElement('span');
    name.className = 'reference-name';
    name.textContent = item.name;
    name.title = item.name;

    const size = document.createElement('span');
    size.className = 'reference-size';
    size.className = 'reference-kind ' + (item.kind === 'image' ? 'is-image' : 'is-video');
    size.textContent = (item.kind === 'image' ? '图片 · ' : '视频 · ') + (item.size / 1024 / 1024).toFixed(1) + ' MB';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-action danger';
    remove.textContent = '删除';
    remove.addEventListener('click', async () => {
      if (state.busy) return;
      await fetch('/api/references?name=' + encodeURIComponent(item.name), { method: 'DELETE' });
      await loadReferences();
      status('已从参考库移除 ' + item.name + '。');
    });

    const look = document.createElement('button');
    look.type = 'button';
    look.className = 'row-action';
    look.textContent = '预览';
    look.title = '点开确认添加对没有';
    look.setAttribute('aria-label', '预览 ' + item.name);
    look.addEventListener('click', () => previewReference({ kind: item.kind, name: item.name }));

      if (item.kind !== 'image') {
        const wrap = document.createElement('span');
        wrap.className = 'reference-range';
        const saved = refRangeFor(item.name, NaN);
        const mk = (cls, value) => {
          const input = document.createElement('input');
          input.type = 'number'; input.min = '0'; input.step = '0.5'; input.className = cls;
          input.value = String(value);
          return input;
        };
        const from = mk('ref-range-start', saved.start);
        const to = mk('ref-range-end', saved.end);
        const tip = document.createElement('span');
        tip.className = 'reference-range-tip';
        tip.textContent = '–';
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'row-action';
        useBtn.textContent = '用这一段';
        useBtn.title = '下次评审按这个区间解码这段参考（超过片长会自动截到片尾）';
        useBtn.addEventListener('click', () => {
          const start = Number(from.value) || 0;
          const end = Number(to.value) || 0;
          if (!(end - start > 0.1)) { status('参考区间里，终点要比起码点大 0.1 秒。', true); return; }
          saveRefRange(item.name, start, end);
          status('参考「' + item.name + '」本次取 ' + start.toFixed(1) + '–' + end.toFixed(1) + ' 秒（下次评审生效）。');
        });
        const readBtn = document.createElement('button');
        readBtn.type = 'button';
        readBtn.className = 'row-action';
        readBtn.textContent = '读取这一段';
        readBtn.title = '马上按这个区间解码一次，先看看抽出来的是不是你要的那一下';
        readBtn.addEventListener('click', async () => {
          if (state.busy) return;
          const start = Number(from.value) || 0;
          const end = Number(to.value) || 0;
          if (!(end - start > 0.1)) { status('参考区间里，终点要比起码点大 0.1 秒。', true); return; }
          saveRefRange(item.name, start, end);
          setBusy(true);
          status('正在读取参考「' + item.name + '」的 ' + start.toFixed(1) + '–' + end.toFixed(1) + ' 秒……');
          try {
            const blob = await (await fetch('/reference/' + encodeURIComponent(item.name))).blob();
            const file = new File([blob], item.name, { type: blob.type || 'video/mp4' });
            const meta = await inspectVideo(file);
            const range = refRangeFor(item.name, meta.duration);
            const decoded = await decodeSequence(file, range, () => {}, {
              mode: 'sheets', series: true, emitSamples: true,
              sampleEverySeconds: Math.max(1, (range.end - range.start) / 12), sampleLimit: 12,
            });
            previewReference({ kind: 'video', name: item.name, sheets: pickSheets(decoded.sheets || []),
              note: '这是你选的 ' + range.start.toFixed(1) + '–' + range.end.toFixed(1) + ' 秒（每格 1/30 秒）。' });
            status('已按 ' + range.start.toFixed(1) + '–' + range.end.toFixed(1) + ' 秒读出参考「' + item.name + '」。');
          } catch (error) {
            status('读取参考失败：' + (error && error.message ? error.message : error), true);
          } finally { setBusy(false); }
        });
        wrap.append(from, tip, to, useBtn, readBtn);
        row.append(wrap);
      }
    row.append(box, name, size, look, remove);
    list.appendChild(row);
  }
}

/**
 * 录屏捕获：把「正在播的视频」直接变成参考。
 *
 * 为什么需要它：很多站点的视频地址是 JS 动态生成或带访问控制的，拿不到文件。
 * 但「录自己的屏幕」不需要拿到文件 —— 而且对任何网站都有效。
 *
 * 实现上刻意不落盘成视频文件：录下来再解码要多绕一大圈（还要面对 webm 编解码），
 * 直接按 1/30 秒采样、现场拼接触表 + 算运动强度，产出的东西和 decodeSequence 完全同构。
 */
const REFERENCE_MAX_SECONDS = 120;   // 参考片段最长 2 分钟（和作品一致；以前卡 30 秒，长镜头只能看个开头）
const REFERENCE_MAX_SHEETS = 8;

/* ── 参考片段的取用区间 ──
   为什么按名字存本机：参考视频解一次要几秒到几十秒，用户往往只想参考其中一段（比如大招那一下）。
   存起来之后，改区间不需要重新上传，下次评审按新区间解码。 */
const refRangeKey = name => 'vfx-ref-range:' + name;
function refRangeFor(name, duration) {
  const known = Number.isFinite(duration) && duration > 0;
  const fallbackEnd = known ? Math.min(REFERENCE_MAX_SECONDS, duration) : REFERENCE_MAX_SECONDS;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(refRangeKey(name)) || 'null'); } catch { saved = null; }
  let start = saved && Number.isFinite(saved.start) ? Math.max(0, saved.start) : 0;
  let end = saved && Number.isFinite(saved.end) ? saved.end : fallbackEnd;
  if (known) { start = Math.min(start, duration); end = Math.min(end, duration); }
  if (!(end - start > 0.1)) return { start: 0, end: fallbackEnd };   // 存坏了就退回默认
  return { start, end };
}
function saveRefRange(name, start, end) {
  try { localStorage.setItem(refRangeKey(name), JSON.stringify({ start: Math.max(0, start), end: Math.max(0, end) })); } catch {}
}

function pickSheets(list, max = REFERENCE_MAX_SHEETS) {
  if (!Array.isArray(list) || list.length <= max) return list || [];
  const picked = [];
  for (let i = 0; i < max; i++) picked.push(list[Math.round(i * (list.length - 1) / (max - 1))]);
  return [...new Set(picked)];
}

/* ─────────────── 悬浮窗（Document Picture-in-Picture）─────────────── */

let pipWindow = null;

const pipSupported = () => typeof window.documentPictureInPicture?.requestWindow === 'function';

/**
 * 把录制面板弹成一个**始终浮在最前面的独立小窗口**。
 *
 * 为什么需要它：面板原本画在我们这个标签页里，你一去看参考页面，它就被盖住了 ——
 * 这是网页的硬限制，一个页面没法在别的标签页上作画。
 * Document Picture-in-Picture 给的是一个独立窗口，能浮在所有内容之上，这样才谈得上
 * 「切到参考页面，看着它，随时点停止」。
 */
async function popRecorderOut(root) {
  if (pipWindow || !pipSupported()) return null;
  try {
    const pip = await window.documentPictureInPicture.requestWindow({ width: 330, height: 210 });
    // 把样式整体搬过去，否则小窗口里是一片裸文字。
    // 深色模式判断挂在 documentElement 上，得单独同步一次。
    pip.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
    const style = pip.document.createElement('style');
    style.textContent = [...document.styleSheets].map(sheet => {
      try { return [...sheet.cssRules].map(rule => rule.cssText).join(''); } catch { return ''; }
    }).join('');
    pip.document.head.appendChild(style);
    const extra = pip.document.createElement('style');
    extra.textContent = '.recorder{position:static !important;right:auto;bottom:auto;width:auto;box-shadow:none;border:none}'
      + 'body{margin:0;overflow:hidden}';
    pip.document.head.appendChild(extra);

    pip.document.body.appendChild(root);
    root.classList.add('recorder-floating');
    // 用户直接关掉小窗口时，把面板搬回来继续用
    pip.addEventListener('pagehide', () => {
      pipWindow = null;
      root.classList.remove('recorder-floating');
      document.body.appendChild(root);
      const pop = root.querySelector('#recorder-pop');
      if (pop) pop.hidden = false;
    });
    pipWindow = pip;
    return pip;
  } catch { return null; }
}

/* ─────────────── 面板可拖动 ─────────────── */

function makeDraggable(panel, handle) {
  try {
    const saved = JSON.parse(localStorage.getItem('vfx-recorder-pos') || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      panel.style.left = Math.max(4, Math.min(window.innerWidth - 140, saved.x)) + 'px';
      panel.style.top = Math.max(4, Math.min(window.innerHeight - 60, saved.y)) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  } catch {}

  let dragging = false, startX = 0, startY = 0, originX = 0, originY = 0;
  handle.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    originX = rect.left;
    originY = rect.top;
    startX = event.clientX;
    startY = event.clientY;
    dragging = true;
    panel.style.left = originX + 'px';
    panel.style.top = originY + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    try { handle.setPointerCapture(event.pointerId); } catch {}
  });
  handle.addEventListener('pointermove', event => {
    if (!dragging) return;
    const x = Math.max(4, Math.min(window.innerWidth - 90, originX + event.clientX - startX));
    const y = Math.max(4, Math.min(window.innerHeight - 40, originY + event.clientY - startY));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });
  const finish = event => {
    if (!dragging) return;
    dragging = false;
    try { localStorage.setItem('vfx-recorder-pos', JSON.stringify({ x: panel.offsetLeft, y: panel.offsetTop })); } catch {}
    try { handle.releasePointerCapture(event.pointerId); } catch {}
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
}

/* ─────────────── 录屏捕获 ─────────────── */

/** 把 Blob 缩放成一张 data URL（静态参考图用，控制体积）。 */
async function shrinkImage(blob, longEdge = 960, quality = 0.82) {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally { bitmap.close(); }
}

/**
 * 把「正在播的视频」直接变成参考。
 *
 * 两个关键决定：
 *  ① 不落盘成视频文件。录下来再解码要多绕一圈（还要面对 webm 编解码），
 *     直接按 1/30 秒采样、现场拼接触表 + 算运动强度，产出和 decodeSequence 同构。
 *  ② 用 MediaStreamTrackProcessor 拿帧，不用 requestAnimationFrame。
 *     用户录制时一定会切到参考页面去看，我们这边就进了后台；
 *     而 rAF 在后台标签页会被浏览器节流甚至完全暂停，录出来会是一片死帧。
 *     MediaStreamTrackProcessor 由媒体管线驱动，后台照常供帧。
 */
async function captureReference() {
  if (state.busy || state.recording) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    status('这个浏览器不支持录屏捕获，请用 Chrome 或 Edge。', true);
    return;
  }
  const MAX_MS = REFERENCE_MAX_SECONDS * 1000;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  } catch { status('已取消录屏。'); return; }

  // 面板里的元素要先抓住引用：一旦搬进悬浮窗，$() 就在本文档里找不到了
  const ui = {
    root: $('recorder'),
    time: $('recorder-time'),
    fill: $('recorder-fill'),
    frames: $('recorder-frames'),
    hint: $('recorder-hint'),
    pause: $('recorder-pause'),
    stop: $('recorder-stop'),
    cancel: $('recorder-cancel'),
    start: $('recorder-start'),
    pop: $('recorder-pop'),
  };

  const track = stream.getVideoTracks()[0];
  const settings = (typeof track.getSettings === 'function' ? track.getSettings() : {}) || {};
  const width = settings.width || 1280;
  const height = settings.height || 720;
  const cellWidth = Math.max(1, Math.round(width * Math.min(1, 400 / width)));
  const cellHeight = Math.max(1, Math.round(height * cellWidth / width));

  const cell = document.createElement('canvas');
  cell.width = cellWidth;
  cell.height = cellHeight;
  const cellContext = cell.getContext('2d', { willReadFrequently: true });
  const sheet = document.createElement('canvas');
  sheet.width = cellWidth * 4;
  sheet.height = (cellHeight + 24) * 6;
  const sheetContext = sheet.getContext('2d');

  const series = [];
  const sheets = [];
  // 样片：报告里并排对照右侧要用的干净单帧。
  // ⚠️ 之前录屏这条路径压根没产出样片，所以对照块永远渲染不出来 ——
  //    用户看到的「对照组」其实只剩左边作者自己那一张，右边是空的。
  const samples = [];
  const sampleCanvas = document.createElement('canvas');
  const SAMPLE_LONG_EDGE = 720;
  let nextSampleMs = 0;
  let sourceFrames = [];
  let pageStart = 0, pageEnd = 0;
  let frameIndex = 0, lastBucket = -1, previousLuma = null;
  let activeMs = 0, lastNow = performance.now();
  let paused = false, cancelled = false, autoStopped = false, stopRequested = false;
  // 拿到共享流之后**不立刻开录** —— 用户要先切到参考页面、找到想学的那一刻，
  // 再自己决定什么时候按「开始录制」。这和暂停/停止是同一套控制。
  let started = false;

  const flushSheet = () => {
    if (!sourceFrames.length) return;
    sheets.push({
      image: sheet.toDataURL('image/jpeg', 0.72),
      width: sheet.width,
      height: sheet.height,
      start: +(pageStart / 1000).toFixed(3),
      end: +(pageEnd / 1000).toFixed(3),
    });
    sourceFrames = [];
    sheetContext.clearRect(0, 0, sheet.width, sheet.height);
  };

  const sample = source => {
    cellContext.drawImage(source, 0, 0, cellWidth, cellHeight);
    const pixels = cellContext.getImageData(0, 0, cellWidth, cellHeight);
    const ratio = scanRatios(pixels.data, cellWidth, 0, 0, cellWidth, cellHeight, previousLuma);
    previousLuma = ratio.luma;
    const seconds = activeMs / 1000;
    series.push({ f: frameIndex, t: +seconds.toFixed(3), ba: ratio.ba, cw: ratio.cw, mo: ratio.mo });

    if (activeMs >= nextSampleMs && samples.length < 12) {
      const scale = Math.min(1, SAMPLE_LONG_EDGE / width, SAMPLE_LONG_EDGE / height);
      sampleCanvas.width = Math.max(1, Math.round(width * scale));
      sampleCanvas.height = Math.max(1, Math.round(height * scale));
      sampleCanvas.getContext('2d').drawImage(source, 0, 0, sampleCanvas.width, sampleCanvas.height);
      samples.push({
        time: +seconds.toFixed(3),
        image: sampleCanvas.toDataURL('image/jpeg', 0.78),
        width: sampleCanvas.width,
        height: sampleCanvas.height,
      });
      nextSampleMs = activeMs + 1000;
    }

    const slot = sourceFrames.length;
    if (slot === 0) pageStart = activeMs;
    pageEnd = activeMs;
    const x = (slot % 4) * cellWidth;
    const y = Math.floor(slot / 4) * (cellHeight + 24);
    sheetContext.fillStyle = '#111';
    sheetContext.fillRect(x, y, cellWidth, cellHeight + 24);
    sheetContext.drawImage(source, x, y, cellWidth, cellHeight);
    sheetContext.fillStyle = '#fff';
    sheetContext.font = '16px sans-serif';
    sheetContext.fillText('c' + frameIndex + '  ' + seconds.toFixed(2) + 's', x + 5, y + cellHeight + 18);
    sourceFrames.push(frameIndex);
    if (sourceFrames.length === 24) flushSheet();
    frameIndex++;
  };

  let reader = null;
  let video = null;
  if (typeof MediaStreamTrackProcessor === 'function') {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  } else {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
  }

  const paint = () => {
    ui.time.textContent = started
      ? (activeMs / 1000).toFixed(1) + 's / ' + REFERENCE_MAX_SECONDS + 's'
      : '未开始';
    ui.fill.style.width = Math.min(100, activeMs / MAX_MS * 100) + '%';
    ui.frames.textContent = frameIndex + ' 帧 · ' + sheets.length + ' 页接触表';
  };
  const setPausedUi = value => {
    paused = value;
    ui.pause.textContent = paused ? '继续' : '暂停';
    if (!started) return;
    ui.hint.textContent = paused
      ? '已暂停。点「继续」接着录，或点「停止并保存」。'
      : '现在切到参考页面去播放就行 —— 录制在后台继续，不会因为切走而停。';
  };
  const onStart = () => {
    started = true;
    lastNow = performance.now();
    ui.start.hidden = true;
    ui.pause.hidden = false;
    ui.stop.hidden = false;
    setPausedUi(false);
    status('已开始录制。切到参考页面播放，看够了点「停止并保存」。');
    paint();
  };
  const onStop = () => { stopRequested = true; };
  const onPause = () => setPausedUi(!paused);
  const onCancel = () => { cancelled = true; stopRequested = true; };

  state.recording = true;
  ui.root.hidden = false;
  ui.start.addEventListener('click', onStart);
  ui.stop.addEventListener('click', onStop);
  ui.pause.addEventListener('click', onPause);
  ui.cancel.addEventListener('click', onCancel);
  ui.pop.hidden = !pipSupported();
  const onPop = async () => {
    const pip = await popRecorderOut(ui.root);
    if (pip) { ui.pop.hidden = true; status('已弹成悬浮窗 —— 它会一直浮在最前面，切到参考页面也能看到。'); }
    else status('这个浏览器打不开悬浮窗，面板会留在当前标签页里。', true);
  };
  ui.pop.addEventListener('click', onPop);
  makeDraggable(ui.root, ui.root.querySelector('.recorder-head'));
  ui.start.hidden = false;
  ui.pause.hidden = true;
  ui.stop.hidden = true;
  ui.hint.textContent = '共享流已就绪，但还没开始录。先切到参考页面找到你想学的那一刻，再回来点「开始录制」。';
  paint();
  const displayTimer = setInterval(paint, 200);
  status('已拿到共享画面。切到参考页面准备好，再点浮窗上的「开始录制」。');

  try {
    const frames = (async function* pullFrames() {
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          yield { image: value, close: () => value.close() };
        }
      }
      while (true) {
        await new Promise(resolve => {
          if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => resolve());
          else requestAnimationFrame(() => resolve());
        });
        yield { image: video, close: () => {} };
      }
    })();

    for await (const item of frames) {
      try {
        const now = performance.now();
        const delta = now - lastNow;
        lastNow = now;
        if (started && !paused) activeMs += delta;
        if (stopRequested) break;
        if (started && !paused) {
          const bucket = Math.floor(activeMs / 1000 * 30 + 0.5 - 1e-9);
          if (bucket !== lastBucket) { lastBucket = bucket; sample(item.image); }
          if (activeMs >= MAX_MS) { autoStopped = true; break; }
        }
      } finally { item.close(); }
    }
  } catch (error) {
    status('录屏中断：' + (error?.message || error), true);
    cancelled = true;
  } finally {
    clearInterval(displayTimer);
    ui.start.removeEventListener('click', onStart);
    ui.stop.removeEventListener('click', onStop);
    ui.pause.removeEventListener('click', onPause);
    ui.cancel.removeEventListener('click', onCancel);
    ui.pop.removeEventListener('click', onPop);
    if (pipWindow) { try { pipWindow.close(); } catch {} pipWindow = null; }
    if (ui.root.parentElement !== document.body) document.body.appendChild(ui.root);
    ui.root.hidden = true;
    state.recording = false;
    for (const item of stream.getTracks()) item.stop();
    if (reader) { try { await reader.cancel(); } catch {} }
    if (video) video.srcObject = null;
  }

  if (cancelled) { status('已放弃这次录屏。'); return; }
  if (!started) { status('没有开始录制，已取消。'); return; }
  flushSheet();
  if (!sheets.length) {
    status('没录到有效画面 —— 可能共享的是空白窗口，或者录制期间画面完全没变。再试一次？', true);
    return;
  }

  // ⚠️ 这里刻意不用 window.prompt 起名。
  // 用户点「停止」时通常人还在参考页面，我们这个标签页在后台，
  // 而后台标签页弹出的 prompt 会被浏览器抑制、直接返回 null，
  // 结果是录好的东西被当成「已取消」丢掉 —— 这个坑真踩过一次。
  // 改成：先自动起名并立刻放进参考库，想改名在列表里点「重命名」。
  const now = new Date();
  const stamp = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const item = {
    id: 'cap-' + Date.now(),
    name: '录屏参考 ' + stamp,
    range: { start: 0, end: +(activeMs / 1000).toFixed(2) },
    sheets,
    samples,
    series,
  };
  state.captured.push(item);
  renderCaptured();
  revealCaptured(item.id);
  status('✓ 已捕获「' + item.name + '」：' + series.length + ' 帧、' + sheets.length + ' 页接触表、' + samples.length + ' 张对照样片'
    + (autoStopped ? '（到 ' + REFERENCE_MAX_SECONDS + ' 秒自动停止）' : '')
    + '。它已经勾选上了，想改名在列表里点「重命名」。');
}

/** 捕获完成后把参考列表滚进视野并闪一下，让人确信「录上了」。 */
function revealCaptured(id) {
  const box = $('reference-captured');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const row = box.querySelector('[data-captured-id="' + id + '"]');
  if (!row) return;
  row.classList.add('just-added');
  setTimeout(() => row.classList.remove('just-added'), 2400);
}

/** 点开确认这一条到底添加对没有。视频直接播，图片直接看。 */
/**
 * 点开确认这一条添加对没有。
 *
 * 两种情况：
 *  ① 素材库里的文件 → 直接播/看原文件（走 /reference/，已支持 Range）
 *  ② 本次录屏 → 没有原始视频（我们只存了抽出来的帧），
 *     就把录制时的接触表摆出来 —— 那本身就是「录到了什么」的完整记录。
 *     之前这里错把一张静态样片塞进 <video>，所以看起来「视频播不出来」。
 */
/**
 * 播放失败时显示的东西。
 *
 * 关键取舍：播放和评审用的是**两套完全不同的东西** ——
 *   · 播放走 <video>，要求容器 + 编码都是浏览器支持的（基本只认 H.264）
 *   · 评审走 mp4box + WebCodecs 逐帧解码
 * 所以「播不出来」不等于「不能用」。直接甩一句「文件可能坏了」，
 * 等于让用户白跑一趟 —— 所以这里给一条真能验证的路：摊帧。
 */
function showPreviewProblem(container, name, why) {
  container.replaceChildren();
  const tip = document.createElement('p');
  tip.className = 'preview-note error';
  tip.textContent = '浏览器播不出来：' + why;
  container.appendChild(tip);
  const hint = document.createElement('p');
  hint.className = 'preview-note';
  hint.textContent = '注意：能播和能用是两件事。评审用的是逐帧解码，和播放器不是一套东西 —— '
    + '播不出来不代表不能评审。点下面按钮真解几帧看看。';
  container.appendChild(hint);
  const row = document.createElement('div');
  row.className = 'preview-actions';
  const tryBtn = document.createElement('button');
  tryBtn.type = 'button';
  tryBtn.className = 'chip-button accent';
  tryBtn.textContent = '摊帧验证';
  tryBtn.addEventListener('click', () => decodePreviewFrames(container, name));
  row.appendChild(tryBtn);
  container.appendChild(row);
}

/** 用和评审完全相同的管线真解几帧出来 —— 这是「能不能用」的唯一可靠判断。 */
async function decodePreviewFrames(container, name) {
  container.replaceChildren();
  const note = document.createElement('p');
  note.className = 'preview-note';
  note.textContent = '正在用评审的管线试解，稍等……';
  container.appendChild(note);
  try {
    const blob = await (await fetch('/reference/' + encodeURIComponent(name))).blob();
    const file = new File([blob], name, { type: blob.type || 'video/mp4' });
    const info = await inspectVideo(file);
    const span = Math.min(Number(info.duration) || 3, 3);
    const times = [0.15, 0.5, 0.85].map(r => r * span);
    const decoded = await decodeSequence(file, { start: 0, end: span }, () => {}, { mode: 'frames', times });
    const shots = (decoded.frames || []).filter(f => f && f.image);
    container.replaceChildren();
    if (!shots.length) throw new Error('解码没有产出画面');
    const ok = document.createElement('p');
    ok.className = 'preview-note';
    const meta = [info.width && info.height ? info.width + '×' + info.height : '', info.fps ? Math.round(info.fps) + 'fps' : '', info.duration ? info.duration.toFixed(1) + 's' : '']
      .filter(Boolean).join(' · ');
    ok.textContent = '✓ 能正常解码（' + meta + '）—— 评审不受影响。这是从文件里真解出来的画面：';
    container.appendChild(ok);
    const grid = document.createElement('div');
    grid.className = 'preview-grid';
    for (const shot of shots) {
      const img = document.createElement('img');
      img.src = shot.image;
      img.alt = name + ' 解出的画面';
      img.addEventListener('click', () => openLightbox(shot.image, img.alt));
      grid.appendChild(img);
    }
    container.appendChild(grid);
  } catch (error) {
    container.replaceChildren();
    const bad = document.createElement('p');
    bad.className = 'preview-note error';
    bad.textContent = '这条文件连评审管线也解不了：' + ((error && error.message) || error)
      + '。多半是编码问题（例如 H.265 / ProRes / 未封装的裸流）—— 用 Media Encoder 或 HandBrake 转成 H.264 的 MP4 再用。';
    container.appendChild(bad);
  }
}

async function previewReference(options) {
  const { kind = 'video', name = '未命名', sheets = [], note = '' } = options || {};
  const body = $('preview-body');
  body.replaceChildren();
  body.dataset.mode = sheets.length ? 'grid' : 'single';
  $('preview-title').textContent = (kind === 'image' ? '参考图 · ' : '参考视频 · ') + name;

  if (sheets.length) {
    const tip = document.createElement('p');
    tip.className = 'preview-note';
    tip.textContent = note || '这是录制时抽出来的接触表（每格 1/30 秒）。录屏不保存原始视频，所以这里回放的是抽帧记录。';
    body.appendChild(tip);
    const grid = document.createElement('div');
    grid.className = 'preview-grid';
    for (const sheet of sheets) {
      const node = document.createElement('img');
      node.src = sheet.image;
      node.alt = name + ' 的接触表';
      node.addEventListener('click', () => openLightbox(sheet.image, node.alt));
      grid.appendChild(node);
    }
    body.appendChild(grid);
  } else if (kind === 'image') {
    const node = document.createElement('img');
    node.src = '/reference/' + encodeURIComponent(name);
    body.appendChild(node);
  } else {
    // 本地版走服务器（已支持 Range）；链接版走 blob: ——
    // 浏览器对 blob: 的原生媒体支持是完整的，能播、能拖进度条。
    let src;
    try {
      src = LINK_MODE ? await referenceObjectURL(name) : '/reference/' + encodeURIComponent(name);
    } catch (error) {
      showPreviewProblem(body, name, '取不到这个文件：' + ((error && error.message) || error));
      $('preview-dialog').showModal();
      return;
    }
    const node = document.createElement('video');
    node.src = src;
    node.controls = true;
    node.autoplay = true;
    node.muted = true;
    node.playsInline = true;
    node.preload = 'metadata';
    node.addEventListener('error', () => {
      // 把真实错误码翻译出来 —— 甩一句「可能坏了」等于没说
      const code = node.error ? node.error.code : 0;
      const why = {
        1: '加载被中止',
        2: '读取失败',
        3: '解码失败（多半是编码不被浏览器支持，例如 H.265 / ProRes）',
        4: '浏览器不支持这个封装格式',
      }[code] || '未知原因';
      showPreviewProblem(body, name, why);
    });
    body.appendChild(node);
  }
  $('preview-dialog').showModal();
}

function renderCaptured() {
  const box = $('reference-captured');
  box.replaceChildren();
  if (!state.captured.length) return;
  const title = document.createElement('p');
  title.className = 'help';
  title.textContent = '本次录屏（只存在于当前页面，刷新后消失 —— 想长期保留就自己另存一份再「本地上传」）：';
  box.appendChild(title);

  for (const item of state.captured) {
    const row = document.createElement('div');
    row.className = 'reference-row';
    row.dataset.capturedId = item.id;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.value = item.id;
    check.checked = true;

    const name = document.createElement('span');
    name.className = 'reference-name';
    name.textContent = item.name;
    name.title = item.name + '（' + item.range.end + 's）';

    const size = document.createElement('span');
    size.className = 'reference-size';
    size.textContent = item.range.end + 's · ' + item.series.length + ' 帧';

    const look = document.createElement('button');
    look.type = 'button';
    look.className = 'row-action';
    look.textContent = '预览';
    look.title = '点开确认录到了什么';
    look.setAttribute('aria-label', '预览 ' + item.name);
    look.addEventListener('click', () => previewReference({ kind: 'video', name: item.name, sheets: item.sheets || [] }));

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'row-action';
    rename.textContent = '重命名';
    rename.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'reference-rename';
      input.value = item.name;
      input.maxLength = 60;
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        if (next) item.name = next;
        renderCaptured();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { done = true; renderCaptured(); }
      });
      name.replaceWith(input);
      input.focus();
      input.select();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'row-action danger';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      state.captured = state.captured.filter(entry => entry.id !== item.id);
      renderCaptured();
    });

    row.append(check, name, size, look, rename, remove);
    box.appendChild(row);
  }
}

/** 从视频直链抓一个参考回来。只认视频直链，不解析播放页 —— 见 server/references.mjs 的说明。 */
async function fetchReferenceByUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) { status('链接要以 http:// 或 https:// 开头。', true); return; }
  status('正在抓取链接……（大文件可能要等一会儿）');
  $('reference-url-go').disabled = true;
  try {
    const response = await fetch('/api/references/from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) { status(data?.error || ('抓取失败：' + response.status), true); return; }
    $('reference-url').value = '';
    $('reference-url-row').hidden = true;
    await loadReferences();
    status('已加入参考库：' + data.reference.name);
  } catch (error) {
    status('抓取失败：' + error.message, true);
  } finally {
    $('reference-url-go').disabled = false;
  }
}

async function uploadReferences(files) {
  for (const file of files) {
    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(file.name);
    if (!/\.(mp4|mov|m4v|png|jpe?g|webp|gif)$/i.test(file.name)) {
      status('参考只支持 MP4 / MOV 视频，或 PNG / JPG / WebP / GIF 图片：' + file.name, true);
      continue;
    }
    const cap = isImage ? 12 * 1024 * 1024 : 100 * 1024 * 1024;
    if (file.size > cap) { status(file.name + ' 超过 ' + Math.round(cap / 1024 / 1024) + ' MB，已跳过。', true); continue; }
    status('正在存入参考库：' + file.name + ' ……');
    const response = await fetch('/api/references?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      status(data?.error || ('添加失败：' + response.status), true);
      return;
    }
  }
  await loadReferences();
  status('参考库已更新。');
}

/**
 * 兜底：参考如果没有样片（比如修复前录的、或者老数据），
 * 就从它的接触表格子里把单帧裁出来当样片。
 *
 * 为什么需要：并排对照右侧要一张干净的单帧。没有样片时整块对照就渲染不出来，
 * 用户看到的就只剩自己作品那两张 —— 这正是他反复反馈的现象。
 * 接触表格子本身就是 1/30 秒一帧，裁出来就是干净的定位单帧。
 */
async function fillSamplesFromSheets(references) {
  for (const item of references) {
    if (item.kind === 'image' || (Array.isArray(item.samples) && item.samples.length)) continue;
    const out = [];
    for (const sheet of item.sheets || []) {
      if (!Number.isFinite(sheet.start) || !Number.isFinite(sheet.width)) continue;
      const cellW = Math.floor(sheet.width / 4);
      const cellH = Math.floor(sheet.height / 6) - 24;
      if (cellW < 16 || cellH < 16 || out.length >= 12) continue;
      let bitmap;
      try { bitmap = await dataUrlBitmap(sheet.image); } catch { continue; }
      try {
        for (let k = 0; k < 24 && out.length < 12; k += 2) {
          const canvas = document.createElement('canvas');
          canvas.width = cellW;
          canvas.height = cellH;
          canvas.getContext('2d').drawImage(
            bitmap,
            (k % 4) * cellW, Math.floor(k / 4) * (cellH + 24), cellW, cellH,
            0, 0, cellW, cellH,
          );
          out.push({
            time: +(sheet.start + k / 30).toFixed(3),
            image: canvas.toDataURL('image/jpeg', 0.8),
            width: cellW, height: cellH,
          });
        }
      } finally { bitmap.close(); }
    }
    item.samples = out;
  }
  return references;
}

/**
 * 把勾选的参考解码成接触表 —— 这是「公平对比」的前提。
 * 模型看不了视频，所以参考必须和作品一样先压成接触表 + 数值，
 * 否则就成了「接触表 vs 记忆里的视频」，那还是凭印象。
 */
async function loadSelectedReferences() {
  const out = [];
  // 本次录屏的已经在内存里解码好了，直接用
  for (const box of $('reference-captured').querySelectorAll('input:checked')) {
    const item = state.captured.find(entry => entry.id === box.value);
    if (item && out.length < MAX_REFERENCES) {
      out.push({ name: item.name, kind: 'video', range: item.range, sheets: pickSheets(item.sheets), samples: pickSheets(item.samples || []), series: item.series });
    }
  }
  const names = [...$('reference-list').querySelectorAll('input:checked')].map(box => box.value).slice(0, Math.max(0, MAX_REFERENCES - out.length));
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    try {
      const info = referenceFiles.find(entry => entry.name === name);
      if (info && info.kind === 'image') {
        status('正在读取参考图 ' + (index + 1) + ' / ' + names.length + '：' + name + ' ……');
        const image = await shrinkImage(await (await fetch('/reference/' + encodeURIComponent(name))).blob(), 960);
        out.push({ name, kind: 'image', range: { start: 0, end: 0 }, sheets: [{ image }], samples: [], series: [] });
        continue;
      }
      status('正在解码参考 ' + (index + 1) + ' / ' + names.length + '：' + name + ' ……');
      const blob = await (await fetch('/reference/' + encodeURIComponent(name))).blob();
      const file = new File([blob], name, { type: blob.type || 'video/mp4' });
      const meta = await inspectVideo(file);
      // 长特效动辄十几二十秒，取 3 秒根本看不出节奏 —— 放到 30 秒，再均匀取样控制体积
        const range = refRangeFor(name, meta.duration);   // 用户选的区间；没选就是整段（上限 120 秒）
        if (range.end > meta.duration) range.end = meta.duration;
        const end = range.end;
        if (!(range.end - range.start > 0.1)) { status('参考「' + name + '」这一段没有可用帧，已跳过。', true); continue; }
        const decoded = await decodeSequence(file, range, () => {}, {
        mode: 'sheets', series: true, emitSamples: true, sampleEverySeconds: Math.max(1, end / 12), sampleLimit: 12,
      });
      const manifest = decoded.sourceManifest;
      const mapped = decoded.frames.map(unit => {
        const first = manifest[unit.sourceFrames[0]];
        const last = manifest[unit.sourceFrames[unit.sourceFrames.length - 1]];
        return { image: unit.image, width: unit.width, height: unit.height, start: first.time, end: last.time + last.duration };
      });
      out.push({ name, kind: 'video', range, sheets: pickSheets(mapped), samples: decoded.samples || [], series: decoded.series });
    } catch (error) {
      status('参考「' + name + '」解码失败：' + error.message, true);
    }
  }
  return out;
}

/* ───────────────────────── 配置模型向导 ───────────────────────── */

let setupProviders = [];

async function loadSetup() {
  try {
    const data = await (await fetch('/api/setup')).json();
    setupProviders = data.providers || [];
    const select = $('setup-provider');
    select.replaceChildren();
    for (const provider of setupProviders) {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.label;
      select.appendChild(option);
    }
    const current = setupProviders.find(item => item.id === data.provider) || setupProviders[0];
    if (current) select.value = current.id;
    $('setup-baseurl').value = data.baseUrl || current?.baseUrl || '';
    $('setup-model').value = data.model || current?.model || '';
    $('setup-key').value = '';
    applyProvider(current, true);
  } catch {
    $('setup-provider-note').textContent = byMode('读取配置失败，请确认启动窗口还开着。', '读取配置失败，刷新页面重试一下。');
  }
}

function applyProvider(provider, keepValues) {
  if (!provider) return;
  $('setup-provider-note').textContent = provider.note || '';
  // 申请入口跟着服务商走 —— 找不到就藏起来，别留一个点不动的空链接。
  const keyLink = $('setup-key-link');
  const applyUrl = (provider && (provider.keyUrl || provider.applyUrl || provider.signupUrl)) || '';
  if (/^https?:/i.test(applyUrl)) { keyLink.href = applyUrl; keyLink.hidden = false; }
  else { keyLink.hidden = true; keyLink.removeAttribute('href'); }
  if (!keepValues) {
    $('setup-baseurl').value = provider.baseUrl || '';
    $('setup-model').value = provider.model || '';
    $('setup-key').value = '';
  }
  const hint = $('setup-key-hint');
  if (provider.needsKey === false) {
    hint.textContent = '这家跑在你自己的电脑上，不需要 API Key，留空即可。';
  } else if (provider.keyUrl) {
    hint.innerHTML = '还没有 Key？<a href="' + provider.keyUrl + '" target="_blank" rel="noopener noreferrer">点这里去申请 →</a>　复制后粘贴到上面这一栏。';
  } else {
    hint.textContent = '填入你的服务商提供的 API Key。';
  }
  setupStatus('');
}

function setupStatus(text, kind = '') {
  const el = $('setup-status');
  el.textContent = text;
  el.className = 'help setup-status' + (kind ? ' ' + kind : '');
}

function readSetupForm() {
  return {
    provider: $('setup-provider').value,
    baseUrl: $('setup-baseurl').value.trim(),
    model: $('setup-model').value.trim(),
    apiKey: $('setup-key').value.trim(),
  };
}

async function runSetupTest() {
  const form = readSetupForm();
  setupStatus('正在测试连接…（会真的发一张红色小图给模型，验证它能不能读图）');
  $('setup-test').disabled = true;
  $('setup-save').disabled = true;
  try {
    const data = await (await fetch('/api/setup/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })).json();
    if (!data.ok) {
      setupStatus('✗ ' + data.error + (data.hint ? '　' + data.hint : ''), 'error');
      return false;
    }
    if (!data.visionOk) {
      setupStatus('△ ' + data.hint + '　（模型回的是：' + data.reply + '）', 'warn');
      return false;
    }
    setupStatus('✓ ' + data.hint + '　（模型回的是：' + data.reply + '）', 'ok');
    return true;
  } catch (error) {
    setupStatus('✗ 测试失败：' + error.message, 'error');
    return false;
  } finally {
    $('setup-test').disabled = false;
    $('setup-save').disabled = false;
  }
}

async function saveSetup() {
  const ok = await runSetupTest();
  if (!ok) return;
  setupStatus('连接正常，正在保存…');
  try {
    const response = await fetch('/api/setup/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readSetupForm()),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || ('保存失败：' + response.status));
    setupStatus('✓ 已保存，立刻生效。可以关掉这个窗口开始评审了。', 'ok');
    await checkHealth();
    setTimeout(closeSetup, 1200);
  } catch (error) {
    setupStatus('✗ ' + error.message, 'error');
  }
}

function openSetup() {
  loadSetup().then(() => $('setup-dialog').showModal());
}
function closeSetup() {
  const dialog = $('setup-dialog');
  if (dialog.open) dialog.close();
}

function paintLevels() {
  renderOptionGroup('level-options', LEVELS, state.settings.feedbackLevel, value => {
    state.settings.feedbackLevel = value;
    paintLevels();
  });
}
function paintReasoning() {
  renderOptionGroup('reasoning-options', REASONING, state.settings.reasoning, value => {
    state.settings.reasoning = value;
    paintReasoning();
  });
}
paintLevels();
paintReasoning();

$('reference-add').addEventListener('click', () => $('reference-file').click());
$('reference-url-toggle').addEventListener('click', () => {
  const row = $('reference-url-row');
  row.hidden = !row.hidden;
  if (!row.hidden) $('reference-url').focus();
});
/* ── 检查更新（分享给朋友后，他们靠这个知道你有没有改东西） ── */

/* ── 报告里的图点一下放大 ── */

function openLightbox(source, alt) {
  $('lightbox-img').src = source;
  $('lightbox-img').alt = alt || '';
  $('lightbox').hidden = false;
}
function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightbox-img').src = '';
}
$('lightbox').addEventListener('click', closeLightbox);
$('preview-close').addEventListener('click', () => {
  const body = $('preview-body');
  const video = body.querySelector('video');
  if (video) { video.pause(); video.src = ''; }
  body.replaceChildren();
  $('preview-dialog').close();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('lightbox').hidden) closeLightbox();
});
$('report').addEventListener('click', event => {
  const img = event.target.closest('.shot img');
  if (img && img.src) { event.preventDefault(); openLightbox(img.src, img.alt); }
});

$('version-badge').addEventListener('click', async () => {
  const badge = $('version-badge');
  badge.disabled = true;
  status('正在检查更新…');
  try {
    const data = await (await fetch('/api/updates')).json();
    if (!data.ok) { status(data.message, true); return; }
    status(data.message);
    if (data.hasUpdate) {
      const lines = [
        '有新版本：' + data.latest + '（你当前是 ' + data.version + '）',
        '',
        byMode(
      '更新时请保留 .env（你的 API Key）和 reference（你的参考素材），只替换代码文件。',
      '更新会自动生效：作者发布新版本后，页面底部会弹出提示，点一下刷新即可。',
    ),
        '',
        '要打开下载页面吗？',
      ];
      if (window.confirm(lines.join(String.fromCharCode(10))) && data.pageUrl) {
        window.open(data.pageUrl, '_blank', 'noopener');
      }
    }
  } catch (error) {
    status('检查更新失败：' + error.message, true);
  } finally {
    badge.disabled = false;
  }
});

$('reference-capture').addEventListener('click', captureReference);
$('reference-url-go').addEventListener('click', () => fetchReferenceByUrl($('reference-url').value));
$('reference-url').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); fetchReferenceByUrl($('reference-url').value); }
});
$('reference-file').addEventListener('change', async event => {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (files.length) await uploadReferences(files);
});
/* ── 白天 / 夜间 ── */

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  $('theme-toggle').textContent = next === 'dark' ? '白天' : '夜间';
  $('theme-toggle').setAttribute('aria-label', next === 'dark' ? '切换到白天模式' : '切换到夜间模式');
  try { localStorage.setItem('vfx-theme', next); } catch {}
}

function initialTheme() {
  try {
    // 主题已经在 <head> 里同步定过了（防闪光），直接用它的结果，不要重新判定一次。
  const preset = document.documentElement.dataset.theme;
  if (preset === 'dark' || preset === 'light') return preset;

  const saved = localStorage.getItem('vfx-theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {}
  // 没手动选过就跟随系统
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

applyTheme(initialTheme());
$('theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

$('setup-open').addEventListener('click', openSetup);
$('setup-banner-open').addEventListener('click', openSetup);
$('setup-close').addEventListener('click', closeSetup);

// 显示/隐藏 Key —— 粘贴时看不见，很容易贴错一个字符。
$('setup-key-toggle').addEventListener('click', () => {
  const input = $('setup-key');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('setup-key-toggle').textContent = show ? '隐藏' : '显示';
});
$('setup-test').addEventListener('click', runSetupTest);
$('setup-save').addEventListener('click', saveSetup);
$('setup-provider').addEventListener('change', () => {
  applyProvider(setupProviders.find(item => item.id === $('setup-provider').value), false);
});
$('setup-dialog').addEventListener('click', event => {
  if (event.target === $('setup-dialog')) closeSetup();
});

try { $('consent').checked = localStorage.getItem('vfx-consent') === '1'; } catch {}
updateButtons();
loadReferences();
checkHealth();

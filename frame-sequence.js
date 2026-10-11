/**
 * frame-sequence.js —— 逐帧解码 / 接触表 / 全帧数值序列
 *
 * 这是整套评审流程的地基，只做三件事：
 *
 *   1. 解封装：用 mp4box 读出 MP4/MOV 里**每一个**源帧的采样表（cts/duration）。
 *      不用 video.currentTime 跳帧 —— 那会在高帧率素材上悄悄丢帧。
 *   2. 接触表：用 WebCodecs 把选区内所有帧真正解码出来，按 1/30 秒分桶，拼成 4×6
 *      的网格图（带 "f123 1.2340s" 标签）。模型因此能看到**连续的运动**，
 *      而不是几张互相没有关系的截图。
 *   3. 数值序列：解码的同时逐帧实算两个面积占比 —— 亮饱和 ba（V>190 且 S>70）与
 *      白核 cw（V>245）—— 得到一条覆盖**每一帧**的序列，用来画亮度轨迹。
 *      只闪 1/60 秒的峰值帧不会被抽样漏掉。
 *
 * 依赖 public/vendor/mp4box/mp4box.all.min.js，以经典 <script> 引入并挂在 globalThis 上
 * （该构建顶层是 var MP4Box / var DataStream，所以浏览器里可直接读到）。
 */

const Lib = globalThis.MP4Box;
const DataStream = globalThis.DataStream;

/** 评审选区上限（秒）。这是产品口径，前端会先拦一次，这里再拦一次只是省一次白解码。 */
export const MAX_RANGE_SECONDS = 15;
/** 解码兜底：选区内的源帧数上限（7200 = 60fps × 120s）。 */
export const MAX_SOURCE_FRAMES = 7200;
/** 数值序列条数上限，必须与 MAX_SOURCE_FRAMES 同值，否则序列会比帧闸更早截断。 */
export const SERIES_LIMIT = 7200;
/** 接触表分桶频率：每 1/30 秒一格。 */
export const CONTACT_FPS = 30;
export const CONTACT_COLUMNS = 4;
export const CONTACT_ROWS = 6;
export const CONTACT_CELLS = CONTACT_COLUMNS * CONTACT_ROWS;
/** 单帧 base64 字符数硬闸（≈1.57 MB 原始 JPEG）。超了就说明这段素材单帧信息量过大。 */
export const MAX_FRAME_DATAURL_CHARS = 2200000;
/** 本地画布/内存的累计上限，与实际发给服务端的批次无关。 */
export const MAX_TOTAL_DATAURL_CHARS = 64 * 1024 * 1024;
export const SHEET_CELL_WIDTH = 400;
export const SHEET_LABEL_HEIGHT = 24;
export const SHEET_QUALITY = 0.72;
export const HD_QUALITY = 0.72;

function requireLib() {
  if (!Lib?.createFile || !DataStream) {
    throw new Error('mp4box 未加载：请确认 /vendor/mp4box/mp4box.all.min.js 在页面脚本之前引入。');
  }
}

/** 把 data URL 变成可绘制的 ImageBitmap。 */
export async function dataUrlBitmap(image) {
  const encoded = image.slice(image.indexOf(',') + 1);
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
}

/* ───────────────────────── 轻量像素统计 ───────────────────────── */

/**
 * 只扫一个子矩形，返回两个面积占比（百分数，保留两位）：
 *   ba = 亮饱和面积  —— V = max(R,G,B) > 190 且 S = 255·(1 − min/max) > 70
 *   cw = 白核面积    —— V > 245
 * 两者是**独立**判定，可以同时成立（白核同时也是亮饱和），不能写成 else if。
 * 刻意用 V=max(R,G,B) 而不是加权亮度：加权亮度会把纯蓝判成暗，与视觉感受不符。
 */
export function scanRatios(data, stride, x0, y0, w, h, prevLuma) {
  const total = w * h;
  let brightSat = 0, core = 0, motionSum = 0;
  const luma = new Uint8Array(total);
  let k = 0;
  for (let y = 0; y < h; y++) {
    let i = ((y0 + y) * stride + x0) * 4;
    for (let x = 0; x < w; x++, i += 4, k++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mx > 245) core++;
      if (mx > 190 && (mx - mn) * 255 / mx > 70) brightSat++;
      const y601 = (r * 299 + g * 587 + b * 114) / 1000 | 0;
      luma[k] = y601;
      if (prevLuma) motionSum += Math.abs(y601 - prevLuma[k]);
    }
  }
  const pct = n => Math.round(n / total * 10000) / 100;
  // mo = 与上一帧的平均灰度差（0-100），即「画面动了多少」。
  // 亮度序列只能看出「亮不亮」，看不出「动不动」；而节奏问题（空档、拖沓、爆点不够强）
  // 恰恰要看动。代价只是同一遍像素循环里多算一次绝对值，不额外解码、不额外上传。
  const mo = prevLuma ? Math.round(motionSum / total / 255 * 10000) / 100 : 0;
  return { ba: pct(brightSat), cw: pct(core), mo, luma };
}

/**
 * 单帧的完整数值（给被抽成高清证据的那几帧用）。
 * V/S 口径与 scanRatios 一致；分层差 = 前景灰度中位数 − 背景灰度中位数，
 * 用 256 桶直方图求中位数（整幅排序会卡死主线程）。
 * 前景 = 白核 ∪ 亮饱和；背景 = 既不是白核、亮饱和，也不是中间体。
 */
export function frameMetrics(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const total = canvas.width * canvas.height;
  const histFg = new Uint32Array(256), histBg = new Uint32Array(256);
  let brightSat = 0, core = 0, mass = 0, cx = 0, cy = 0, maxV = 0, sumV = 0;
  for (let y = 0, i = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++, i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const V = mx, S = mx === 0 ? 0 : (mx - mn) * 255 / mx;
      const gray = (r * 299 + g * 587 + b * 114) / 1000 | 0;
      sumV += V; if (V > maxV) maxV = V;
      const isCore = V > 245, isBrightSat = V > 190 && S > 70, isBody = S > 60 && V >= 100 && V <= 190;
      if (isBrightSat) brightSat++;
      if (isCore) core++;
      if (isBrightSat || isCore) { histFg[gray]++; cx += x; cy += y; mass++; }
      else if (!isBody) histBg[gray]++;
    }
  }
  const medianOf = hist => {
    let n = 0;
    for (let i = 0; i < 256; i++) n += hist[i];
    if (!n) return null;
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc * 2 >= n) return i; }
    return 255;
  };
  const m = {
    brightSatPct: +(brightSat / total * 100).toFixed(2),
    corePct: +(core / total * 100).toFixed(2),
    meanV: Math.round(sumV / total),
    maxV,
    centroid: mass ? { x: +(cx / mass / canvas.width).toFixed(3), y: +(cy / mass / canvas.height).toFixed(3) } : null,
  };
  const fg = medianOf(histFg), bg = medianOf(histBg);
  if (fg !== null && bg !== null) { m.fgLuma = fg; m.bgLuma = bg; m.layerGap = Math.round(fg - bg); }
  return m;
}

/* ───────────────────────── 元信息与分桶 ───────────────────────── */

export async function inspectVideo(file) {
  requireLib();
  const mp4 = Lib.createFile();
  let track = null, error = null;
  mp4.onError = e => { error = e; };
  mp4.onReady = info => { track = info.videoTracks[0]; };
  const buffer = await file.arrayBuffer();
  buffer.fileStart = 0;
  mp4.appendBuffer(buffer);
  mp4.flush();
  if (error) throw new Error('视频解封装失败：' + error);
  if (!track) throw new Error('文件里没有视频轨道，请改用 H.264 的 MP4 / MOV。');
  return {
    duration: track.duration / track.timescale,
    width: track.video.width,
    height: track.video.height,
    total: track.nb_samples,
    codec: track.codec,
    timescale: track.timescale,
  };
}

/**
 * 选区内的源帧清单。time 相对选区首帧归零，并夹住"MP4 timescale 把 UI 边界
 * 表示成 1.9999999999999998"这类浮点误差：落在选区起点之前的首帧会被拉回 start。
 */
export function sourceManifestForRange(ordered, timescale, range) {
  const origin = ordered[0].cts / timescale;
  return ordered
    .map((s, index) => ({
      sourceIndex: index,
      time: s.cts / timescale - origin,
      duration: s.duration / timescale,
      timestamp: Math.round(s.cts / timescale * 1e6),
    }))
    .filter(f => f.time >= range.start - 0.000001 && f.time < range.end)
    .map(f => (f.time < range.start ? { ...f, time: range.start } : f));
}

/**
 * 接触表分桶：每 1/30 秒一格，取该桶内的第一个源帧。
 *
 * 用 floor(rel·fps + 0.5 − 1e-9)（就近取整、半格向下）而不是 floor(rel·fps)：
 * 源时间戳是 cts/timescale，timescale 不能整除时步长会抖动（30fps + timescale=1000
 * 会把 33.33 压成 33/34），旧式每两帧就错一次桶边界，实测 30fps 素材只剩 300 格。
 * 半格向下是为了让恰好压在桶边界的帧归**前**一桶，否则 60fps 源会翻倍成 60 格/秒。
 */
export function contactSampleIndices(sources, fps = CONTACT_FPS) {
  if (!sources.length) return [];
  const selected = [];
  const first = sources[0].time;
  let bucket = -1;
  sources.forEach((source, index) => {
    const current = Math.floor((source.time - first) * fps + 0.5 - 1e-9);
    if (current > bucket) { selected.push(index); bucket = current; }
  });
  // 结尾必须落在真实的最后一帧上，否则最后 1/30 秒的变化就没人看了。
  if (selected.at(-1) !== sources.length - 1) {
    if (selected.length === 1) selected.push(sources.length - 1);
    else selected[selected.length - 1] = sources.length - 1;
  }
  return selected;
}

/* ───────────────────────── 主解码流程 ───────────────────────── */

/**
 * @param {File} file
 * @param {{start:number,end:number}} range
 * @param {(done:number,total:number)=>void} onProgress
 * @param {{mode:'sheets'|'frames', times?:number[], series?:boolean}} options
 *   mode='sheets' → 产出接触表 + 全帧数值序列
 *   mode='frames' → 按 times 产出原分辨率高清帧
 */
export async function decodeSequence(file, range, onProgress = () => {}, options = {}) {
  requireLib();
  if (!globalThis.VideoDecoder) {
    throw new Error('逐帧分析需要支持 WebCodecs 的 Chrome / Edge 111 或更高版本。');
  }
  if (!/\.(mp4|mov)$/i.test(file.name)) {
    throw new Error('逐帧分析目前只支持 MP4 / MOV，请先转换封装格式（不会降级成抽样分析）。');
  }

  /* ── 解封装 ── */
  const mp4 = Lib.createFile();
  const samples = [];
  let track = null, fatal = null;
  mp4.onError = message => { fatal = new Error('视频解封装失败：' + message); };
  mp4.onReady = info => {
    track = info.videoTracks[0];
    if (!track) { fatal = new Error('文件中没有视频轨道。'); return; }
    mp4.setExtractionOptions(track.id, null, { nbSamples: 200 });
    mp4.start();
  };
  mp4.onSamples = (id, user, items) => samples.push(...items);

  const buffer = await file.arrayBuffer();
  buffer.fileStart = 0;
  mp4.appendBuffer(buffer);
  mp4.flush();
  if (fatal) throw fatal;
  if (!track) throw new Error('无法读取视频轨道，请使用 H.264 MP4 文件。');
  if (samples.length !== track.nb_samples) {
    throw new Error('源视频帧索引不完整，无法进行逐帧分析。');
  }

  const ordered = [...samples].sort((a, b) => a.cts - b.cts);
  const manifest = sourceManifestForRange(ordered, track.timescale, range);
  if (!manifest.length) throw new Error('评审范围内没有可用帧，请重新选择起止时间。');
  if (range.end - range.start > MAX_RANGE_SECONDS + 0.000001) {
    throw new Error('评审范围最长 ' + MAX_RANGE_SECONDS + ' 秒，请缩短选区。');
  }
  if (manifest.length > MAX_SOURCE_FRAMES) {
    throw new Error('评审范围最多 ' + MAX_SOURCE_FRAMES + ' 个源帧，高帧率素材请缩短选区。');
  }

  const wanted = new Map(manifest.map((f, index) => [f.timestamp, { ...f, index }]));
  if (wanted.size !== manifest.length) {
    throw new Error('存在重复显示时间戳，无法可靠验证逐帧覆盖。');
  }

  /* ── 编解码器配置：description 就是 stsd 里 avcC/hvcC 去掉 8 字节 box 头 ── */
  const entry = mp4.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  let description;
  if (box) {
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(stream);
    description = stream.buffer.slice(8);
  }
  const config = {
    codec: track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    description,
  };
  if (!(await VideoDecoder.isConfigSupported(config)).supported) {
    throw new Error('浏览器不支持此视频编码（' + track.codec + '），请转为 H.264 MP4 后重试。');
  }

  const mode = options.mode === 'frames' ? 'frames' : 'sheets';
  const wantSeries = mode === 'sheets' && options.series !== false;
  const selectedTimes = mode === 'frames' ? (options.times || []) : null;

  const canvas = document.createElement('canvas');
  const sources = manifest.map((f, index) => ({
    ...f, index, width: track.video.width, height: track.video.height,
  }));

  /* ── 接触表画布：4 列 × 6 行 = 24 格/页 ── */
  const cellWidth = Math.min(SHEET_CELL_WIDTH, track.video.width);
  const cellHeight = Math.round(track.video.height * cellWidth / track.video.width);
  const sheet = document.createElement('canvas');
  sheet.width = cellWidth * CONTACT_COLUMNS;
  sheet.height = (cellHeight + SHEET_LABEL_HEIGHT) * CONTACT_ROWS;
  const sheetContext = sheet.getContext('2d');
  let pageSources = [];

  /* ── 序列带：独立一条画布，每格只画画面、不画标签（标签文字会污染像素统计） ── */
  const seriesCanvas = wantSeries ? document.createElement('canvas') : null;
  let seriesContext = null, seriesCell = 0, seriesPending = [], previousLuma = null;
  if (wantSeries) {
    seriesCanvas.width = cellWidth * CONTACT_COLUMNS;
    seriesCanvas.height = cellHeight * CONTACT_ROWS;
    seriesContext = seriesCanvas.getContext('2d', { willReadFrequently: true });
  }

  const frames = new Array(manifest.length);
  const units = [], series = [];
  // 「样片」：和接触表同一遍解码顺手抽出来的单帧（降采样到长边 720）。
  // 用途是报告里的并排对照 —— 光有 4x6 的接触表格子没法拿来跟自己的画面并排看，
  // 需要一张干净的单帧。同一遍解码产出，不额外解一次视频。
  const sampleEvery = Math.max(0.25, Number(options.sampleEverySeconds) || 1);
  const sampleLimit = Math.max(0, Number(options.sampleLimit) || 12);
  const stillFrames = [];
  const sampleCanvas = document.createElement('canvas');
  const SAMPLE_LONG_EDGE = 720;
  let nextSampleAt = -Infinity;
  let bytes = 0, decoded = 0;
  const contactIndices = mode === 'sheets' ? new Set(contactSampleIndices(sources)) : null;

  function addUnit(image, sourceFrames, width, height, type) {
    bytes += image.length;
    if (image.length > MAX_FRAME_DATAURL_CHARS || bytes > MAX_TOTAL_DATAURL_CHARS) {
      throw new Error('精读画面超过处理容量，请缩短选区。');
    }
    const first = sources[sourceFrames[0]];
    units.push({
      time: first.time, duration: first.duration, width, height, type,
      sourceFrames, image, kind: type === 'sheet' ? 'sheet' : 'detail',
    });
  }

  function flushSeriesStrip() {
    if (!seriesPending.length) return;
    const image = seriesContext.getImageData(0, 0, seriesCanvas.width, seriesCanvas.height);
    for (let cell = 0; cell < seriesPending.length; cell++) {
      const source = seriesPending[cell];
      // previousLuma 跨条带传递，这样条带边界处的两帧也能算出相对运动量。
      const ratio = scanRatios(
        image.data, seriesCanvas.width,
        (cell % CONTACT_COLUMNS) * cellWidth,
        Math.floor(cell / CONTACT_COLUMNS) * cellHeight,
        cellWidth, cellHeight,
        previousLuma,
      );
      previousLuma = ratio.luma;
      series.push({ f: source.sourceIndex, t: +source.time.toFixed(3), ba: ratio.ba, cw: ratio.cw, mo: ratio.mo });
    }
    seriesPending = [];
    seriesCell = 0;
    seriesContext.clearRect(0, 0, seriesCanvas.width, seriesCanvas.height);
  }

  function collectFrameRatio(source, frame) {
    if (!wantSeries) return;
    if (series.length + seriesPending.length >= SERIES_LIMIT) return;
    seriesContext.drawImage(
      frame,
      (seriesCell % CONTACT_COLUMNS) * cellWidth,
      Math.floor(seriesCell / CONTACT_COLUMNS) * cellHeight,
      cellWidth, cellHeight,
    );
    seriesPending.push(source);
    if (++seriesCell === CONTACT_CELLS) flushSeriesStrip();
  }

  function flushSheet() {
    if (!pageSources.length) return;
    addUnit(sheet.toDataURL('image/jpeg', SHEET_QUALITY), pageSources, sheet.width, sheet.height, 'sheet');
    pageSources = [];
    sheetContext.clearRect(0, 0, sheet.width, sheet.height);
  }

  /* ── 解码 ── */
  let decoderError = null;
  const decoder = new VideoDecoder({
    error: e => { decoderError = e; },
    output: frame => {
      try {
        const source = wanted.get(frame.timestamp);
        if (!source) return;
        if (frames[source.index]) throw new Error('解码器返回了重复帧。');
        if (mode === 'sheets' && source.index !== decoded) {
          throw new Error('显示帧顺序异常，无法制作连续接触表。');
        }
        if (mode === 'sheets') {
          collectFrameRatio(source, frame);
          if (options.emitSamples && stillFrames.length < sampleLimit && source.time + 0.000001 >= nextSampleAt) {
            const scale = Math.min(1, SAMPLE_LONG_EDGE / frame.displayWidth, SAMPLE_LONG_EDGE / frame.displayHeight);
            sampleCanvas.width = Math.max(1, Math.round(frame.displayWidth * scale));
            sampleCanvas.height = Math.max(1, Math.round(frame.displayHeight * scale));
            sampleCanvas.getContext('2d').drawImage(frame, 0, 0, sampleCanvas.width, sampleCanvas.height);
            stillFrames.push({
              time: +source.time.toFixed(3),
              image: sampleCanvas.toDataURL('image/jpeg', 0.78),
              width: sampleCanvas.width,
              height: sampleCanvas.height,
            });
            nextSampleAt = source.time + sampleEvery;
          }
          if (contactIndices.has(source.index)) {
            const cell = pageSources.length;
            const x = (cell % CONTACT_COLUMNS) * cellWidth;
            const y = Math.floor(cell / CONTACT_COLUMNS) * (cellHeight + SHEET_LABEL_HEIGHT);
            sheetContext.fillStyle = '#111';
            sheetContext.fillRect(x, y, cellWidth, cellHeight + SHEET_LABEL_HEIGHT);
            sheetContext.drawImage(frame, x, y, cellWidth, cellHeight);
            sheetContext.fillStyle = '#fff';
            sheetContext.font = '16px sans-serif';
            sheetContext.fillText('f' + source.sourceIndex + '  ' + source.time.toFixed(4) + 's', x + 5, y + cellHeight + 18);
            pageSources.push(source.index);
            if (pageSources.length === CONTACT_CELLS) flushSheet();
          }
          frames[source.index] = true;
        } else if (!selectedTimes.length || selectedTimes.some(t => Math.abs(t - source.time) < 0.000001)) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          canvas.getContext('2d').drawImage(frame, 0, 0);
          const image = canvas.toDataURL('image/jpeg', HD_QUALITY);
          bytes += image.length;
          if (image.length > MAX_FRAME_DATAURL_CHARS || bytes > MAX_TOTAL_DATAURL_CHARS) {
            throw new Error('关键帧数据超过处理容量，请缩短选区。');
          }
          frames[source.index] = { ...source, width: canvas.width, height: canvas.height, image, kind: 'detail', metrics: frameMetrics(canvas) };
        } else {
          frames[source.index] = true;
        }
        decoded++;
        onProgress(decoded, manifest.length);
      } catch (e) {
        decoderError = e;
      } finally {
        frame.close();
      }
    },
  });

  try {
    decoder.configure(config);
    for (const s of samples) {
      if (decoderError) throw decoderError;
      while (decoder.decodeQueueSize > 12) {
        await new Promise(resolve => decoder.addEventListener('dequeue', resolve, { once: true }));
        if (decoderError) throw decoderError;
      }
      decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: Math.round(s.cts / track.timescale * 1e6),
        duration: Math.round(s.duration / track.timescale * 1e6),
        data: s.data,
      }));
    }
    await decoder.flush();
    if (decoderError) throw decoderError;
    if (decoded !== manifest.length || frames.some(f => !f)) {
      throw new Error('解码覆盖不完整：' + decoded + '/' + manifest.length + ' 帧。');
    }

    if (mode === 'sheets') {
      flushSheet();
      flushSeriesStrip();
      units.sort((a, b) => a.time - b.time);
      units.forEach((f, index) => { f.index = index; });
      series.sort((a, b) => a.t - b.t);
      return {
        frames: units,
        samples: stillFrames,
        series,
        manifest: units.map(({ image, kind, ...rest }) => rest),
        sourceManifest: sources,
        width: track.video.width,
        height: track.video.height,
        bytes,
      };
    }

    const kept = frames.filter(f => f !== true);
    return {
      frames: kept,
      series,
      manifest: kept.map(({ image, kind, metrics, ...rest }) => rest),
      sourceManifest: sources,
      width: track.video.width,
      height: track.video.height,
      bytes,
    };
  } finally {
    try { decoder.close(); } catch {}
  }
}

/* ───────────────────────── 分批 ───────────────────────── */

/**
 * 接触表分批：≤24 个画面 / 每批 ≤10 MiB。
 * 单批过大的退路是**只压接触表**（降 quality），不改源帧时间、不改画面顺序、
 * 不改格子尺寸，也不动后续单独上传的高清证据。
 */
export async function oneContactBatch(frames, compress = async (frame, quality) => {
  const bitmap = await dataUrlBitmap(frame.image);
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  try { canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); }
  finally { bitmap.close(); }
  return { ...frame, image: canvas.toDataURL('image/jpeg', quality) };
}) {
  const maxBytes = 10 * 1024 * 1024;
  if (!frames.length) throw new Error('接触图为空，请重新选择评审范围。');
  if (frames.length > CONTACT_CELLS) return sequenceBatches(frames);
  if (new Blob([JSON.stringify(frames)]).size <= maxBytes) return [frames];
  let compact = frames;
  for (const quality of [0.6, 0.48]) {
    compact = [];
    for (const frame of frames) compact.push(await compress(frame, quality));
    if (new Blob([JSON.stringify(compact)]).size <= maxBytes) return [compact];
  }
  return sequenceBatches(compact);
}

/**
 * 通用分批：每批 ≤24 项 / ≤10 MiB。从第二批起带上前一批末尾 2 帧做衔接，
 * 让相邻批之间仍有连续画面可以对照。
 */
export function sequenceBatches(frames) {
  const batches = [];
  let start = 0;
  while (start < frames.length) {
    const overlap = start ? frames.slice(Math.max(0, start - 2), start) : [];
    const items = [...overlap];
    let bytes = JSON.stringify(items).length;
    while (start < frames.length && items.length < CONTACT_CELLS) {
      const frame = frames[start];
      const size = JSON.stringify(frame).length;
      if (bytes + size > 10 * 1024 * 1024) break;
      items.push(frame);
      bytes += size;
      start++;
    }
    if (items.length === overlap.length) {
      throw new Error('单帧或跨批衔接画面超过请求容量，请使用更短或较低分辨率的视频。');
    }
    batches.push(items);
  }
  return batches;
}

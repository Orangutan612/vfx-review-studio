/**
 * review.mjs —— 评审流程本体：证据整理 → 取证 → 终审 → 报告归一化。
 *
 * 两段式（这是这套流程最关键的设计，也是最值得保留的一点）：
 *   第一段「取证」：模型只看到接触表（连续运动）+ 全帧数值序列，任务是**挑时刻**，
 *                   不写建议。批与批之间独立，每批最多 24 格接触表，单次请求因此始终很小。
 *   第二段「终审」：把挑中的时刻以**原分辨率**抽出来，连同接触表与数值一起给模型，
 *                   这时才让它写修改建议。
 * 为什么非要这样：一次性把 450 帧塞给模型既超上下文、又把细节摊薄；而只给几张孤立
 * 截图，模型就看不出「运动」——接触表 + 关键帧放大，这两个必须都有。
 */
import { chat, chatJson, imagePart, textPart, LlmError } from './llm.mjs?v=1791745425776';
import { config } from './config.mjs?v=1791745425776';

/**
 * 特效评审准则（rubric）。
 *
 * 为什么要显式写死：不写的话，「标准」就等于模型预训练里的隐式审美 —— 每次都不一样、
 * 无法复现、也无法向作者解释「凭什么这么说」。写成可核对的条目之后：
 *   ① 每条判据都是能指着画面回答「是 / 否」的，而不是「感觉不够高级」；
 *   ② 模型必须逐个维度给结论 + 依据时刻，不能只挑好说的说；
 *   ③ 缺哪个维度会被程序补成 unknown 并标出来，赖不掉。
 *
 * 这些条目不是抄来的，是把游戏特效评审里反复出现的判断依据整理成可操作的形式。
 * 它们描述「怎么做才对」，不描述「哪个作品好」—— 后者是结果，不是准则。
 */
export const RUBRIC = [
  { key: 'form', label: '主形可读性', criteria: [
    '把画面缩到 10% 大小，还能一眼认出这条技能的形状吗？',
    '爆点最亮的那一帧，主形的边界还在吗（有没有被自己的亮部吃掉）？',
    '主形的剪影与同类技能有明显的区分度吗？',
  ] },
  { key: 'value', label: '明度结构', criteria: [
    '最亮的区域是不是落在主形上，也就是眼睛该看的地方？',
    '把画面转成灰度之后，前景 / 中景 / 背景还分得清吗？',
    '有没有「到处都在亮」导致整段没有视觉重心？',
  ] },
  { key: 'timing', label: '节奏与分段', criteria: [
    '起手 / 爆点 / 持续 / 消散四个阶段能分辨出来吗？',
    '有没有画面几乎不动的空档？（对照运动强度 mo 的空档检测）',
    '爆点是不是全段最强的时刻？',
    '收尾是干脆结束，还是拖着不散？（对照最后 0.5 秒的 mo）',
  ] },
  { key: 'continuity', label: '运动连贯性', criteria: [
    '拖尾和粒子是连续的，还是中途断裂、跳变？',
    '各层的运动方向一致吗，有没有互相打架？',
    '关键帧之间有没有「抽帧感」？',
  ] },
  { key: 'color', label: '色彩关系', criteria: [
    '主色与辅色的关系成立吗，还是一个颜色平均用力？',
    '转成灰度后层次还在吗（说明不是靠颜色硬撑）？',
    '亮部的色相有没有偏到不自然？',
  ] },
  { key: 'material', label: '材质与细节', criteria: [
    '是不是「先做形体、再加光」（形体成立才谈发光）？',
    '质感与作品风格（写实 / 风格化）一致吗？',
    '细节在远景下会不会糊成一团？',
  ] },
  { key: 'ending', label: '收尾与循环', criteria: [
    '消散是否彻底，有没有孤立的亮点残留？',
    '如果是循环 / 持续状态，首尾帧能接上吗？',
  ] },
  { key: 'robustness', label: '制作的可靠性', criteria: [
    '有没有大面积半透明叠加导致的发灰、发糊（性能风险的画面特征）？',
    '亮部有没有过曝到丢失细节？',
  ] },
];

function rubricBlock() {
  const lines = ['', '此外，你必须逐个核对下面这份《特效评审准则》，一条都不许跳过：'];
  for (const item of RUBRIC) {
    lines.push('【' + item.key + ' · ' + item.label + '】');
    for (const criterion of item.criteria) lines.push('  - ' + criterion);
  }
  lines.push('', '每个维度给出四选一的结论：pass（通过）/ warn（有隐患）/ fail（不通过）/ unknown（从画面里确实看不出来）。');
  lines.push('结论必须绑定具体时刻与画面依据。unknown 要在 evidence 里说清「为什么从画面看不出」，不许拿它当偷懒。');
  return lines.join('\n');
}

/** 报告写几条建议。 */
export const FEEDBACK_COUNTS = { low: 3, medium: 6, high: 10, ultra: 15 };
/** 对应允许抽出多少张原分辨率证据帧。 */
export const EVIDENCE_FRAMES = { low: 6, medium: 10, high: 16, ultra: 24 };
/** 推理深度 → 采样温度与输出上限。 */
const REASONING = {
  fast: { temperature: 0.25 },
  standard: { temperature: 0.35 },
  deep: { temperature: 0.5 },
};

// 输出预算 = 固定开销 + 每条建议的字数 × 条数。
// ⚠️ 实测教训：不要只按建议条数估。DeepSeek 的思考模式默认打开且强度是 high，
//    思维链与正文共用同一份 max_tokens。曾经用 6600 跑 6 条建议，思考就把额度吃光，
//    JSON 只写到 summary 前半句就被截断（finish_reason=length），报告直接生不出来。
const OUTPUT_OVERHEAD = 8000;   // 思考过程 + 摘要 + 做对了什么 + 证据边界
const PER_SUGGESTION = 1000;    // 一条建议（含可执行步骤）的正文

function outputBudget(count) {
  const wanted = OUTPUT_OVERHEAD + count * PER_SUGGESTION;
  return Math.max(4096, Math.min(config.maxOutputTokens, wanted));
}

const clampLevel = value => (FEEDBACK_COUNTS[value] ? value : 'medium');
const clampReasoning = value => (REASONING[value] ? value : 'fast');

/* ───────────────────────── 证据整理 ───────────────────────── */

const round = (n, d = 3) => Number.isFinite(n) ? +Number(n).toFixed(d) : null;

/**
 * 把逐帧数值序列与高清帧实算结果压成一段**给模型看的文本**。
 * 序列可能有 7200 条，不能整段丢过去；这里保留峰、均值与一条 0.5 秒粒度的粗曲线。
 */
export function buildEvidenceDigest(series = [], frames = [], range = { start: 0, end: 0 }) {
  const lines = [];
  const duration = Math.max(0, (range.end || 0) - (range.start || 0));
  lines.push('【选区】' + round(range.start) + 's — ' + round(range.end) + 's，共 ' + round(duration) + 's。');

  const points = Array.isArray(series) ? series.filter(p => Number.isFinite(p?.t)) : [];
  if (points.length) {
    const mean = key => round(points.reduce((sum, p) => sum + (Number(p[key]) || 0), 0) / points.length, 2);
    const peak = key => points.reduce((best, p) => (Number(p[key]) || 0) > (Number(best[key]) || 0) ? p : best, points[0]);
    const baPeak = peak('ba'), cwPeak = peak('cw');
    lines.push('【逐帧实算 · 覆盖每一帧，不是抽样】共 ' + points.length + ' 帧。');
    lines.push('- 亮饱和面积占比 ba：均值 ' + mean('ba') + '%，峰值 ' + round(baPeak.ba, 2) + '% @ ' + round(baPeak.t) + 's。');
    lines.push('- 白核占比 cw：均值 ' + mean('cw') + '%，峰值 ' + round(cwPeak.cw, 2) + '% @ ' + round(cwPeak.t) + 's。');

    const topBy = (key, n) => [...points].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, n)
      .map(p => round(p.t) + 's(' + round(p[key], 2) + '%)').join('、');
    lines.push('- 亮饱和最高的 8 个时刻：' + topBy('ba', 8));
    lines.push('- 白核最高的 8 个时刻：' + topBy('cw', 8));

    // 0.5 秒一格的粗曲线：让模型能看出整段的起伏形状。
    const bucket = Math.max(1, Math.ceil(points.length / 30));
    const profile = [];
    for (let i = 0; i < points.length; i += bucket) {
      const slice = points.slice(i, i + bucket);
      const ba = round(slice.reduce((s, p) => s + (Number(p.ba) || 0), 0) / slice.length, 1);
      const cw = round(slice.reduce((s, p) => s + (Number(p.cw) || 0), 0) / slice.length, 1);
      profile.push(round(slice[0].t, 1) + 's:ba' + ba + '/cw' + cw);
    }
    lines.push('- 全程轮廓（每格约 ' + round(bucket / 30, 2) + 's，ba/cw 为该段均值）：' + profile.join('  '));
  }

  const hd = (Array.isArray(frames) ? frames : []).filter(f => f?.metrics);
  if (hd.length) {
    lines.push('【原分辨率证据帧实算数值】');
    for (const frame of hd) {
      const m = frame.metrics;
      lines.push('- ' + round(frame.time) + 's：亮饱和 ' + m.brightSatPct + '%，白核 ' + m.corePct
        + '%，平均 V ' + m.meanV + '，最大 V ' + m.maxV
        + (Number.isFinite(m.layerGap) ? '，前景/背景灰度中位数 ' + m.fgLuma + '/' + m.bgLuma + '（差 ' + m.layerGap + '）' : '')
        + (m.centroid ? '，亮部质心 (' + m.centroid.x + ', ' + m.centroid.y + ')' : '') + '。');
    }
  }
  // ── 运动强度：把「节奏」从主观印象变成可对照的数据 ──
  const motion = points.filter(p => Number.isFinite(p.mo));
  if (motion.length > 2) {
    const peak = motion.reduce((best, p) => (p.mo > best.mo ? p : best), motion[0]);
    const mean = motion.reduce((sum, p) => sum + p.mo, 0) / motion.length;
    lines.push('- 运动强度 mo（与上一帧的平均灰度差，0-100）：均值 ' + mean.toFixed(2) + '，峰值 ' + peak.mo.toFixed(2) + ' @ ' + round(peak.t) + 's。');

    // 空档：连续 mo 低于峰值 12% 且超过 0.25 秒 —— 观感上就是「画面停住了」。
    const floor = Math.max(0.3, peak.mo * 0.12);
    const gaps = [];
    let gapStart = null;
    for (const p of motion) {
      if (p.mo < floor) { if (gapStart === null) gapStart = p.t; }
      else if (gapStart !== null) { if (p.t - gapStart >= 0.25) gaps.push([gapStart, p.t]); gapStart = null; }
    }
    if (gapStart !== null && motion[motion.length - 1].t - gapStart >= 0.25) gaps.push([gapStart, motion[motion.length - 1].t]);
    lines.push(gaps.length
      ? '- 空档检测：有 ' + gaps.length + ' 段画面几乎不动 —— ' + gaps.map(([a, b]) => round(a, 2) + '–' + round(b, 2) + 's（' + round(b - a, 2) + 's）').join('、') + '。'
      : '- 空档检测：没有超过 0.25 秒的画面停滞。');

    // 收尾：最后 0.5 秒还动不动，用来判断「收得干脆」还是「拖着不散」。
    const last = motion[motion.length - 1].t;
    const tail = motion.filter(p => p.t >= last - 0.5);
    const tailMean = tail.reduce((sum, p) => sum + p.mo, 0) / Math.max(1, tail.length);
    lines.push('- 收尾：最后 0.5 秒 mo 均值 ' + tailMean.toFixed(2) + '，相当于峰值的 ' + Math.round(tailMean / Math.max(0.01, peak.mo) * 100) + '%。');

    const bucket = Math.max(1, Math.ceil(motion.length / 30));
    const profile = [];
    for (let i = 0; i < motion.length; i += bucket) {
      const part = motion.slice(i, i + bucket);
      profile.push(round(part[0].t, 1) + 's:' + round(part.reduce((s, p) => s + p.mo, 0) / part.length, 1));
    }
    lines.push('- 运动轮廓（每格约 ' + round(bucket / 30, 2) + 's）：' + profile.join('  '));
  }

  lines.push('数值只描述亮度、面积与运动量，不能替代你对形态、色彩与层级关系的判断。');
  return lines.join('\n');
}

/* ───────────────────────── 提示词 ───────────────────────── */

const SELECT_SYSTEM = [
  '你是游戏特效（VFX）美术评审的取证助手，不是评审本人。',
  '你看到的是一段游戏特效视频的**接触表**：每页 4 列 × 6 行共 24 格，按时间从左到右、从上到下排列，',
  '每格画面下方印着源帧号与时间（形如 "f123  4.1000s"）。接触表是连续的，所以你能看到运动本身。',
  '',
  '你的任务：**挑出最值得放大到原分辨率再看的时刻**，不要写修改建议。',
  '',
  '优先挑：',
  '- 亮部或白核突然扩张、崩塌的瞬间（起手、爆点、消散、闪白）',
  '- 主形发生结构性变化的时刻（被中层或背景压住、边缘碎裂、形体糊成一团）',
  '- 运动节奏的转折点（加速、停顿、回弹、拖尾断裂）',
  '- 层级、颜色或材质关系明显不对的画面',
  '- 数值序列里 ba（亮饱和面积占比）或 cw（白核占比）的峰值时刻',
  '',
  '每个时刻都要能说出「放大后要看它的什么」。不要挑只差一点点、看不出区别的相邻帧。',
  '',
  '只输出 JSON，不要解释，不要 Markdown 代码块：',
  '{"frames":[{"time":4.1,"reason":"放大看爆点白核边缘是否把主形吃掉了"}],"note":"这批接触表里运动整体在做什么，一到两句"}',
].join('\n');

const SELECT_JSON_SHAPE = '{"frames":[{"time":数字(秒),"reason":"字符串"}],"note":"字符串"}';

const JUDGMENT_LABEL = {
  confirmed: '确认问题',
  experiment: '可选实验',
  preserve: '值得保留',
  pending: '待核验',
};

const REVIEW_SYSTEM = [
  '你是一位有十年经验的游戏特效（VFX）美术导师，正在给学生的作品写修改建议。',
  '你拿到的证据有三样：',
  '① 接触表 —— 按 1/30 秒一格、连续排列，可以读出完整的运动过程；',
  '② 若干张**原分辨率**关键帧 —— 每张标了时间，以及浏览器逐像素实算的数值；',
  '③ 一条覆盖**每一帧**的数值序列 —— ba 是亮饱和面积占比（V>190 且 S>70），cw 是白核占比（V>245），',
  '   mo 是运动强度（与上一帧的平均灰度差，0-100）。亮度只能说明「亮不亮」，mo 才能说明「动不动」，',
  '   节奏类的问题（空档、拖沓、爆点不够强）必须结合 mo 判断，不能只凭印象。',
  '',
  '写建议的铁律：',
  '1. 只谈你在画面里真的看得见的东西。不要臆测引擎参数、贴图、材质节点或 shader 写法。',
  '2. 每条建议必须绑定一个具体时刻 evidenceTime，并说清那一刻画面里发生了什么。',
  '3. 建议要能落地：改哪一层 → 怎么改 → 改完应该看到什么 → 怎么自己验证。',
  '4. 分清三件事：confirmed（确实有问题）、experiment（可以试试的方向）、preserve（做对了、别改坏）。',
  '5. 不要凑数。证据不足就少写，并在 limitations 里说清你看不到什么。',
  '7. 如果给了你「参考库标杆」（同样是接触表 + 数值），必须做**具体**对比：',
  '   说清标杆在某一刻怎么处理、你的作品在某一刻怎么处理、差在哪。不要写「建议多参考优秀作品」这种废话。',
  '   标杆如果没有解决某个问题，就直说，不要为了用上参考而硬凑。',
  '6. 用中文，说人话，不要堆术语。',
  '',
  '只输出 JSON，不要解释，不要 Markdown 代码块。',
].join('\n');

/** 报告 JSON 结构说明，直接拼进用户消息里。 */
function reportShape(count) {
  return [
    '输出结构（严格 JSON，字段名一字不差）：',
    '{',
    '  "score": {',
    '    "dimensions": [',
    '      { "key": "form（必须用下面那 8 个 key，一个都不能少）", "score": 8, "note": "为什么给这个分，不超过 30 字" }',
    '    ],',
    '    "strengths": ["最突出的 2-3 个优点，每条不超过 40 字"],',
    '    "weaknesses": ["最该改的 2-3 个问题，每条不超过 40 字"]',
    '  },',
    '  "summary": "整段作品的总体判断，3-5 句。先说做对了什么，再说最主要的问题。",',
    '  "p1_hint": "如果只改一处，该改哪里，一句话。",',
    '  "suggestions": [',
    '    {',
    '      "title": "这条建议的标题，不超过 20 字",',
    '      "prio": "P1 | P2 | P3（P1 = 最影响观感、优先改）",',
    '      "judgment": "confirmed | experiment | preserve | pending",',
    '      "dimension": "从这些里选一个：节奏 | 形体 | 层次 | 颜色 | 材质 | 构图 | 性能",',
    '      "evidenceTime": 4.1,',
    '      "comparisonTimes": [1.2, 4.1],',
    '      "screenshotDescription": "这一刻画面上是什么，便于读者对号入座",',
    '      "feedback": "你在这张图里看到了什么，它造成了什么观感影响",',
    '      "hypothesis": "为什么会这样，说明这是判断或假设",',
    '      "designIntent": "这一层原本应该承担什么作用",',
    '      "preserve": "改的时候必须保留什么",',
    '      "actions": ["按顺序的可执行步骤，一次只动一层"],',
    '      "expected": "改好后应该看到什么",',
    '      "verify": "怎么自己验证改对了"',
    '      "compareRef": "参考文件名（必须与上面给的名字一字不差；没有合适的就填空字符串）",',
    '      "compareTime": 2.0,',
    '      "compareWhy": "为什么拿这一刻来对照，不超过 40 字"',
    '    }',
    '  ],',
    '  "positive": ["做对了、值得保留并迁移到其他作品的做法"],',
    '  "limitations": ["这次判断的证据边界，比如看不到引擎参数、看不到帧率、某段画面过曝等"],',
    '  "benchmarks": [',
    '    { "name": "参考文件名（必须与上面给的标杆名一致；没有给参考时留空数组）", "takeaway": "从它身上学到的、可以迁移到你自己作品的一点，不超过 60 字" }',
    '  ],',
    '  "rubric": [',
    '    {',
    '      "key": "form（必须用上面给的 8 个 key，一个都不能少）",',
    '      "status": "pass | warn | fail | unknown",',
    '      "time": 1.23,',
    '      "evidence": "这一刻画面里看到了什么，不超过 50 字",',
    '      "fix": "不是 pass 时怎么写，不超过 50 字；pass 就填空字符串"',
    '    }',
    '  ]',
    '}',
    '',
    '评分要求：八个维度的 score 各给 0–10 分（可带一位小数）。',
    '打分要对得起后面的建议 —— 你指出问题的地方就该扣分，说做对了的地方就该给分，不要一律给中间分糊弄。',
    'strengths / weaknesses 各写 2-3 条，要具体（「爆点主形边界清楚」而不是「整体不错」）。',
    '',
    '要求：suggestions 写 ' + count + ' 条（证据不足可以少写，并在 limitations 说明原因）。',
    'evidenceTime 与 comparisonTimes 必须是上面证据里真实出现过的时间（秒），精度到 0.01s。',
    '',
    '篇幅硬要求（务必遵守，否则内容会被截断而失效）：',
    '- summary 不超过 200 字；p1_hint 不超过 40 字。',
    '- 每条建议里 feedback / hypothesis / designIntent / preserve / expected / verify 各自不超过 80 字，说重点，不要铺垫。',
    '- actions 写 2 到 4 步，每步不超过 40 字。',
    '- positive 与 limitations 各不超过 5 条，每条不超过 60 字。',
    '- 不要复述证据、不要重复图片里已经写明的时间与数值。',
    rubricBlock(),
  ].join('\n');
}

/* ───────────────────────── 两段式调用 ───────────────────────── */

function contextBlock(context = {}) {
  const lines = [];
  if (context.purpose) lines.push('作品内容：' + context.purpose);
  if (context.style) lines.push('特效风格：' + context.style);
  if (context.camera) lines.push('观看距离：' + context.camera);
  if (context.description) lines.push('作者自述：' + String(context.description).slice(0, 1500));
  if (context.concern) lines.push('这次最想解决的问题：' + String(context.concern).slice(0, 600));
  return lines.length ? lines.join('\n') : '（作者没有补充说明）';
}

/**
 * 第一段：一批接触表 → 值得放大细看的时刻。
 * @returns {Promise<{frames:{time:number,reason:string}[], note:string, usage:any}>}
 */
export async function selectEvidence({ sheets, series = [], context = {}, settings = {}, batchIndex = 0, batchCount = 1 }) {
  const level = clampLevel(settings.feedbackLevel);
  const want = EVIDENCE_FRAMES[level];
  const perBatch = Math.max(3, Math.ceil(want / Math.max(1, batchCount)));

  if (config.mock) return mockSelect({ sheets, series, perBatch, batchIndex });

  const digest = buildEvidenceDigest(series, [], { start: sheetStart(sheets), end: sheetEnd(sheets) });
  const content = [
    textPart(
      '这是第 ' + (batchIndex + 1) + ' / ' + batchCount + ' 批接触表，共 ' + sheets.length + ' 页。\n'
      + '本批覆盖时间范围：' + round(sheetStart(sheets)) + 's — ' + round(sheetEnd(sheets)) + 's。\n\n'
      + '【作品背景】\n' + contextBlock(context) + '\n\n'
      + '【逐帧数值（用于找峰值，不必逐条读）】\n' + digest + '\n\n'
      + '请挑出本批中最多 ' + perBatch + ' 个值得放大到原分辨率的时刻。时间必须来自接触表格子下方的标注。',
    ),
  ];
  sheets.forEach((sheet, index) => {
    content.push(textPart('第 ' + (index + 1) + ' 页接触表（4×6，每格下方是帧号与时间）：'));
    content.push(imagePart(sheet.image));
  });
  content.push(textPart('只输出这个 JSON 结构：' + SELECT_JSON_SHAPE));

  const { value, usage } = await chatJson({
    model: config.selectModel || config.model,
    messages: [
      { role: 'system', content: SELECT_SYSTEM },
      { role: 'user', content },
    ],
    temperature: 0.2,
    maxTokens: 6000,
  });

  return { frames: readSelectedTimes(value), note: typeof value?.note === 'string' ? value.note : '', usage };
}

function readSelectedTimes(value) {
  const list = Array.isArray(value?.frames) ? value.frames : Array.isArray(value) ? value : [];
  return list
    .map(item => ({
      time: Number(typeof item === 'number' ? item : item?.time),
      reason: typeof item?.reason === 'string' ? item.reason : '',
    }))
    .filter(item => Number.isFinite(item.time) && item.time >= 0)
    .map(item => ({ time: +item.time.toFixed(3), reason: item.reason }));
}

const sheetStart = sheets => sheets.length ? Math.min(...sheets.map(s => s.start ?? s.time ?? 0)) : 0;
const sheetEnd = sheets => sheets.length ? Math.max(...sheets.map(s => s.end ?? ((s.time ?? 0) + 0.8))) : 0;

/**
 * 第二段：全部证据 → 最终报告。
 */
export async function runReview({ sheets = [], frames = [], series = [], context = {}, settings = {}, range = {}, references = [] }) {
  const level = clampLevel(settings.feedbackLevel);
  const reasoning = clampReasoning(settings.reasoning);
  const count = settings.suggestionCount ?? FEEDBACK_COUNTS[level];

  if (config.mock) return mockReview({ frames, series, context, count, range });

  const digest = buildEvidenceDigest(series, frames, range);
  const content = [
    textPart(
      '【作品背景】\n' + contextBlock(context) + '\n\n'
      + '【逐帧数值序列】\n' + digest + '\n\n'
      + '下面是接触表（连续运动）与原分辨率关键帧（细节）。'
      + '接触表用于判断节奏与整体运动，原分辨率帧用于判断形体、层次与材质细节。',
    ),
  ];
  sheets.forEach((sheet, index) => {
    content.push(textPart('接触表第 ' + (index + 1) + ' / ' + sheets.length + ' 页（时间 ' + round(sheet.start) + 's — ' + round(sheet.end) + 's，每格下方是帧号与时间）：'));
    content.push(imagePart(sheet.image));
  });
  frames.forEach(frame => {
    const m = frame.metrics;
    content.push(textPart(
      '原分辨率关键帧 ' + round(frame.time) + 's'
      + (m ? '（实算：亮饱和 ' + m.brightSatPct + '%，白核 ' + m.corePct + '%，平均 V ' + m.meanV + '）' : ''),
    ));
    content.push(imagePart(frame.image));
  });
  // 参考库标杆：处理方式与作品完全一致（接触表 + 逐帧数值），
  // 所以模型做的是「接触表 vs 接触表」的公平对比，而不是「接触表 vs 记忆里的视频」。
  const usableReferences = (Array.isArray(references) ? references : [])
    .filter(item => item && Array.isArray(item.sheets) && item.sheets.length)
    .slice(0, 3);
  if (usableReferences.length) {
    content.push(textPart(
      '【参考库标杆】下面 ' + usableReferences.length + ' 段是你选的优秀片段，处理方式与你的作品完全一致'
      + '（接触表 + 逐帧实算数值），因此可以直接对照。请给出具体的对比结论，并写进 benchmarks 字段。',
    ));
    content.push(textPart(
      '写每条建议时，尽量挑一个最适合并排对照的参考时刻填进 compareRef / compareTime：'
      + '左半边是作者的画面，右半边就是那一刻的参考。挑不出合适的就都留空，不要硬凑。',
    ));
    usableReferences.forEach((item, index) => {
      const motion = (Array.isArray(item.series) ? item.series : []).filter(p => Number.isFinite(p.mo));
      const peak = motion.reduce((best, p) => (!best || p.mo > best.mo ? p : best), null);
      const sampleTimes = (Array.isArray(item.samples) ? item.samples : []).map(sample => sample.time);
      content.push(textPart(
        '标杆 ' + (index + 1) + '：' + String(item.name || '未命名').slice(0, 80)
        + (item.kind === 'image' ? '（静态参考图）' : '（片段 ' + round(item.range?.start) + '–' + round(item.range?.end) + 's'
          + (peak ? '，运动强度峰值 ' + peak.mo.toFixed(2) + ' @ ' + round(peak.t) + 's' : '') + '）')
        + (sampleTimes.length ? '。可用于并排对照的时刻：' + sampleTimes.map(t => round(t, 2) + 's').join(' / ') : '')
        + '：',
      ));
      // 每页接触表都标上它覆盖的时间段 —— 30 秒的参考会有好几页，
      // 不标时间的话模型没法说清「标杆在第几秒做了什么」。
      item.sheets.forEach((sheet, sheetIndex) => {
        const span = Number.isFinite(sheet.start) && Number.isFinite(sheet.end)
          ? '（' + round(sheet.start, 2) + '–' + round(sheet.end, 2) + 's）'
          : '';
        content.push(textPart('标杆 ' + (index + 1) + ' 的第 ' + (sheetIndex + 1) + ' / ' + item.sheets.length + ' 页接触表' + span + '：'));
        content.push(imagePart(sheet.image));
      });
    });
  }

  content.push(textPart(reportShape(count)));

  const { value, usage } = await chatJson({
    model: config.model,
    messages: [
      { role: 'system', content: REVIEW_SYSTEM },
      { role: 'user', content },
    ],
    temperature: REASONING[reasoning].temperature,
    maxTokens: outputBudget(count),
  });

  return { report: normalizeReport(value, { count, range, frames, references: usableReferences }), usage };
}

/* ───────────────────────── 归一化 ───────────────────────── */

const PRIOS = ['P1', 'P2', 'P3'];
const JUDGMENTS = ['confirmed', 'experiment', 'preserve', 'pending'];
const str = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const strList = (value, max = 12) => (Array.isArray(value) ? value.map(v => str(v, 1200)).filter(Boolean).slice(0, max) : []);

/**
 * 把模型输出收敛成渲染器能信任的结构：宁缺毋滥。
 * - 没有 title 的建议直接丢掉（渲染器无法定位它）
 * - evidenceTime 必须落在选区内，否则置空
 * - prio / judgment 一律回落到合法值
 */
export function normalizeReport(raw, { count = 6, range = {}, frames = [], references = [] } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const lo = Number.isFinite(range.start) ? range.start : 0;
  const hi = Number.isFinite(range.end) ? range.end : Infinity;
  const within = value => {
    const n = Number(value);
    return Number.isFinite(n) && n >= lo - 0.5 && n <= hi + 0.5 ? +n.toFixed(3) : null;
  };

  // 并排对照里出现的参考名必须是真实存在的
  const knownRefNames = new Set((Array.isArray(references) ? references : []).map(entry => String(entry?.name || '')).filter(Boolean));

  const suggestions = (Array.isArray(source.suggestions) ? source.suggestions : [])
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const title = str(item.title, 120);
      if (!title) return null;
      const times = Array.isArray(item.comparisonTimes) ? item.comparisonTimes : [];
      return {
        id: 'S' + (index + 1),
        title,
        prio: PRIOS.includes(item.prio) ? item.prio : (index === 0 ? 'P1' : 'P2'),
        judgment: JUDGMENTS.includes(item.judgment) ? item.judgment : 'confirmed',
        dimension: str(item.dimension, 20),
        evidenceTime: within(item.evidenceTime),
        comparisonTimes: [...new Set(times.map(within).filter(t => t !== null))].slice(0, 4),
        screenshotDescription: str(item.screenshotDescription, 400),
        feedback: str(item.feedback),
        hypothesis: str(item.hypothesis),
        designIntent: str(item.designIntent),
        preserve: str(item.preserve),
        actions: strList(item.actions, 8),
        expected: str(item.expected),
        verify: str(item.verify),
        // 并排对照：参考名必须对得上真实提供的参考，否则整条丢掉 ——
        // 否则报告里会冒出一个不存在的「参考作品」。
        compareRef: knownRefNames.has(str(item.compareRef, 120)) ? str(item.compareRef, 120) : '',
        compareTime: within(item.compareTime),
        compareWhy: str(item.compareWhy, 200),
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, count));
  // 没提供参考时，任何对照字段都不该存在
  if (!knownRefNames.size) for (const item of suggestions) { item.compareRef = ''; item.compareTime = null; item.compareWhy = ''; }

  const limitations = strList(source.limitations, 8);
  if (!limitations.length) {
    limitations.push('模型没有说明证据边界；画面之外的引擎参数、贴图与帧率均未参与判断。');
  }

  // 准则核对：模型漏填的维度一律补成 unknown。报告必须把 8 条都摆出来 ——
  // 缺一条就意味着那个维度压根没被核对过，不能让它悄悄消失。
  const RUBRIC_STATUS = ['pass', 'warn', 'fail', 'unknown'];
  const byKey = new Map();
  for (const item of (Array.isArray(source.rubric) ? source.rubric : [])) {
    if (!item || typeof item !== 'object') continue;
    const raw = str(item.key, 40);
    const match = RUBRIC.find(entry => entry.key === raw.toLowerCase() || entry.label === raw);
    if (!match || byKey.has(match.key)) continue;
    byKey.set(match.key, {
      key: match.key,
      status: RUBRIC_STATUS.includes(item.status) ? item.status : 'unknown',
      time: within(item.time),
      evidence: str(item.evidence, 300),
      fix: str(item.fix, 300),
    });
  }
  const rubric = RUBRIC.map(entry => byKey.get(entry.key)
    || { key: entry.key, status: 'unknown', time: null, evidence: '模型没有核对这个维度。', fix: '' });

  // 标杆对比：只有给了参考库内容才可能非空。名字必须对得上，对不上就丢掉 ——
  // 否则模型会编一个不存在的「参考作品」，那比没有更糟。
  const knownNames = new Set((Array.isArray(references) ? references : []).map(item => String(item?.name || '')).filter(Boolean));
  const benchmarks = (Array.isArray(source.benchmarks) ? source.benchmarks : [])
    .map(item => ({ name: str(item?.name, 120), takeaway: str(item?.takeaway, 300) }))
    // 严格：名字必须在本次真实提供的参考里。没给参考就一条都不留 ——
    // 否则模型会顺手编一个「参考作品」出来，那比没有参考更糟。
    .filter(item => item.name && item.takeaway && knownNames.has(item.name))
    .slice(0, 6);

  // 评分：逐维度取分，总分**由程序自己算**（平均 × 10），不采信模型自己给的总分 ——
  // 否则它可能给出「各维度 8 分但总分 60」这种自相矛盾的东西。
  const dimSource = Array.isArray(source.score?.dimensions) ? source.score.dimensions : [];
  const dimByKey = new Map();
  for (const entry of dimSource) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = str(entry.key, 40);
    const match = RUBRIC.find(item => item.key === raw.toLowerCase() || item.label === raw);
    if (!match || dimByKey.has(match.key)) continue;
    const value = Number(entry.score);
    dimByKey.set(match.key, {
      key: match.key,
      label: match.label,
      score: Number.isFinite(value) ? Math.max(0, Math.min(10, Math.round(value * 10) / 10)) : null,
      note: str(entry.note, 200),
    });
  }
  const dimensions = RUBRIC.map(entry => dimByKey.get(entry.key)
    || { key: entry.key, label: entry.label, score: null, note: '' });
  const graded = dimensions.filter(entry => entry.score !== null);
  const total = graded.length ? Math.round(graded.reduce((sum, entry) => sum + entry.score, 0) / graded.length * 10) : null;
  const grade = total === null ? '' : total >= 85 ? '优秀' : total >= 70 ? '良好' : total >= 55 ? '及格' : '待改进';
  const score = {
    total, grade, dimensions,
    strengths: strList(source.score?.strengths, 5),
    weaknesses: strList(source.score?.weaknesses, 5),
  };

  const maxBa = frames.reduce((best, f) => Math.max(best, f?.metrics?.brightSatPct || 0), 0);
  return {
    score,
    rubric,
    benchmarks,
    summary: str(source.summary, 2000) || '模型没有给出总体判断。',
    p1_hint: str(source.p1_hint, 300),
    suggestions,
    positive: strList(source.positive, 8),
    limitations,
    coverage: {
      sheets: 0,
      hdFrames: frames.length,
      maxBrightSatPct: +maxBa.toFixed(2),
    },
  };
}

/* ───────────────────────── 离线演示模式 ───────────────────────── */

function peakTimes(series, n) {
  const points = (Array.isArray(series) ? series : []).filter(p => Number.isFinite(p?.t));
  if (!points.length) return [];
  const scored = points.map(p => ({ ...p, score: (Number(p.ba) || 0) + (Number(p.cw) || 0) * 1.5 }));
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const picked = [];
  for (const point of sorted) {
    if (picked.every(t => Math.abs(t - point.t) > 0.35)) picked.push(point.t);
    if (picked.length >= n) break;
  }
  return picked.sort((a, b) => a - b);
}

async function mockSelect({ sheets, series, perBatch }) {
  return {
    frames: peakTimes(series, perBatch).map(t => ({ time: +t.toFixed(3), reason: '离线演示：亮度峰值处，适合放大看主形边缘。' })),
    note: '离线演示模式：本批接触表已收到 ' + sheets.length + ' 页，未调用模型。',
    usage: null,
  };
}

async function mockReview({ frames, series, context, count, range }) {
  const peaks = peakTimes(series, 6);
  const primary = peaks[0] ?? frames[0]?.time ?? 0;
  const secondary = peaks[1] ?? primary + 0.3;
  const library = [
    {
      title: '爆点白核扩张过快，主形被自身亮部吃掉',
      prio: 'P1', judgment: 'confirmed', dimension: '层次',
      evidenceTime: primary, comparisonTimes: [secondary],
      screenshotDescription: '爆点后第一帧，白色核心几乎铺满主形轮廓',
      feedback: '这一刻画面里最亮的部分已经盖住了主形的边界，读者先看到一片白，再看不出这个技能的形状是什么。',
      hypothesis: '推测是亮部叠加时没有给主形留出可读的暗边，或者是亮部贴图的衰减太慢。',
      designIntent: '爆点这一层应该把能量感推上去，同时让主形的轮廓仍然是全场最清楚的形状。',
      preserve: '爆点瞬间的体积感与向外扩张的方向感。',
      actions: ['把白核的峰值面积压到主形投影面积的六成以内，先在爆点后 0.05s 处试。', '给主形补一圈宽度约为主形短边 3% 的暗边，让它在最亮的时刻仍然有边界。', '让亮部的衰减提前 0.1s 开始，把"最亮"和"最大"错开。'],
      compareRef: '参考库示例（离线演示）.mp4',
      compareTime: 1.15,
      compareWhy: '它在爆点前留了一帧静止再炸，蓄力感是这么来的，和你的起手正好对着看。',
      expected: '爆点仍然亮，但能一眼看出主形是什么形状，暗边把形体勾出来。',
      verify: '把爆点前后 0.3s 拉成连续帧，逐帧问自己"这一帧的形状是什么"，如果答不出来就还没改好。',
    },
    {
      title: '消散阶段的拖尾断续，收尾显得脏',
      prio: 'P2', judgment: 'confirmed', dimension: '节奏',
      evidenceTime: secondary,
      screenshotDescription: '消散中段，拖尾出现明显断裂',
      feedback: '消散时拖尾在画面里断成几截，收尾看起来不干净，像是有几块残留没化掉。',
      hypothesis: '可能是拖尾的寿命被设成了固定值，粒子不是按同一节奏退场。',
      designIntent: '消散要体现能量耗尽的过程，节奏上应该是越来越快、越来越淡。',
      preserve: '消散的整体时长和向外扩散的方向。',
      actions: ['把拖尾粒子的寿命改成随生成时间递减，越晚生成的越短。', '给最后 0.2s 加一条整体透明度曲线，让所有残留同时退干净。'],
      expected: '消散从外到内、由慢到快收敛成一个点，没有零散残留。',
      verify: '逐帧看最后 0.5s，确认没有哪一帧还留着孤立的亮点。',
    },
    {
      title: '起手阶段的预备动作缺少蓄力感',
      prio: 'P2', judgment: 'experiment', dimension: '节奏',
      evidenceTime: Math.max(0, primary - 0.4),
      screenshotDescription: '起手前，画面变化很小',
      feedback: '起手前这一段时间亮度几乎没有变化，视觉上是"什么都没有"，蓄力的感觉出不来。',
      hypothesis: '可能把能量都堆在了爆点，起手只做了静态的形变。',
      designIntent: '起手要让玩家预感到"要发生什么"，给爆点做铺垫。',
      preserve: '起手的总时长，不要拖慢技能手感。',
      actions: ['在起手阶段加入向内收缩的微弱亮度聚集，幅度控制在 peak 的两成以内。', '起手末帧做一个 1-2 帧的静止停顿，再进入爆点。'],
      expected: '起手时能看出能量在往中心聚集，爆点来得更有冲击力。',
      verify: '把起手到爆点连起来看，是否产生"憋一下再炸"的感觉。',
    },
    {
      title: '亮部质心偏离主形中心',
      prio: 'P3', judgment: 'experiment', dimension: '构图',
      evidenceTime: peaks[2] ?? primary,
      screenshotDescription: '亮部集中在画面上方，主形重心偏移',
      feedback: '最亮的部分集中在主形轮廓之外的一侧，读者视线会被拉走。',
      hypothesis: '可能是附加光效的位置没有跟随主形质心。',
      designIntent: '亮部的位置应该服务于主形，让视线停在形体上。',
      preserve: '亮部的方向性，不要改成四周均匀发光。',
      actions: ['把附加光效的枢轴对齐主形的亮部质心，允许有小的偏移但不越过轮廓。'],
      expected: '视线落在主形上，亮部成为形体的强调而不是干扰。',
      verify: '眯眼看画面，最亮的那一点是否落在你能认出的形状上。',
    },
    {
      title: '颜色关系：中间调偏灰，前后层区分不足',
      prio: 'P3', judgment: 'pending', dimension: '颜色',
      evidenceTime: peaks[3] ?? primary,
      screenshotDescription: '中层与背景的明度接近',
      feedback: '中层和背景的明度拉不开，中段看起来平，层次被压扁。',
      hypothesis: '推测中层没有做足够的明度区分，只靠颜色差异，在远景下不够。',
      designIntent: '中层应该承托主形，同时和背景分清前后。',
      preserve: '现有的色相搭配，不要换配色。',
      actions: ['先只做一件事：把中层的明度整体压暗或提亮一档，看层次是否打开。'],
      expected: '中段能看出前后两层，不再糊成一片。',
      verify: '把画面转成灰度再看，如果层次还在，说明明度关系是对的。',
    },
    {
      title: '做对了：主形的轮廓一直是可读的',
      prio: 'P3', judgment: 'preserve', dimension: '形体',
      evidenceTime: primary,
      screenshotDescription: '全段主形轮廓清晰',
      feedback: '整段里主形的外轮廓始终能认出来，这是很多同类作品做不到的。',
      hypothesis: '可能是有意给主形保留了暗边与形状上的简化。',
      designIntent: '主形是这条特效的信息载体，任何时候都应该第一个被认出来。',
      preserve: '主形的轮廓可读性与现有剪影。',
      actions: ['后续加亮部、加粒子时，都用"主形是否还能一眼认出"作为验收标准。'],
      expected: '任何修改之后主形依然是最清楚的那个形状。',
      verify: '把画面缩到 10% 大小，还能不能认出主形。',
    },
  ];

  return {
    report: normalizeReport({
      summary: '（离线演示报告）整段作品的运动方向与主形轮廓是成立的，爆点能量也够。'
        + '目前最影响观感的是爆点处白核把主形吃掉，以及消散收尾不够干净。'
        + '下面的建议按优先级排列，每一步都可以单独验证。',
      p1_hint: '先压爆点白核的面积，让主形在最亮的时刻仍然有可读的边界。',
      suggestions: library.slice(0, count),
      score: {
        dimensions: [
          { key: 'form', score: 4, note: '爆点白核把主形吃掉了' },
          { key: 'value', score: 5, note: '最亮处偏离主形' },
          { key: 'timing', score: 6, note: '起手到爆点之间有空档' },
          { key: 'continuity', score: 7, note: '消散中段拖尾有断裂' },
          { key: 'color', score: 7, note: '主辅色关系成立' },
          { key: 'material', score: 8, note: '先做形体再加光，顺序对' },
          { key: 'ending', score: 5, note: '收尾有孤立亮点残留' },
          { key: 'robustness', score: 6, note: '亮部略有过曝' },
        ],
        strengths: ['主形轮廓从起手到消散都能认出来', '爆点的能量方向明确、有冲击力', '整体时长控制得当，不拖沓'],
        weaknesses: ['爆点白核面积过大，把主形边界吃掉了', '消散收尾有孤立亮点残留', '最亮处偏离主形，视线被拉走'],
      },
      positive: ['主形轮廓全程可读', '爆点的能量方向明确', '消散的整体时长不拖沓'],
      rubric: [
        { key: 'form', status: 'fail', time: primary, evidence: '爆点后白核几乎铺满主形轮廓，形状认不出来', fix: '把白核峰值面积压到主形投影的六成以内' },
        { key: 'value', status: 'fail', time: primary, evidence: '最亮的区域超出主形，视线被拉到轮廓外', fix: '让亮部落在主形质心上' },
        { key: 'timing', status: 'warn', time: secondary, evidence: '起手到爆点之间有一段几乎没有变化', fix: '起手末帧做 1-2 帧静止停顿再进爆点' },
        { key: 'continuity', status: 'warn', time: secondary, evidence: '消散中段拖尾断成几截', fix: '拖尾寿命随生成时间递减，末段统一淡出' },
        { key: 'color', status: 'unknown', time: null, evidence: '离线演示没有真实画面，无法判断色彩关系', fix: '' },
        { key: 'material', status: 'pass', time: primary, evidence: '形体先立住再加光，顺序是正确的', fix: '' },
        { key: 'ending', status: 'warn', time: secondary, evidence: '收尾阶段仍有孤立亮点残留在画面上', fix: '给最后 0.2s 加整体透明度曲线' },
        { key: 'robustness', status: 'unknown', time: null, evidence: '看不到引擎参数，无法判断叠加层数与性能', fix: '' },
      ],
      limitations: ['这是 LLM_MOCK=1 的离线演示报告，没有真的看过你的视频；配置好 API Key 后会换成真实评审。'],
      benchmarks: [
        { name: '参考库示例（离线演示）.mp4', takeaway: '它在爆点前留了一帧静止再炸，蓄力感是这么来的 —— 你可以对照自己的 3.5–4.5s 空档试试。' },
        { name: '参考库示例（离线演示）.mp4', takeaway: '它的消散是整体匀速淡出，没有孤立残留，和你的收尾可以比一比。' },
      ],
    }, { count, range, frames, references: [{ name: '参考库示例（离线演示）.mp4' }] }),
    usage: null,
  };
}

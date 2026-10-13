/**
 * report-document.js —— 把评审报告渲染成 HTML，并支持导出成单文件。
 * 所有图片都是 data URL，所以导出的 HTML 自带全部证据截图，不依赖任何外部资源。
 */

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const timeLabel = t => (Number.isFinite(Number(t)) ? Number(t).toFixed(2) + ' s' : '');
const GROUP_NUM = { P1: '①', P2: '②', P3: '③' };
const GROUP_LABEL = {
  P1: '优先处理 · 最影响观感', P2: '建议处理 · 拉开品质', P3: '锦上添花 · 有余力再动',
};
const JUDGMENT_LABEL = { confirmed: '确认问题', experiment: '可选实验', preserve: '值得保留', pending: '待核验' };
const GLYPH = index => String.fromCharCode(65 + (index % 26));

/** 时间链接：站内可以点击跳到对应画面。 */
function timeLink(time, label, interactive) {
  const text = escapeHTML(label);
  return interactive && Number.isFinite(Number(time))
    ? '<button class="time-link" type="button" data-time="' + Number(time) + '">' + text + '</button>'
    : '<span>' + text + '</span>';
}

/* ───────────────────────── 亮度轨迹图 ───────────────────────── */

/**
 * 全帧亮度轨迹：ba 画成面积（蓝），cw 画成折线（橙）。
 * 纵轴是「画面里有多大比例的像素属于这一档亮度」，不是绝对亮度。
 */
export function renderTrajectory(series, range = {}) {
  const points = (Array.isArray(series) ? series : []).filter(p => Number.isFinite(p?.t));
  if (points.length < 2) {
    return '<section class="report-traj"><p class="report-note">没有足够的逐帧数值来绘制轨迹。</p></section>';
  }
  const W = 960, H = 280, L = 56, R = 18, T = 20, B = 40;
  const lo = Number.isFinite(range.start) ? range.start : points[0].t;
  const hi = Number.isFinite(range.end) ? range.end : points[points.length - 1].t;
  const span = Math.max(0.001, hi - lo);
  const maxValue = Math.max(1, ...points.map(p => Math.max(Number(p.ba) || 0, Number(p.cw) || 0)));
  const px = t => L + (t - lo) / span * (W - L - R);
  const py = v => H - B - (v / maxValue) * (H - B - T);

  const baPath = points.map((p, i) => (i ? 'L' : 'M') + px(p.t).toFixed(1) + ' ' + py(Number(p.ba) || 0).toFixed(1)).join('');
  const area = baPath + 'L' + px(points[points.length - 1].t).toFixed(1) + ' ' + (H - B) + 'L' + px(points[0].t).toFixed(1) + ' ' + (H - B) + 'Z';
  const cwLine = points.map(p => px(p.t).toFixed(1) + ',' + py(Number(p.cw) || 0).toFixed(1)).join(' ');

  const ticks = [];
  const tickCount = 6;
  for (let i = 0; i <= tickCount; i++) {
    const t = lo + span * i / tickCount;
    const x = px(t);
    ticks.push('<line x1="' + x.toFixed(1) + '" y1="' + (H - B) + '" x2="' + x.toFixed(1) + '" y2="' + (H - B + 5) + '" style="stroke:var(--traj-axis)"/>');
    ticks.push('<text x="' + x.toFixed(1) + '" y="' + (H - B + 20) + '" text-anchor="middle" font-size="11" style="fill:var(--traj-text)">' + t.toFixed(2) + 's</text>');
  }
  for (let i = 0; i <= 4; i++) {
    const v = maxValue * i / 4;
    const y = py(v);
    ticks.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '" style="stroke:var(--traj-grid)" stroke-dasharray="3 4"/>');
    ticks.push('<text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#667085">' + v.toFixed(1) + '%</text>');
  }

  const baPeak = points.reduce((best, p) => (Number(p.ba) || 0) > (Number(best.ba) || 0) ? p : best, points[0]);
  const cwPeak = points.reduce((best, p) => (Number(p.cw) || 0) > (Number(best.cw) || 0) ? p : best, points[0]);
  const mark = (point, value, color, label) => {
    const x = px(point.t), y = py(value);
    const anchor = x > L + (W - L - R) * 0.72 ? 'end' : 'start';
    return '<line x1="' + x.toFixed(1) + '" y1="' + y.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + (H - B) + '" style="stroke:' + color + '" stroke-width="1" stroke-dasharray="3 3" opacity=".5"/>'
      + '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.6" style="fill:' + color + '"/>'
      + '<text x="' + (x + (anchor === 'end' ? -6 : 6)).toFixed(1) + '" y="' + (y - 7).toFixed(1) + '" text-anchor="' + anchor + '" font-size="11.5" font-weight="600" fill="' + color + '">' + escapeHTML(label) + '</text>';
  };
  const marks = mark(baPeak, Number(baPeak.ba) || 0, 'var(--traj-ba)', '亮饱和峰 ' + (Number(baPeak.ba) || 0).toFixed(2) + '% · ' + Number(baPeak.t).toFixed(2) + 's')
    + (Math.abs(px(baPeak.t) - px(cwPeak.t)) < 130 ? '' : mark(cwPeak, Number(cwPeak.cw) || 0, 'var(--traj-cw)', '白核峰 ' + (Number(cwPeak.cw) || 0).toFixed(2) + '% · ' + Number(cwPeak.t).toFixed(2) + 's'));

  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="全片亮度与面积逐帧轨迹">'
    + '<rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - B - T) + '" style="fill:var(--traj-bg)"/>'
    + ticks.join('')
    + '<path d="' + area + '" style="fill:var(--traj-ba);stroke:var(--traj-ba)" fill-opacity=".2" stroke-width="1.4" stroke-linejoin="round"/>'
    + '<polyline points="' + cwLine + '" fill="none" style="stroke:var(--traj-cw)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>'
    + marks
    + '</svg>';

  return '<section class="report-traj">'
    + '<div class="traj-legend">'
    + '<span><i style="background:#2f6fed;opacity:.45"></i>亮饱和面积占比（V&gt;190 且 S&gt;70 的像素百分比）</span>'
    + '<span><i style="background:#e8590c"></i>白核占比（V&gt;245）</span>'
    + '<span>两条线的尖峰，就是注意力被拉走的时刻</span></div>'
    + svg
    + '<p class="report-note"><b>怎么读</b>：纵轴是「画面里有多大比例的像素属于这一档亮度」，不是绝对亮度。'
    + '亮饱和面积越大越抢眼，白核是其中最刺眼的一小撮。两条线同时冲高、又都远离主形时，主形就会被自己的中层或背景压住 —— '
    + '这是单看几张截图最难发现的一类问题。数值在提交前由浏览器逐帧实算，覆盖选区内每一帧，不是抽样估算。</p>'
    + '</section>';
}

/* ───────────────────────── 建议卡片 ───────────────────────── */

function frameFigure(image, alt, caption, interactive, time) {
  if (!image) return '';
  const link = interactive && Number.isFinite(Number(time))
    ? '<button class="time-link tiny" type="button" data-time="' + Number(time) + '">跳到这一刻</button>' : '';
  return '<figure class="shot"><img src="' + image + '" alt="' + escapeHTML(alt || '') + '" loading="lazy"/>'
    + (caption ? '<figcaption><span>' + escapeHTML(caption) + '</span>' + link + '</figcaption>' : '') + '</figure>';
}

function card(item, index, frames, interactive, references) {
  // 并排对照：左=作者画面，右=参考里最适合对比的那一刻。
  // 参考样片按可选时刻抽取，这里取最接近的那张；差太多就老实不显示，不硬凑。
  const buildCompare = () => {
    if (!item.compareRef || !Number.isFinite(Number(item.compareTime))) return '';
    const reference = (references || []).find(entry => entry.name === item.compareRef);
    if (!reference) return '';
    const left = (frames || []).reduce((best, frame) => (!best || Math.abs(frame.time - item.evidenceTime) < Math.abs(best.time - item.evidenceTime)) ? frame : best, null);
    const pool = reference.kind === 'image' ? (reference.sheets || []) : (reference.samples || []);
    if (!left || !pool.length) return '';
    let right = pool[0];
    if (reference.kind !== 'image') {
      right = pool.reduce((best, sample) => Math.abs(sample.time - item.compareTime) < Math.abs(best.time - item.compareTime) ? sample : best, pool[0]);
      if (Math.abs(right.time - item.compareTime) > 0.75) return '';
    }
    const rightCaption = reference.kind === 'image'
      ? '参考图 · ' + reference.name
      : (() => {
          // ⚠ 必须显示「原片时间」：right.time 是选区内的相对时间（从选区起点算），
          // 否则会出现「选了 12–40 秒，报告却写约 0.00s」这种看着像出错的情况。
          const rel = Number(right.time) || 0;
          const seg = reference.range || {};
          const abs = Number.isFinite(seg.start) ? seg.start + rel : rel;
          const trimmed = Number.isFinite(seg.start) && seg.start > 0.05;
          return '参考《' + reference.name + '》 · 原片 ' + abs.toFixed(2) + 's'
            + (trimmed ? '（所选区间 ' + seg.start.toFixed(1) + '–' + Number(seg.end).toFixed(1) + 's 内 ' + rel.toFixed(2) + 's）' : '');
        })();
    return '<div class="compare">'
      + frameFigure(left.image, '你的作品', '你的作品 · 约 ' + timeLabel(item.evidenceTime), interactive, item.evidenceTime)
      + '<div class="compare-tag" aria-hidden="true">对照</div>'
      + frameFigure(right.image, '参考画面', rightCaption, false, undefined)
      + '</div>'
      + (item.compareWhy ? '<p class="compare-why"><strong>为什么拿它对照</strong>' + escapeHTML(item.compareWhy) + '</p>' : '');
  };
  const frameAt = time => Number.isFinite(Number(time))
    ? frames.reduce((best, f) => (!best || Math.abs(f.time - time) < Math.abs(best.time - time)) ? f : best, null)
    : null;
  const match = t => {
    const frame = frameAt(t);
    return frame && Math.abs(frame.time - t) <= 0.08 ? frame : null;
  };

  const figures = [];
  const main = match(item.evidenceTime);
  if (main) {
    const caption = '约 ' + timeLabel(item.evidenceTime) + (item.screenshotDescription ? ' · ' + item.screenshotDescription : '');
    figures.push(frameFigure(main.image, item.screenshotDescription || '作品画面', caption, interactive, item.evidenceTime));
  }
  for (const time of item.comparisonTimes || []) {
    if (Number.isFinite(Number(item.evidenceTime)) && Math.abs(time - item.evidenceTime) < 0.02) continue;
    const frame = match(time);
    if (frame) figures.push(frameFigure(frame.image, '对照画面 ' + timeLabel(time), '同片另一时刻 · 约 ' + timeLabel(time), interactive, time));
  }

  const body = [];
  if (item.feedback) body.push('<p><strong>画面里看到了什么</strong>' + escapeHTML(item.feedback) + '</p>');
  if (item.hypothesis) body.push('<p><strong>为什么会这样</strong>' + escapeHTML(item.hypothesis) + '</p>');
  if (item.designIntent) body.push('<p><strong>这一层原本该做什么</strong>' + escapeHTML(item.designIntent) + '</p>');
  if (item.preserve) body.push('<p><strong>改的时候必须保留</strong>' + escapeHTML(item.preserve) + '</p>');
  if (item.actions?.length) {
    body.push('<h4>按顺序改，一次只动一层</h4><ol class="report-actions">'
      + item.actions.map(step => '<li>' + escapeHTML(step) + '</li>').join('') + '</ol>');
  }
  if (item.expected) body.push('<p><strong>改好应该看到</strong>' + escapeHTML(item.expected) + '</p>');
  if (item.verify) body.push('<p><strong>怎么自己验证</strong>' + escapeHTML(item.verify) + '</p>');

  const at = [
    Number.isFinite(Number(item.evidenceTime)) ? timeLink(item.evidenceTime, '约 ' + timeLabel(item.evidenceTime), interactive) : '',
    item.judgment ? escapeHTML(JUDGMENT_LABEL[item.judgment] || item.judgment) : '',
  ].filter(Boolean).join(' · ');

  return '<article class="report-card" id="suggestion-' + (index + 1) + '">'
    + '<div class="card-heading">'
    + '<span class="pill ' + escapeHTML((item.prio || 'p3').toLowerCase()) + '">' + escapeHTML(item.prio || 'P3') + '</span>'
    + '<span class="cnum">' + GLYPH(index) + '</span>'
    + '<h3>' + escapeHTML(item.title) + (item.dimension ? ' <span class="dim">' + escapeHTML(item.dimension) + '</span>' : '') + '</h3>'
    + (at ? '<span class="at">' + at + '</span>' : '')
    + '</div>'
    + (figures.length ? '<div class="evrow">' + figures.join('') + '</div>' : '')
    + buildCompare()
    + body.join('')
    + '</article>';
}

/* ───────────────────────── 评分板块 ───────────────────────── */

/** 分数落到哪一档。用于决定配色，不让 4 分和 9 分看起来一样。 */
// 阈值必须和提示词里的评分锚点一致（90/70/50/30），否则颜色和文字标签会互相打架
const scoreLevel = value => value >= 90 ? 'great' : value >= 70 ? 'good' : value >= 50 ? 'pass' : 'weak';
const barLevel = value => value >= 8 ? 'great' : value >= 6 ? 'good' : value >= 4 ? 'pass' : 'weak';

/**
 * 报告最上方的那块「总评」。
 * 目的很直接：让人一眼看到哪儿好、哪儿差，然后愿意往下读具体建议。
 */
export function renderScore(score) {
  if (!score || !Number.isFinite(Number(score.total))) return '';
  const total = Number(score.total);
  const dimensions = Array.isArray(score.dimensions) ? score.dimensions : [];
  const dims = dimensions.map(item => {
    const value = Number(item.score);
    const has = Number.isFinite(value);
    return '<div class="score-row">'
      + '<span class="score-row-label">' + escapeHTML(item.label || item.key || '') + '</span>'
      + '<span class="score-track"><span class="score-fill ' + (has ? barLevel(value) : 'none')
        + '" style="width:' + (has ? Math.max(2, Math.min(100, value * 10)) : 0) + '%"></span></span>'
      + '<span class="score-row-value">' + (has ? value : '—') + '</span>'
      + (item.note ? '<span class="score-row-note">' + escapeHTML(item.note) + '</span>' : '')
      + '</div>';
  }).join('');

  const list = (items, cls) => (Array.isArray(items) && items.length)
    ? '<ul>' + items.map(text => '<li>' + escapeHTML(text) + '</li>').join('') + '</ul>'
    : '<p class="score-empty">这次没有足够证据支撑这一类结论。</p>';

  return '<section class="report-score">'
    + '<div class="score-top">'
    + '<div class="score-badge ' + scoreLevel(total) + '">'
    + '<span class="score-num">' + total + '</span>'
    + '<span class="score-max">/ 100</span>'
    + '<span class="score-grade">' + escapeHTML(scoreBand(total) || score.grade || '') + '</span>'
    + '</div>'
    + '<div class="score-dims">' + dims + '</div>'
      + '<p class="score-standard">评分标准：<b>游戏特效（VFX）美术</b> —— 先认意图（类型 / 效果 / 节奏结构）再判执行；'
        + '闪白过曝、静止凝视、光雾叠加、余韵等属于这个领域的常规语法，<b>只有在与意图冲突时才算缺陷</b>。</p>'
      + (score.counts ? '<p class="score-basis">判定依据：<b>' + score.counts.pass + '</b> 项通过 · <b>'
        + score.counts.warn + '</b> 项有隐患 · <b>' + score.counts.fail + '</b> 项不通过'
        + (score.counts.unknown ? ' · ' + score.counts.unknown + ' 项看不清' : '')
        + '　（总分由这些结论推导 —— 判定有异议看这里，不是拍脑袋给的数字）</p>' : '')
    + '</div>'
    + '<div class="score-lists">'
    + '<div class="score-list good"><h4>做对了什么<span>这些已经成立，改别的地方时别弄坏</span></h4>' + list(score.strengths, 'good') + '</div>'
    + '<div class="score-list bad"><h4>最该改什么<span>按下面的建议逐条处理</span></h4>' + list(score.weaknesses, 'bad') + '</div>'
    + '</div>'
    + '</section>';
}


/** 分数段：把数字翻译成"什么水平"，报告里直接写出来，别让人对着 51 分猜。 */
function scoreBand(total) {
  if (!Number.isFinite(total)) return '';
  if (total >= 90) return '商业上线水准';
  if (total >= 70) return '专业可用';
  if (total >= 50) return '合格偏上';
  if (total >= 30) return '问题明显';
  return '基本没成立';
}

/* ───── 报告主体 ───────────────────────── */

export function renderReport(report, frames = [], options = {}) {
  const interactive = options.interactive !== false;
  const items = Array.isArray(report.suggestions) ? report.suggestions : [];
  const meta = options.meta || {};

  const overview = items.length
    ? '<details class="report-overview" open><summary><span class="ttl">问题一览表</span>'
      + '<span class="meta">共 ' + items.length + ' 条 · 点击展开或收起</span></summary><table>'
      + '<thead><tr><th>#</th><th>优先级</th><th>问题</th><th>位置</th></tr></thead><tbody>'
      + items.map((item, index) => '<tr><td>' + (index + 1) + '</td><td>' + escapeHTML(item.prio || '—')
        + '</td><td><a href="#suggestion-' + (index + 1) + '">' + escapeHTML(item.title) + '</a></td>'
        + '<td>' + (Number.isFinite(Number(item.evidenceTime)) ? '约 ' + timeLabel(item.evidenceTime) : '—') + '</td></tr>').join('')
      + '</tbody></table></details>'
    : '';

  const groups = ['P1', 'P2', 'P3'].map(prio => {
    const members = items.map((item, index) => ({ item, index })).filter(entry => (entry.item.prio || 'P3') === prio);
    if (!members.length) return '';
    return '<section class="report-group"><h3 class="group-title"><span class="num">' + GROUP_NUM[prio] + '</span>'
      + escapeHTML(GROUP_LABEL[prio]) + '（' + members.length + '）</h3>'
      + members.map(entry => card(entry.item, entry.index, frames, interactive, options.references)).join('') + '</section>';
  }).join('');

  const hint = report.p1_hint
    ? '<p class="report-hint"><strong>如果只改一处：</strong>' + escapeHTML(report.p1_hint) + '</p>' : '';
  const positive = report.positive?.length
    ? '<section class="report-positive"><h3>做对了什么（可以迁移到其他作品）</h3><ul>'
      + report.positive.map(text => '<li>' + escapeHTML(text) + '</li>').join('') + '</ul></section>' : '';
  const limitations = report.limitations?.length
    ? '<section class="report-limitations"><h3>这次判断的证据边界</h3><ul>'
      + report.limitations.map(text => '<li>' + escapeHTML(text) + '</li>').join('') + '</ul></section>' : '';

  const RUBRIC_LABEL = {
    form: '主形可读性', value: '明度结构', timing: '节奏与分段', continuity: '运动连贯性',
    color: '色彩关系', material: '材质与细节', ending: '收尾与循环', robustness: '制作的可靠性',
  };
  const RUBRIC_STATUS = { pass: '通过', warn: '有隐患', fail: '不通过', unknown: '看不出' };
  const RUBRIC_CLASS = { pass: 'ok', warn: 'warn', fail: 'bad', unknown: 'dim' };
  const rubricItems = Array.isArray(report.rubric) ? report.rubric : [];
  // 八个维度全是 unknown 说明模型压根没核对，摆一张空表不如不显示。
  const rubric = rubricItems.some(item => item.status !== 'unknown')
    ? '<section class="report-rubric"><h3>评审准则核对</h3>'
      + '<p class="report-note">逐个维度核对，不是「整体感觉」。通过的说明做对了什么，不通过的给出依据时刻和改法。</p>'
      + '<table><thead><tr><th>维度</th><th>结论</th><th>依据</th><th>看到了什么 / 怎么改</th></tr></thead><tbody>'
      + rubricItems.map(item => '<tr>'
        + '<td>' + escapeHTML(RUBRIC_LABEL[item.key] || item.key) + '</td>'
        + '<td><span class="rubric-status ' + (RUBRIC_CLASS[item.status] || 'dim') + '">' + escapeHTML(RUBRIC_STATUS[item.status] || item.status) + '</span></td>'
        + '<td>' + (Number.isFinite(Number(item.time)) ? timeLink(item.time, '约 ' + timeLabel(item.time), interactive) : '—') + '</td>'
        + '<td>' + escapeHTML(item.evidence || '')
        + (item.fix ? '<br><span class="rubric-fix">改法：' + escapeHTML(item.fix) + '</span>' : '') + '</td>'
        + '</tr>').join('')
      + '</tbody></table></section>'
    : '';

  // 参考示例图：把参考库片段的接触表也画出来。
  // 光有文字结论，读者看不到「标杆长什么样」，对比就落不了地 ——
  // 这也是报告里「静态 / 动态案例参考」那一块的作用。
  const referenceShots = (Array.isArray(options.references) ? options.references : [])
    .map(item => {
      const sheets = (Array.isArray(item.sheets) ? item.sheets : []).filter(sheet => sheet?.image);
      if (!sheets.length) return '';
      return '<div class="benchmark-ref"><p class="benchmark-ref-name">参考片段：'
        + escapeHTML(item.name || '未命名')
        + (Number.isFinite(Number(item.range?.end)) ? '（前 ' + Number(item.range.end).toFixed(1) + ' 秒）' : '')
        + '</p><div class="evrow">'
        + sheets.map(sheet => frameFigure(sheet.image, '参考片段 ' + (item.name || ''), '每格 1/30 秒 · 与你的作品同一套管线解码', false, undefined)).join('')
        + '</div></div>';
    })
    .join('');

  const benchmarks = Array.isArray(report.benchmarks) && report.benchmarks.length
    ? '<section class="report-benchmarks"><h3>标杆对比</h3>'
      + '<p class="report-note">这些结论来自你在参考库里勾选的片段。它们和你的作品用<strong>同一套管线</strong>处理'
      + '（逐帧解码 → 接触表 + 运动强度），所以是可核对的对比，不是凭印象说「多参考优秀作品」。'
      + '下面同时附上参考片段本身的接触表，方便你直接对照。</p>'
      + '<ul>' + report.benchmarks.map(item => '<li><strong>' + escapeHTML(item.name) + '</strong>：'
        + escapeHTML(item.takeaway) + '</li>').join('') + '</ul>'
      + referenceShots + '</section>'
    : '';
  // 刚才那一大块参考接触表图不再是「参考片段」栏的内容 ——
  // 它既点不开、又和作者自己的画面对不上号，用户反馈说没什么用。
  // 现在只在有并排对照、需要一张小图时留在建议卡里（referenceShots 只在下面用到）。

  const metaLine = [
    meta.file ? escapeHTML(meta.file) : '',
    Number.isFinite(Number(meta.range?.start)) ? '选区 ' + timeLabel(meta.range.start) + ' — ' + timeLabel(meta.range.end) : '',
    meta.style ? escapeHTML(meta.style) : '',
    meta.model ? '模型 ' + escapeHTML(meta.model) : '',
    meta.createdAt ? new Date(meta.createdAt).toLocaleString('zh-CN') : '',
  ].filter(Boolean).join(' · ');

  return '<header class="report-head"><h2>评审报告</h2>'
    + (metaLine ? '<p class="report-meta">' + metaLine + '</p>' : '') + '</header>'
    + renderScore(report.score)
    + '<p class="report-summary">' + escapeHTML(report.summary) + '</p>'
    + hint
    + '<h3 class="section-title">全片亮度轨迹<small>' + (options.series?.length || 0) + ' 帧逐帧实算 · 横轴为原视频秒数</small></h3>'
    + renderTrajectory(options.series || [], meta.range || {})
    + overview
    + groups
    + rubric
    + benchmarks
    + positive
    + limitations
    + '<section class="report-howto"><h3>这份报告怎么用</h3><ol>'
    + '<li>先照 <b>P1</b> 改，一次只动一层，改完立刻用「怎么自己验证」那一条检查。</li>'
    + '<li>每条建议都绑了一个时刻，点击时间链接可以跳到对应画面，和原视频对着看。</li>'
    + '<li>改完重新上传同一段视频、选同样的选区，把两份报告并排比较。</li>'
    + '<li>「值得保留」的条目不是问题，是这条作品已经成立的部分，改别的地方时别把它弄坏。</li>'
    + '</ol></section>';
}

/* ───────────────────────── 导出 ───────────────────────── */

const EXPORT_CSS = `
:root{
  color-scheme:light;
  --traj-bg:#fbfcfd;--traj-grid:#eaecf0;--traj-axis:#98a2b3;--traj-text:#667085;--traj-ba:#2f6fed;--traj-cw:#e8590c;
  --ink:#1f2937;--muted:#667085;--line:#e5e7eb;--line-soft:#f0f1f3;--card:#fff;
}
@media (prefers-color-scheme: dark){
  :root{
    color-scheme:dark;
    --traj-bg:#12161b;--traj-grid:#232a34;--traj-axis:#4a5462;--traj-text:#8b97a6;--traj-ba:#6f9dff;--traj-cw:#ff9a5c;
    --ink:#e6e9ee;--muted:#8b97a6;--line:#262c36;--line-soft:#1e242c;--card:#161a20;
  }
  body{background:#0f1216;color:var(--ink)}
  .report-doc{background:var(--card);border-color:var(--line)}
  .report-summary{background:#12161b}
  .report-hint{background:#2a2110}
  .report-overview,.report-card{border-color:var(--line);background:var(--card)}
  .report-card{background:var(--card)}
  .compare{background:#12161b}
  .report-score{background:#12161b}
  .score-badge{background:#161a20}
  .score-track{background:#1e242c}
  .score-grade{background:#1e242c}
  .score-list.good{background:#0f2618;border-color:#1d5133}
  .score-list.bad{background:#221b0e;border-color:#4d401c}
  .report-overview th,.report-overview td,.report-card{border-bottom-color:var(--line-soft)}
  .report-positive{background:#0f2618;border-color:#1d5133}
  .report-limitations{background:#2a2110;border-color:#5c4a1e}
  .report-howto{border-top-color:var(--line)}
  .section-title{border-bottom-color:var(--line)}
  .report-card p strong,.report-meta,.report-note{color:var(--muted)}
  .pill.p1{background:#2a1616;color:#ff9a91}
  .pill.p2{background:#2a2110;color:#f0b357}
  .pill.p3{background:#1b2740;color:#bcd3ff}
}
*{box-sizing:border-box}
body{margin:0;padding:32px 16px 80px;font:15px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;background:#f6f7f9}
.report-doc{max-width:1040px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:32px 36px 40px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
.report-head h2{margin:0 0 6px;font-size:22px}
.report-meta{margin:0 0 18px;color:#667085;font-size:13px}
.report-summary{font-size:15.5px;background:#f8fafc;border-left:4px solid #2f6fed;padding:14px 16px;border-radius:0 10px 10px 0}
.report-hint{background:#fff7ed;border-left:4px solid #e8590c;padding:12px 16px;border-radius:0 10px 10px 0}
.section-title{margin:34px 0 10px;font-size:17px;border-bottom:1px solid #e5e7eb;padding-bottom:8px}
.section-title small{margin-left:10px;color:#667085;font-size:12.5px;font-weight:400}
.report-traj svg{width:100%;height:auto;display:block}
.traj-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:#475467;margin-bottom:6px}
.traj-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;margin-right:5px}
.report-note{font-size:13px;color:#475467;line-height:1.75}
.report-overview{border:1px solid #e5e7eb;border-radius:12px;padding:10px 14px;margin:18px 0}
.report-overview summary{cursor:pointer;font-weight:600}
.report-overview .meta{color:#667085;font-weight:400;font-size:12.5px;margin-left:8px}
.report-overview table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13.5px}
.report-overview th,.report-overview td{border-bottom:1px solid #f0f1f3;padding:7px 6px;text-align:left}
.report-overview a{color:#2f6fed;text-decoration:none}
.report-group{margin-top:26px}
.group-title{font-size:16px;margin:0 0 12px}
.group-title .num{margin-right:6px}
.report-card{border:1px solid #e5e7eb;border-radius:14px;padding:18px 20px;margin:0 0 16px;background:#fff}
.card-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.card-heading h3{margin:0;font-size:16.5px}
.card-heading .dim{font-size:12.5px;color:#667085;border:1px solid #e5e7eb;border-radius:999px;padding:1px 8px;vertical-align:2px}
.card-heading .at{margin-left:auto;color:#667085;font-size:12.5px}
.pill{font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;background:#eef2ff;color:#3538cd}
.pill.p1{background:#fee4e2;color:#b42318}
.pill.p2{background:#fef0c7;color:#b54708}
.pill.p3{background:#eef2ff;color:#3538cd}
.cnum{font-weight:700;color:#98a2b3}
.evrow{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0 4px}
.shot{margin:0;max-width:330px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;background:#0b0b0c}
.shot img{display:block;width:100%;height:auto}
.shot figcaption{padding:6px 9px;font-size:12px;color:#475467;background:#fff;display:flex;gap:8px;align-items:center;justify-content:space-between}
.report-card p{margin:10px 0}
.report-card p strong{display:block;color:#475467;font-size:12.5px;font-weight:600;margin-bottom:2px}
.compare{display:flex;gap:10px;align-items:stretch;flex-wrap:wrap;margin:14px 0 4px;padding:12px;border-radius:12px;background:#f8fafc;border:1px solid #eef0f3}
.compare .shot{flex:1 1 250px;max-width:340px}
.compare-tag{align-self:center;font-size:12px;color:#667085;font-weight:700;letter-spacing:.1em}
.compare-why{margin:8px 0 0;font-size:13px;color:#475467}
.compare-why strong{display:block;font-size:12.5px;color:#667085;font-weight:600;margin-bottom:2px}
.shot img{cursor:zoom-in}
.lb{position:fixed;inset:0;background:rgba(8,10,14,.9);display:flex;align-items:center;justify-content:center;z-index:99;cursor:zoom-out;padding:26px}
.lb img{max-width:100%;max-height:100%;border-radius:10px}
.report-card h4{margin:14px 0 6px;font-size:14px}
.report-actions{margin:0;padding-left:22px}
.report-actions li{margin:5px 0}
.report-positive,.report-limitations{border-radius:12px;padding:14px 18px;margin:20px 0}
.report-positive{background:#ecfdf3;border:1px solid #abefc6}
.report-limitations{background:#fffaeb;border:1px solid #fedf89}
.report-positive h3,.report-limitations h3{margin:0 0 8px;font-size:15px}
.report-positive ul,.report-limitations ul{margin:0;padding-left:20px}
.report-howto{margin-top:26px;border-top:1px solid #e5e7eb;padding-top:18px;color:#475467;font-size:13.5px}
.report-howto h3{color:#1f2937}
.time-link{border:none;background:none;color:#2f6fed;cursor:pointer;font:inherit;padding:0;text-decoration:underline dotted}
.time-link.tiny{font-size:12px}
.report-score{border:1px solid #e5e7eb;border-radius:14px;padding:18px 20px;margin:0 0 18px;background:#f8fafc}
.score-top{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}
.score-badge{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:136px;padding:14px 18px;border-radius:12px;background:#fff;border:2px solid #e5e7eb}
.score-num{font-size:46px;font-weight:800;line-height:1}
.score-max{font-size:13px;color:#667085;margin-top:2px}
.score-grade{margin-top:9px;font-size:13px;font-weight:700;padding:2px 13px;border-radius:999px;background:#f2f4f7;color:#667085}
.score-badge.great{border-color:#12b76a}.score-badge.great .score-num{color:#027a48}.score-badge.great .score-grade{background:#ecfdf3;color:#027a48}
.score-badge.good{border-color:#2f6fed}.score-badge.good .score-num{color:#1d4ed8}.score-badge.good .score-grade{background:#eef4ff;color:#3538cd}
.score-badge.pass{border-color:#f79009}.score-badge.pass .score-num{color:#b54708}.score-badge.pass .score-grade{background:#fffaeb;color:#b54708}
.score-badge.weak{border-color:#f04438}.score-badge.weak .score-num{color:#b42318}.score-badge.weak .score-grade{background:#fef3f2;color:#b42318}
.score-dims{flex:1;min-width:290px;display:flex;flex-direction:column;gap:8px}
.score-row{display:grid;grid-template-columns:92px 1fr 34px;gap:10px;align-items:center;font-size:13px}
.score-track{height:9px;background:#eaecf0;border-radius:999px;overflow:hidden;display:block}
.score-fill{display:block;height:100%;border-radius:999px;background:#2f6fed}
.score-fill.great{background:#12b76a}.score-fill.good{background:#2f6fed}.score-fill.pass{background:#f79009}.score-fill.weak{background:#f04438}.score-fill.none{background:#d0d5dd}
.score-row-value{text-align:right;font-weight:700}
.score-row-note{grid-column:2/4;color:#667085;font-size:12.5px;margin-top:-3px}
.score-lists{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}
.score-list{border-radius:12px;padding:12px 15px}
.score-list.good{background:#ecfdf3;border:1px solid #abefc6}
.score-list.bad{background:#fffaeb;border:1px solid #fedf89}
.score-list h4{margin:0 0 8px;font-size:14.5px}
.score-list h4 span{display:block;font-weight:400;font-size:12.5px;color:#667085;margin-top:3px}
.score-list ul{margin:0;padding-left:19px}
.score-list li{margin:5px 0;font-size:13px}
.score-empty{margin:0;font-size:13px;color:#667085}
@media print{body{background:#fff;padding:0}.report-doc{border:none;box-shadow:none;max-width:none}}
`;

/** 生成完全自包含的 HTML（图片都是 data URL，无外部依赖）。 */
/** 导出报告里的一段小脚本：点图放大。单文件报告没有服务器，只能用内联脚本。 */
const REPORT_LIGHTBOX = '<scr' + 'ipt>'
  + 'document.addEventListener("click",function(e){var i=e.target.closest(".shot img");if(!i)return;'
  + 'var o=document.createElement("div");o.className="lb";var g=document.createElement("img");g.src=i.src;'
  + 'o.appendChild(g);o.addEventListener("click",function(){o.remove()});document.body.appendChild(o)})'
  + '</scr' + 'ipt>';
export function buildStandaloneHTML({ report, frames = [], series = [], meta = {}, references = [] }) {
  const title = '特效评审报告 · ' + (meta.file || '作品');
  const body = renderReport(report, frames, { interactive: false, series, meta, references });
  return '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>' + escapeHTML(title) + '</title>\n<style>' + EXPORT_CSS + '</style>\n</head>\n<body>\n'
    + '<main class="report-doc">' + body + '</main>' + REPORT_LIGHTBOX + '\n</body>\n</html>\n';
}

/** 纯文本版，方便贴到聊天窗口里。 */
export function reportToMarkdown(report, meta = {}) {
  const lines = ['# 特效评审报告', ''];
  if (meta.file) lines.push('- 作品：' + meta.file);
  if (Number.isFinite(Number(meta.range?.start))) lines.push('- 选区：' + timeLabel(meta.range.start) + ' — ' + timeLabel(meta.range.end));
  lines.push('', '## 总体判断', '', report.summary, '');
  if (report.p1_hint) lines.push('> 如果只改一处：' + report.p1_hint, '');
  (report.suggestions || []).forEach((item, index) => {
    lines.push('## ' + (index + 1) + '. [' + (item.prio || 'P3') + '] ' + item.title + (item.dimension ? '（' + item.dimension + '）' : ''));
    if (Number.isFinite(Number(item.evidenceTime))) lines.push('- 时刻：约 ' + timeLabel(item.evidenceTime));
    if (item.feedback) lines.push('- 看到什么：' + item.feedback);
    if (item.hypothesis) lines.push('- 为什么：' + item.hypothesis);
    if (item.designIntent) lines.push('- 原本该做什么：' + item.designIntent);
    if (item.preserve) lines.push('- 必须保留：' + item.preserve);
    if (item.actions?.length) {
      item.actions.forEach((step, stepIndex) => lines.push('- 怎么改 ' + (stepIndex + 1) + '：' + step));
    }
    if (item.expected) lines.push('- 预期：' + item.expected);
    if (item.verify) lines.push('- 验证：' + item.verify);
    lines.push('');
  });
  if (report.positive?.length) {
    lines.push('## 做对了什么', '');
    report.positive.forEach(text => lines.push('- ' + text));
    lines.push('');
  }
  if (report.limitations?.length) {
    lines.push('## 证据边界', '');
    report.limitations.forEach(text => lines.push('- ' + text));
  }
  return lines.join('\n');
}

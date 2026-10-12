/**
 * clip-cost.mjs —— 选区成本估算。
 *
 * 为什么需要：选区长度不该由我们一刀切定死（用户要自由选），但"越长越慢越贵"是事实 ——
 * 那就把代价算出来**实时显示**，让用户自己权衡。
 *
 * 依据（都是代码里的事实，不是拍脑袋）：
 *   · 管线是逐帧解码，按 30fps 估算即可（上传上限 2 分钟 → 最多约 3600 帧）；
 *   · 接触表固定 4 列 × 6 行 = 24 帧一页（见 app.js 拼接触表那段）；
 *   · 页数决定要发给模型多少张图 → 直接决定耗时与费用。
 */

export const EST_FPS = 30;          // 估算用的帧率
export const FRAMES_PER_SHEET = 24; // 每页接触表 4×6 帧
export const MIN_CLIP_SECONDS = 0.1;

/** 档位只是给人看的说法，阈值按估算页数来的（15/30/60 秒 ≈ 19/38/75 页）。 */
export const COST_TIERS = [
  { max: 15, name: '省',   note: '页数少，最快最省' },
  { max: 30, name: '标准', note: '和参考库片段一个长度' },
  { max: 60, name: '偏高', note: '接触表翻倍，耗时和费用明显上升' },
  { max: Infinity, name: '很重', note: '整片级别：页数上百，耗时和费用成倍增长' },
];

/** 这段选区大概要让模型读多少页、属于哪一档。 */
export function estimateWork(span) {
  const seconds = Math.max(0, Number(span) || 0);
  const frames = Math.max(1, Math.round(seconds * EST_FPS));
  const sheets = Math.max(1, Math.ceil(frames / FRAMES_PER_SHEET));
  const tier = COST_TIERS.find((t) => seconds <= t.max) || COST_TIERS[COST_TIERS.length - 1];
  return { seconds, frames, sheets, tier };
}

/** 一句话概括，给界面用。 */
export function describeWork(span) {
  const est = estimateWork(span);
  return '约 ' + est.frames + ' 帧 / ' + est.sheets + ' 页接触表 · 档位：' + est.tier.name + '（' + est.tier.note + '）';
}

/* ═══════════════════════════════════════════════════════════════════════════
   workshop.js —— 贴图台（特效贴图生成器）

   全部在浏览器里跑：不发任何请求、不上传任何东西、也不依赖服务端。
   所以本地版和链接版（GitHub Pages）行为完全一致 —— 这一页没有模式分支。

   实现要点：
   · 每个生成器就是一个纯函数 fn(参数, x, y, t, 种子) → 0..1 的灰度值。
     颜色、透明度、混合全部在合成阶段做，生成器只管形状。
   · 噪波用**周期性**哈希（pnoise），所以整数密度下天然四方连续，平铺检查看不到缝。
   · 图层合成用 canvas 的 globalCompositeOperation，和引擎里的混合模式一一对应。
   · 通道打包不经过画布取色：直接算每个图层的灰度场写进 R/G/B/A，
     再用自己写的无损 PNG 编码导出 —— 画布会预乘 alpha，取回来的 A 通道数据是坏的。
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* 收集运行期错误，方便无头自检抓（正常使用时一直是空数组） */
  window.__wsErrors = window.__wsErrors || [];
  window.addEventListener('error', function (e) { window.__wsErrors.push(String(e.message || e)); });

  /* ───────────────────────────── 小工具 ───────────────────────────── */
  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { return t * t * (3 - 2 * t); }

  /** 快速哈希：同一个 (x,y,seed) 永远同一个数，保证「同参数同图」 */
  function hash2(x, y, seed) {
    var h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
    h = (h ^ (h >>> 13)) * 1103515245;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  /** 周期性值噪波：per 是整数周期，所以整张图可以无缝平铺 */
  // 每层可以关掉「四方连续」（见图层的「连续」开关）。关掉就用普通哈希，接缝不再对齐。
  var TILING = true;
  function pnoise(x, y, per, seed) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = smooth(xf), v = smooth(yf);
    function w(i, j) {
      return TILING ? hash2(((i % per) + per) % per, ((j % per) + per) % per, seed) : hash2(i, j, seed);
    }
    return lerp(lerp(w(xi, yi), w(xi + 1, yi), u), lerp(w(xi, yi + 1), w(xi + 1, yi + 1), u), v);
  }
  /** 分形噪波（每层周期翻倍，保证每层都连续） */
  function fbmN(x, y, per, oct, seed, gain) {
    var s = 0, a = 0.5, n = 0, f = 1, p = Math.max(1, Math.round(per));
    for (var i = 0; i < oct; i++) { s += a * pnoise(x * f, y * f, p * f, seed + i * 131); n += a; a *= gain; f *= 2; }
    return s / n;
  }
  /** 湍流：取绝对值，出筋络感 */
  function turbN(x, y, per, oct, seed) {
    var s = 0, a = 0.5, n = 0, f = 1, p = Math.max(1, Math.round(per));
    for (var i = 0; i < oct; i++) { s += a * Math.abs(pnoise(x * f, y * f, p * f, seed + i * 977) * 2 - 1); n += a; a *= 0.5; f *= 2; }
    return s / n;
  }
  /** 细胞噪波：返回 F1 / F2（F2-F1 就是裂纹） */
  function worley(x, y, per, seed) {
    var xi = Math.floor(x), yi = Math.floor(y), f1 = 9, f2 = 9, p = Math.max(1, Math.round(per));
    var cix = 0, ciy = 0;
    for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) {
      var cx = xi + i, cy = yi + j;
      var gx = TILING ? ((cx % p) + p) % p : cx, gy = TILING ? ((cy % p) + p) % p : cy;
      var px = cx + hash2(gx, gy, seed), py = cy + hash2(gx, gy, seed + 7919);
      var d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; cix = gx; ciy = gy; } else if (d < f2) { f2 = d; }
    }
    return { f1: f1, f2: f2, cix: cix, ciy: ciy };
  }
  function hex2rgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    var v = m ? parseInt(m[1], 16) : 0xff8932;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  /* ───────────────────────────── 色阶（灰度 → 彩色）───────────────────────────── */
  var RAMPS = {
    火焰: ['#000000', '#5a0d00', '#c42a00', '#ff7a18', '#ffd24a', '#fffbe8'],
    熔岩: ['#0a0406', '#4a0f1a', '#a81f2e', '#f2551f', '#ffc23c', '#fff3c4'],
    青蓝能量: ['#02060f', '#08284d', '#0d6fa8', '#27c1e0', '#a8f4ff', '#ffffff'],
    紫电: ['#07030f', '#241046', '#5b28a8', '#a95cf2', '#e6b8ff', '#ffffff'],
    翠毒: ['#04120a', '#0b3a1e', '#177a35', '#3fd45f', '#c6ff7a', '#f4ffe0'],
    黄金: ['#100a02', '#4a2f05', '#9c6b0c', '#e5a81e', '#ffdf7a', '#fffbe8'],
    霓虹粉: ['#0a0210', '#3d0a4d', '#9c1a9c', '#ff3fa4', '#ffb0e0', '#ffffff'],
    冰霜: ['#030812', '#123047', '#2f6f8f', '#7fc4d8', '#d8f4ff', '#ffffff'],
    烟灰: ['#08090b', '#22262b', '#4b535c', '#858f9a', '#c6cdd6', '#f4f6f8'],
    彩虹: ['#ff2d55', '#ff9500', '#ffd60a', '#34c759', '#32ade6', '#af52de'],
    热力: ['#000000', '#1b0033', '#6a00a8', '#e01f5a', '#ff9d00', '#fffbd6'],
    日落: ['#1a0a2e', '#5c1f5e', '#c73e5c', '#ff8a4c', '#ffd08a', '#fff3d6'],
    深海: ['#01060f', '#05284a', '#0a5f7a', '#22a3a8', '#8fe0d0', '#f0fffb'],
    血月: ['#050203', '#2a0509', '#6b0d14', '#b81f22', '#e8683c', '#ffd9a8'],
    薄荷: ['#04100c', '#0d3b2c', '#1e7a52', '#4cc98a', '#b8f2c8', '#f4fff2'],
    自定义: ['#000000', '#ffffff']
  };
  function rampAt(stops, t) {
    var n = stops.length - 1;
    var x = clamp(t, 0, 1) * n, i = Math.min(n - 1, Math.floor(x)), f = x - i;
    var a = hex2rgb(stops[i]), b = hex2rgb(stops[i + 1]);
    return [lerp(a[0], b[0], f) | 0, lerp(a[1], b[1], f) | 0, lerp(a[2], b[2], f) | 0];
  }

  /* ───────────────────────────── 混合模式 ───────────────────────────── */
  var BLENDS = [
    ['source-over', '正常'], ['multiply', '正片叠底'], ['screen', '滤色'], ['lighter', '相加'],
    ['overlay', '叠加'], ['darken', '变暗'], ['lighten', '变亮'], ['color-dodge', '颜色减淡'],
    ['color-burn', '颜色加深'], ['soft-light', '柔光'], ['hard-light', '强光'], ['difference', '差值'], ['exclusion', '排除']
  ];

  /* ───────────────────────────── 生成器 ─────────────────────────────
     约定：fn(p, x, y, t, seed) —— x/y 是 0..1 的画面坐标，返回 0..1。
     tile=true 表示整数密度下四方连续；anim=true 表示参数 t 会真的动。      */
  var TYPES = [];

  TYPES.push({
    id: 'fbm', name: '分形噪波', cat: '噪波', tags: ['基础', '云', '烟'], tile: true, anim: true,
    params: [{ k: 'scale', label: '密度', min: 1, max: 16, step: 1, def: 4 },
      { k: 'oct', label: '层数', min: 1, max: 8, step: 1, def: 5 },
      { k: 'gain', label: '衰减', min: 0.25, max: 0.75, step: 0.01, def: 0.5 },
      { k: 'flow', label: '流动', min: 0, max: 1, step: 0.01, def: 0.3 },
      { k: 'contrast', label: '对比', min: 0.2, max: 3, step: 0.05, def: 1.2 },
      { k: 'bias', label: '亮度', min: -0.4, max: 0.4, step: 0.01, def: 0 }],
    fn: function (p, x, y, t, s) {
      var v = fbmN(x * p.scale + t * p.flow, y * p.scale, p.scale, p.oct, s, p.gain);
      return clamp((v - 0.5) * p.contrast + 0.5 + p.bias, 0, 1);
    }
  });
  TYPES.push({
    id: 'cloud', name: '云絮', cat: '噪波', tags: ['云', '烟', '爆炸'], tile: true, anim: true,
    params: [{ k: 'scale', label: '密度', min: 1, max: 12, step: 1, def: 3 },
      { k: 'oct', label: '层数', min: 2, max: 8, step: 1, def: 6 },
      { k: 'puff', label: '蓬松', min: 0, max: 2, step: 0.05, def: 0.9 },
      { k: 'flow', label: '流动', min: 0, max: 0.6, step: 0.01, def: 0.12 },
      { k: 'contrast', label: '对比', min: 0.5, max: 4, step: 0.05, def: 2.0 }],
    fn: function (p, x, y, t, s) {
      var v = fbmN(x * p.scale + t * p.flow, y * p.scale, p.scale, p.oct, s, 0.55);
      v = 1 - Math.abs(v * 2 - 1);
      v = Math.pow(v, 1 + p.puff * 2);
      return clamp((v - 0.35) * p.contrast + 0.35, 0, 1);
    }
  });
  TYPES.push({
    id: 'turb', name: '湍流', cat: '噪波', tags: ['筋络', '烟', '水面'], tile: true, anim: true,
    params: [{ k: 'scale', label: '密度', min: 1, max: 14, step: 1, def: 4 },
      { k: 'oct', label: '层数', min: 2, max: 8, step: 1, def: 5 },
      { k: 'flow', label: '流动', min: 0, max: 1, step: 0.01, def: 0.25 },
      { k: 'sharp', label: '锐度', min: 1, max: 5, step: 0.1, def: 2.4 }],
    fn: function (p, x, y, t, s) {
      var v = turbN(x * p.scale + t * p.flow, y * p.scale, p.scale, p.oct, s);
      return clamp(Math.pow(v, 1 / p.sharp) * 1.15, 0, 1);
    }
  });
  TYPES.push({
    id: 'marble', name: '大理石', cat: '噪波', tags: ['纹理', '魔法', '材质'],
    params: [{ k: 'scale', label: '密度', min: 1, max: 10, step: 1, def: 3 },
      { k: 'bands', label: '纹路数', min: 1, max: 14, step: 1, def: 5 },
      { k: 'warp', label: '扭曲', min: 0, max: 4, step: 0.05, def: 1.4 },
      { k: 'sharp', label: '锐度', min: 1, max: 6, step: 0.1, def: 2.6 }],
    fn: function (p, x, y, t, s) {
      var n = fbmN(x * p.scale, y * p.scale, p.scale, 5, s, 0.5);
      var v = 0.5 + 0.5 * Math.sin((x + y) * p.bands * Math.PI + n * p.warp * TAU);
      return clamp(Math.pow(v, 1 / p.sharp) * 1.1, 0, 1);
    }
  });
  TYPES.push({
    id: 'vortex', name: '漩涡', cat: '扭曲', tags: ['魔法', '传送', '动态'], anim: true,
    params: [{ k: 'arms', label: '旋臂', min: 1, max: 8, step: 1, def: 3 },
      { k: 'twist', label: '扭曲', min: 0.5, max: 8, step: 0.1, def: 3.0 },
      { k: 'scale', label: '密度', min: 1, max: 10, step: 1, def: 3 },
      { k: 'speed', label: '转速', min: -1, max: 1, step: 0.02, def: 0.25 },
      { k: 'falloff', label: '边缘衰减', min: 0, max: 1.5, step: 0.05, def: 0.7 }],
    fn: function (p, x, y, t, s) {
      var dx = x - 0.5, dy = y - 0.5, r = Math.hypot(dx, dy) * 2;
      var a = Math.atan2(dy, dx) + p.twist * r + t * p.speed * TAU;
      var v = 0.5 + 0.5 * Math.sin(a * p.arms + fbmN(x * p.scale, y * p.scale, p.scale, 4, s, 0.5) * 3);
      return clamp(v * (1 - clamp((r - 0.55) * p.falloff * 2, 0, 1)), 0, 1);
    }
  });
  TYPES.push({
    id: 'speedlines', name: '集中线', cat: '径向', tags: ['漫画', '速度', '打击'],
    params: [{ k: 'count', label: '线数', min: 20, max: 400, step: 5, def: 140 },
      { k: 'inner', label: '内圈', min: 0, max: 0.7, step: 0.01, def: 0.2 },
      { k: 'jitter', label: '抖动', min: 0, max: 1, step: 0.02, def: 0.35 },
      { k: 'taper', label: '收尖', min: 0, max: 1, step: 0.05, def: 0.7 }],
    fn: function (p, x, y, t, s) {
      var dx = x - 0.5, dy = y - 0.5, r = Math.hypot(dx, dy) * 2;
      var a = (Math.atan2(dy, dx) + Math.PI) / TAU;
      var idx = a * p.count;
      var cell = Math.floor(idx);
      var rnd = hash2(cell, 7, s);
      var start = p.inner + rnd * p.jitter * 0.5;
      var v = r > start ? 1 : 0;
      // 线宽：用小数部分到中线的距离
      var f = Math.abs(idx - cell - 0.5) * 2;
      var w = 0.35 + rnd * 0.5;
      v *= clamp((1 - f) / w, 0, 1);
      if (p.taper > 0) v *= clamp(1 - (r - start) * p.taper * 0.8, 0, 1);
      return clamp(v, 0, 1);
    }
  });
  TYPES.push({
    id: 'rays', name: '光芒', cat: '径向', tags: ['闪光', '神圣', '激光'], anim: true,
    params: [{ k: 'count', label: '光条', min: 4, max: 64, step: 1, def: 14 },
      { k: 'len', label: '长度', min: 0.2, max: 1.4, step: 0.02, def: 0.9 },
      { k: 'soft', label: '柔化', min: 0.05, max: 1, step: 0.01, def: 0.35 },
      { k: 'core', label: '核心', min: 0, max: 0.5, step: 0.01, def: 0.14 },
      { k: 'flick', label: '闪动', min: 0, max: 1, step: 0.02, def: 0.2 }],
    fn: function (p, x, y, t, s) {
      var dx = x - 0.5, dy = y - 0.5, r = Math.hypot(dx, dy) * 2;
      var a = (Math.atan2(dy, dx) + Math.PI) / TAU;
      var idx = a * p.count, cell = Math.floor(idx);
      var f = Math.abs(idx - cell - 0.5) * 2;
      var rnd = hash2(cell, 13, s);
      var L = p.len * (0.45 + rnd * 0.55);
      if (p.flick > 0) L *= 1 - p.flick * 0.5 * (0.5 + 0.5 * Math.sin(t * TAU * 2 + cell));
      var v = clamp(1 - f / p.soft, 0, 1) * clamp(1 - r / L, 0, 1);
      if (p.core > 0) v = Math.max(v, clamp(1 - r / p.core, 0, 1));
      return clamp(v * 1.25, 0, 1);
    }
  });
  TYPES.push({
    id: 'shock', name: '冲击环', cat: '径向', tags: ['爆点', '打击', '动态'], anim: true,
    params: [{ k: 'radius', label: '半径', min: 0.05, max: 1.4, step: 0.01, def: 0.55 },
      { k: 'width', label: '环宽', min: 0.01, max: 0.5, step: 0.01, def: 0.12 },
      { k: 'breakup', label: '破碎', min: 0, max: 1, step: 0.02, def: 0.45 },
      { k: 'scale', label: '噪声密度', min: 1, max: 20, step: 1, def: 8 },
      { k: 'grow', label: '自动扩张', min: 0, max: 1, step: 0.05, def: 0 }],
    fn: function (p, x, y, t, s) {
      var dx = x - 0.5, dy = y - 0.5, r = Math.hypot(dx, dy) * 2;
      var rad = p.radius + t * p.grow;
      var d = Math.abs(r - rad);
      var v = clamp(1 - d / p.width, 0, 1);
      var n = fbmN(x * p.scale, y * p.scale, p.scale, 4, s, 0.5);
      v *= 1 - p.breakup * (1 - n);
      return clamp(v, 0, 1);
    }
  });
  TYPES.push({
    id: 'checker', name: '棋盘', cat: '网格', tags: ['格子', '遮罩', '基础'], tile: true,
    params: [{ k: 'cells', label: '格子数', min: 2, max: 32, step: 1, def: 8 },
      { k: 'warp', label: '扭曲', min: 0, max: 4, step: 0.05, def: 0 },
      { k: 'scale', label: '噪声密度', min: 1, max: 12, step: 1, def: 4 }],
    fn: function (p, x, y, t, s) {
      var wx = x, wy = y;
      if (p.warp > 0) { wx += (fbmN(x * p.scale, y * p.scale, p.scale, 4, s, 0.5) - 0.5) * p.warp * 0.1; wy += (fbmN(x * p.scale + 5, y * p.scale + 5, p.scale, 4, s, 0.5) - 0.5) * p.warp * 0.1; }
      var a = Math.floor(wx * p.cells), b = Math.floor(wy * p.cells);
      return ((a + b) & 1) ? 1 : 0;
    }
  });
  TYPES.push({
    id: 'dots', name: '点阵', cat: '网格', tags: ['圆点', '半调', '遮罩'], tile: true,
    params: [{ k: 'cells', label: '行列数', min: 2, max: 40, step: 1, def: 12 },
      { k: 'size', label: '点大小', min: 0.05, max: 1, step: 0.02, def: 0.5 },
      { k: 'vary', label: '大小随机', min: 0, max: 1, step: 0.02, def: 0.4 },
      { k: 'soft', label: '柔化', min: 0.02, max: 0.5, step: 0.01, def: 0.12 }],
    fn: function (p, x, y, t, s) {
      var cx = x * p.cells, cy = y * p.cells;
      var ix = Math.floor(cx), iy = Math.floor(cy);
      var rnd = hash2(((ix % p.cells) + p.cells) % p.cells, ((iy % p.cells) + p.cells) % p.cells, s);
      var r = p.size * 0.5 * (1 - p.vary + p.vary * rnd);
      var d = Math.hypot(cx - ix - 0.5, cy - iy - 0.5);
      return clamp(1 - (d - r) / p.soft, 0, 1);
    }
  });
  TYPES.push({
    id: 'stripes', name: '条纹', cat: '网格', tags: ['扫描线', '遮罩', '科技'], tile: true,
    params: [{ k: 'count', label: '条数', min: 2, max: 80, step: 1, def: 18 },
      { k: 'duty', label: '占空比', min: 0.05, max: 0.95, step: 0.01, def: 0.5 },
      { k: 'angle', label: '角度', min: 0, max: 180, step: 1, def: 0 },
      { k: 'warp', label: '扭曲', min: 0, max: 3, step: 0.05, def: 0 },
      { k: 'soft', label: '柔化', min: 0.005, max: 0.2, step: 0.005, def: 0.02 }],
    fn: function (p, x, y, t, s) {
      var a = p.angle * Math.PI / 180, u = x * Math.cos(a) + y * Math.sin(a);
      if (p.warp > 0) u += (fbmN(x * 4, y * 4, 4, 4, s, 0.5) - 0.5) * p.warp * 0.1;
      var f = (u * p.count) % 1;
      return clamp((p.duty - f) / p.soft + 0.5, 0, 1);
    }
  });
  TYPES.push({
    id: 'hex', name: '蜂窝', cat: '网格', tags: ['六边形', '科技', '结构'], tile: true,
    params: [{ k: 'cells', label: '密度', min: 2, max: 24, step: 1, def: 8 },
      { k: 'thick', label: '边厚', min: 0.02, max: 0.6, step: 0.01, def: 0.16 },
      { k: 'soft', label: '柔化', min: 0.01, max: 0.3, step: 0.01, def: 0.06 }],
    fn: function (p, x, y, t, s) {
      // 三条相隔 60° 的线族取最小距离 = 到最近六边形边的距离
      var q = p.cells, k = 0.8660254;
      var d1 = Math.abs(((x * q) % 1) - 0.5);
      var d2 = Math.abs((((x * 0.5 + y * k) * q) % 1) - 0.5);
      var d3 = Math.abs((((-x * 0.5 + y * k) * q) % 1) - 0.5);
      var d = Math.min(d1, d2, d3);
      return clamp((d - p.thick) / p.soft + 0.5, 0, 1);
    }
  });
  TYPES.push({
    id: 'cells', name: '细胞', cat: '有机', tags: ['石头', '皮肤', '鳞片'], tile: true,
    params: [{ k: 'cells', label: '密度', min: 1, max: 18, step: 1, def: 6 },
      { k: 'edge', label: '边界厚度', min: 0.05, max: 0.8, step: 0.01, def: 0.3 },
      { k: 'vary', label: '每格明暗差', min: 0, max: 1, step: 0.02, def: 0.6 }],
    fn: function (p, x, y, t, s) {
      var w = worley(x * p.cells, y * p.cells, p.cells, s);
      var base = clamp(w.f2 / p.edge, 0, 1);              // 边界暗、格心亮
      var shade = hash2(w.cix, w.ciy, s + 555);           // 每个格子一个固定亮度
      return clamp(base * lerp(1, 0.35 + shade * 0.65, p.vary), 0, 1);
    }
  });
  TYPES.push({
    id: 'cracks', name: '裂纹', cat: '有机', tags: ['破碎', '地面', '能量'],
    params: [{ k: 'cells', label: '密度', min: 2, max: 24, step: 1, def: 8 },
      { k: 'width', label: '缝宽', min: 0.01, max: 0.3, step: 0.005, def: 0.05 },
      { k: 'glow', label: '缝隙发光', min: 0, max: 1, step: 0.02, def: 0.8 },
      { k: 'rough', label: '粗糙', min: 0, max: 1, step: 0.02, def: 0.35 }],
    fn: function (p, x, y, t, s) {
      var jx = x, jy = y;
      if (p.rough > 0) { jx += (fbmN(x * 12, y * 12, 12, 3, s, 0.5) - 0.5) * p.rough * 0.08; jy += (fbmN(x * 12 + 3, y * 12 + 3, 12, 3, s, 0.5) - 0.5) * p.rough * 0.08; }
      var w = worley(jx * p.cells, jy * p.cells, p.cells, s);
      var seam = 1 - clamp((w.f2 - w.f1) / p.width, 0, 1);
      return clamp(lerp(1 - seam, seam, p.glow), 0, 1);
    }
  });
  TYPES.push({
    id: 'lightning', name: '闪电', cat: '能量', tags: ['电', '打击', '动态'], anim: true,
    params: [{ k: 'branches', label: '分叉', min: 0, max: 6, step: 1, def: 2 },
      { k: 'width', label: '粗细', min: 0.005, max: 0.08, step: 0.002, def: 0.018 },
      { k: 'glow', label: '辉光', min: 0, max: 1, step: 0.02, def: 0.6 },
      { k: 'jitter', label: '抖动', min: 0.02, max: 0.4, step: 0.01, def: 0.14 },
      { k: 'flick', label: '闪动', min: 0, max: 1, step: 0.02, def: 0.35 }],
    fn: function (p, x, y, t, s) {
      // 一条从下到上的折线，用多段随机偏移拼出来
      var seg = 12, best = 1;
      var seedT = p.flick > 0 ? Math.floor(t * 12) : 0;
      for (var b = 0; b <= p.branches; b++) {
        var off = (b === 0) ? 0 : (hash2(b, 3, s) - 0.5) * 0.7;
        var py = y, cx = 0.5 + off;
        for (var i = 0; i < seg; i++) {
          var t0 = i / seg, t1 = (i + 1) / seg;
          if (py < t0 || py > t1) continue;
          var f = (py - t0) * seg;
          var n0 = hash2(i, b, s + seedT * 31), n1 = hash2(i + 1, b, s + seedT * 31);
          var px = cx + lerp((n0 - 0.5) * p.jitter * 2, (n1 - 0.5) * p.jitter * 2, f);
          best = Math.min(best, Math.abs(x - px));
        }
      }
      var w = p.width * (1 + p.glow * 3);
      var v = clamp(1 - best / w, 0, 1);
      return clamp(Math.pow(v, 0.6), 0, 1);
    }
  });
  TYPES.push({
    id: 'plasma', name: '等离子', cat: '能量', tags: ['魔法', '能量', '动态'], anim: true,
    params: [{ k: 'scale', label: '密度', min: 1, max: 14, step: 1, def: 4 },
      { k: 'speed', label: '速度', min: 0, max: 1, step: 0.02, def: 0.25 },
      { k: 'sharp', label: '锐度', min: 1, max: 6, step: 0.1, def: 2.2 }],
    fn: function (p, x, y, t, s) {
      var ph = t * p.speed * TAU, q = p.scale;
      var v = Math.sin(x * q * TAU + ph) + Math.sin(y * q * TAU - ph * 0.7)
        + Math.sin((x + y) * q * 0.8 * TAU + ph * 1.3) + Math.sin((x - y) * q * 1.1 * TAU - ph * 1.1)
        + 0.7 * Math.sin(Math.hypot(x - 0.5, y - 0.5) * q * 2.2 * TAU - ph * 2);
      v = clamp(v / 3.7 * 0.5 + 0.5, 0, 1);
      return clamp(Math.pow(v, 1 / p.sharp) * 1.15, 0, 1);
    }
  });
  TYPES.push({
    id: 'dissolve', name: '溶解', cat: '能量', tags: ['消融', '遮罩', '破碎'],
    params: [{ k: 'amount', label: '溶解量', min: 0, max: 1, step: 0.01, def: 0.5 },
      { k: 'scale', label: '颗粒密度', min: 8, max: 128, step: 4, def: 48 },
      { k: 'edge', label: '边缘厚度', min: 0, max: 0.3, step: 0.01, def: 0.08 },
      { k: 'noise', label: '噪声扰动', min: 0, max: 1, step: 0.02, def: 0.45 }],
    fn: function (p, x, y, t, s) {
      var g = hash2(Math.floor(x * p.scale), Math.floor(y * p.scale), s);
      if (p.noise > 0) g = g * (1 - p.noise) + fbmN(x * 6, y * 6, 6, 4, s, 0.5) * p.noise;
      var cut = p.amount;
      return clamp((cut - g) / Math.max(0.001, p.edge) + 0.5, 0, 1);
    }
  });
  TYPES.push({
    id: 'scratches', name: '划痕', cat: '有机', tags: ['磨损', '做旧', '镜头'],
    params: [{ k: 'count', label: '条数', min: 2, max: 80, step: 1, def: 26 },
      { k: 'len', label: '长度', min: 0.1, max: 1.2, step: 0.02, def: 0.85 },
      { k: 'width', label: '粗细', min: 0.002, max: 0.04, step: 0.001, def: 0.009 },
      { k: 'spread', label: '角度散布', min: 0, max: 1, step: 0.02, def: 0.3 }],
    fn: function (p, x, y, t, s) {
      // 每条划痕都是一根**穿过整个画面**的细线：法线方向随机偏移，沿线两端渐隐
      var v = 0;
      for (var i = 0; i < p.count; i++) {
        var ang = (hash2(i, 1, s) - 0.5) * p.spread * Math.PI + Math.PI * 0.5;
        var nx = Math.cos(ang + Math.PI / 2), ny = Math.sin(ang + Math.PI / 2);
        var off = (hash2(i, 2, s) - 0.5) * 1.7;
        var d = Math.abs((x - 0.5) * nx + (y - 0.5) * ny - off);
        var w = p.width * (0.4 + hash2(i, 3, s) * 0.9);
        var along = Math.abs((x - 0.5) * Math.cos(ang) + (y - 0.5) * Math.sin(ang));
        if (along > p.len) continue;
        var fade = 1 - along / p.len;
        v = Math.max(v, clamp(1 - d / w, 0, 1) * Math.pow(fade, 0.7));
      }
      return clamp(v, 0, 1);
    }
  });
  TYPES.push({
    id: 'gradient', name: '渐变', cat: '基础', tags: ['底色', '遮罩', '过渡'], tile: false,
    params: [{ k: 'kind', label: '类型', min: 0, max: 2, step: 1, def: 0, enum: ['线性', '径向', '角度'] },
      { k: 'angle', label: '角度', min: 0, max: 360, step: 1, def: 0 },
      { k: 'soft', label: '柔和', min: 0.05, max: 1.6, step: 0.02, def: 1 },
      { k: 'invert', label: '反向', min: 0, max: 1, step: 1, def: 0, enum: ['否', '是'] }],
    fn: function (p, x, y, t, s) {
      var v;
      if (p.kind < 0.5) { var a = p.angle * Math.PI / 180; v = x * Math.cos(a) + y * Math.sin(a); }
      else if (p.kind < 1.5) v = Math.hypot(x - 0.5, y - 0.5) * 2;
      else v = (Math.atan2(y - 0.5, x - 0.5) + Math.PI) / TAU;
      v = clamp((v - 0.5) / Math.max(0.02, p.soft) + 0.5, 0, 1);
      return p.invert > 0.5 ? 1 - v : v;
    }
  });
  TYPES.push({
    id: 'noiseGrain', name: '颗粒', cat: '基础', tags: ['噪点', '胶片', '抖动'],
    params: [{ k: 'cells', label: '颗粒密度', min: 16, max: 256, step: 8, def: 128 },
      { k: 'amount', label: '强度', min: 0.05, max: 1, step: 0.02, def: 0.6 },
      { k: 'mono', label: '单色噪声', min: 0, max: 1, step: 1, def: 1, enum: ['否', '是'] }],
    fn: function (p, x, y, t, s) {
      var g = hash2(Math.floor(x * p.cells), Math.floor(y * p.cells), s);
      return clamp(0.5 + (g - 0.5) * p.amount * 2, 0, 1);
    }
  });

  TYPES.push({
    id: 'petals', name: '花瓣', cat: '放射', tags: ['花', '绽放', '圣光'], tile: true, anim: true,
    params: [{ k: 'count', label: '花瓣数', min: 3, max: 24, step: 1, def: 6 },
      { k: 'sharp', label: '瓣形', min: 0.3, max: 4, step: 0.05, def: 1.2 },
      { k: 'fill', label: '大小', min: 0.1, max: 1.3, step: 0.02, def: 0.8 },
      { k: 'spin', label: '旋转', min: -1, max: 1, step: 0.02, def: 0 },
      { k: 'soft', label: '柔化', min: 0.01, max: 0.5, step: 0.01, def: 0.07 }],
    fn: function (p, x, y, t, s) {
      // 玫瑰线：半径上限随角度按 |cos(n/2·θ)| 变化，就是花瓣
      var dx = x - 0.5, dy = y - 0.5, r = Math.hypot(dx, dy) * 2;
      var a = Math.atan2(dy, dx) + t * p.spin * TAU;
      var rm = p.fill * Math.pow(Math.abs(Math.cos(a * p.count / 2)), p.sharp);
      return clamp((rm - r) / p.soft + 0.5, 0, 1);
    }
  });
  TYPES.push({
    id: 'rings', name: '同心环', cat: '环形', tags: ['扩散', '波', '脉冲'], tile: true, anim: true,
    params: [{ k: 'count', label: '环数', min: 2, max: 40, step: 1, def: 8 },
      { k: 'width', label: '环宽', min: 0.02, max: 0.9, step: 0.01, def: 0.35 },
      { k: 'warp', label: '扭曲', min: 0, max: 1, step: 0.02, def: 0 },
      { k: 'scale', label: '噪声密度', min: 1, max: 16, step: 1, def: 6 },
      { k: 'grow', label: '自动扩张', min: 0, max: 1, step: 0.05, def: 0 }],
    fn: function (p, x, y, t, s) {
      var dx = x - 0.5, dy = y - 0.5, r = Math.hypot(dx, dy) * 2;
      var rr = r * p.count + t * p.grow * p.count;
      if (p.warp > 0) rr += (fbmN(x * p.scale, y * p.scale, p.scale, 3, s, 0.5) - 0.5) * p.warp * 6;
      var f = Math.abs((((rr % 1) + 1) % 1) - 0.5) * 2;      // 0 = 环心，1 = 两环正中间
      return clamp(1 - f / p.width, 0, 1);
    }
  });
  TYPES.push({
    id: 'ripple', name: '水波', cat: '自然现象', tags: ['水', '焦散', '波纹'], tile: true, anim: true,
    params: [{ k: 'scale', label: '密度', min: 1, max: 16, step: 1, def: 5 },
      { k: 'speed', label: '速度', min: 0, max: 1, step: 0.02, def: 0.3 },
      { k: 'sharp', label: '锐度', min: 1, max: 6, step: 0.1, def: 2.4 },
      { k: 'mix', label: '湍流混合', min: 0, max: 1, step: 0.02, def: 0.5 }],
    fn: function (p, x, y, t, s) {
      // 焦散感 = 平滑噪波 + 湍流噪波混在一起，再过一层正弦条纹
      var n1 = fbmN(x * p.scale, y * p.scale, p.scale, 4, s, 0.5);
      var n2 = turbN(x * p.scale * 1.7 + 7, y * p.scale * 1.7 + 3, Math.max(1, p.scale * 2), 3, s);
      var v = 0.5 + 0.5 * Math.sin((n1 * (1 - p.mix) + n2 * p.mix) * Math.PI * 6 + t * p.speed * TAU);
      return clamp(Math.pow(v, 1 / p.sharp) * 1.25, 0, 1);
    }
  });
  TYPES.push({
    id: 'circuit', name: '电路', cat: '数字', tags: ['科技', 'HUD', 'PCB'], tile: true,
    params: [{ k: 'cells', label: '网格', min: 2, max: 24, step: 1, def: 8 },
      { k: 'width', label: '线宽', min: 0.03, max: 0.4, step: 0.005, def: 0.16 },
      { k: 'density', label: '走线密度', min: 0.1, max: 1, step: 0.02, def: 0.65 },
      { k: 'nodes', label: '节点概率', min: 0, max: 1, step: 0.02, def: 0.5 },
      { k: 'soft', label: '柔化', min: 0.01, max: 0.2, step: 0.005, def: 0.05 }],
    fn: function (p, x, y, t, s) {
      var q = p.cells, gx = x * q, gy = y * q;
      var ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      var h = hash2(((ix % q) + q) % q, ((iy % q) + q) % q, s);
      var d = 9;                                        // 到走线的距离，9 = 这个格子不放线
      if (h < p.density * 0.45) d = Math.abs(fy - 0.5);                                   // 横线
      else if (h < p.density * 0.9) d = Math.abs(fx - 0.5);                               // 竖线
      else if (h < p.density) d = Math.min(Math.abs(fx - 0.5), Math.abs(fy - 0.5));       // 十字
      var v = clamp((p.width - d) / p.soft + 0.5, 0, 1);
      if (p.nodes > 0 && h > 1 - p.nodes * 0.5) {
        var nd = Math.hypot(fx - 0.5, fy - 0.5);
        v = Math.max(v, clamp((p.width * 1.6 - nd) / p.soft + 0.5, 0, 1));
      }
      return v;
    }
  });

  var TYPE_BY_ID = {};
  TYPES.forEach(function (x) { TYPE_BY_ID[x.id] = x; });
  var CATS = [];
  TYPES.forEach(function (x) { if (CATS.indexOf(x.cat) < 0) CATS.push(x.cat); });
  var CATS_ALL = ['全部'].concat(CATS);

  /* ───────────────────────────── 内置样例 ───────────────────────────── */
  var PRESETS = [
    { name: '爆炸火光', layers: [
      { type: 'cloud', color: { mode: 'ramp', ramp: '火焰' }, params: { scale: 3, oct: 6, puff: 1.1, flow: 0.1, contrast: 2.6 } },
      { type: 'shock', color: { mode: 'ramp', ramp: '黄金' }, blend: 'lighter', opacity: 0.8, params: { radius: 0.6, width: 0.16, breakup: 0.5, scale: 8, grow: 0 } },
      { type: 'noiseGrain', color: { mode: 'gray' }, blend: 'overlay', opacity: 0.35, params: { cells: 128, amount: 0.5, mono: 1 } }] },
    { name: '技能冲击波', layers: [
      { type: 'shock', color: { mode: 'ramp', ramp: '青蓝能量' }, params: { radius: 0.5, width: 0.1, breakup: 0.6, scale: 10, grow: 0 } },
      { type: 'speedlines', color: { mode: 'gray' }, blend: 'screen', opacity: 0.7, params: { count: 180, inner: 0.22, jitter: 0.4, taper: 0.8 } }] },
    { name: '魔法漩涡', layers: [
      { type: 'vortex', color: { mode: 'ramp', ramp: '紫电' }, params: { arms: 4, twist: 4, scale: 3, speed: 0.25, falloff: 0.9 } },
      { type: 'plasma', color: { mode: 'ramp', ramp: '霓虹粉' }, blend: 'lighter', opacity: 0.45, params: { scale: 5, speed: 0.3, sharp: 2 } }] },
    { name: '闪电打击', layers: [
      { type: 'lightning', color: { mode: 'ramp', ramp: '青蓝能量' }, params: { branches: 3, width: 0.02, glow: 0.7, jitter: 0.16, flick: 0.4 } },
      { type: 'cloud', color: { mode: 'ramp', ramp: '烟灰' }, blend: 'screen', opacity: 0.4, params: { scale: 4, oct: 5, puff: 0.6, flow: 0.2, contrast: 1.8 } }] },
    { name: '地面裂纹', layers: [
      { type: 'cracks', color: { mode: 'ramp', ramp: '熔岩' }, params: { cells: 9, width: 0.06, glow: 0.85, rough: 0.4 } },
      { type: 'cloud', color: { mode: 'ramp', ramp: '烟灰' }, blend: 'multiply', opacity: 0.5, params: { scale: 5, oct: 5, puff: 0.8, flow: 0, contrast: 1.6 } }] },
    { name: '消融溶解', layers: [
      { type: 'dissolve', color: { mode: 'ramp', ramp: '火焰' }, params: { amount: 0.5, scale: 48, edge: 0.12, noise: 0.6 } },
      { type: 'noiseGrain', color: { mode: 'gray' }, blend: 'overlay', opacity: 0.4, params: { cells: 200, amount: 0.4, mono: 1 } }] },
    { name: '神圣光芒', layers: [
      { type: 'rays', color: { mode: 'ramp', ramp: '黄金' }, params: { count: 16, len: 1, soft: 0.3, core: 0.16, flick: 0.25 } },
      { type: 'dots', color: { mode: 'gray' }, blend: 'screen', opacity: 0.35, params: { cells: 24, size: 0.4, vary: 0.6, soft: 0.1 } }] },
    { name: '做旧划痕', layers: [
      { type: 'scratches', color: { mode: 'gray' }, params: { count: 24, len: 0.6, width: 0.008, spread: 0.3 } },
      { type: 'noiseGrain', color: { mode: 'gray' }, blend: 'screen', opacity: 0.5, params: { cells: 180, amount: 0.5, mono: 1 } }] }
  ];

  /* ───────────────────────────── 文档模型 ───────────────────────────── */
  var doc = { size: 512, bg: 'transparent', layers: [] };
  var uid = 1;
  function newLayer(typeId, seed) {
    var T = TYPE_BY_ID[typeId] || TYPES[0];
    var params = {};
    T.params.forEach(function (p) { params[p.k] = p.def; });
    return {
      id: 'L' + (uid++), type: T.id, name: T.name, visible: true, opacity: 1, blend: 'source-over',
      alphaFromLum: false, color: { mode: 'gray', ramp: '火焰', solid: '#ff8932' },
      tile: true, fx: {},
      seed: seed === undefined ? ((Math.random() * 1e6) | 0) : seed, params: params
    };
  }
  function cloneLayer(l) { var c = JSON.parse(JSON.stringify(l)); c.id = 'L' + (uid++); return c; }

  function defaultDoc() {
    var d = { size: 512, bg: 'transparent', layers: [] };
    var a = newLayer('fbm'); a.color = { mode: 'gray', ramp: '火焰', solid: '#ff8932' };
    d.layers.push(a);
    return d;
  }
  function loadPreset(p) {
    var d = { size: doc.size, bg: doc.bg, layers: [] };
    p.layers.forEach(function (lp) {
      var l = newLayer(lp.type);
      if (lp.params) Object.keys(lp.params).forEach(function (k) { if (l.params[k] !== undefined) l.params[k] = lp.params[k]; });
      if (lp.color) l.color = { mode: lp.color.mode || 'gray', ramp: lp.color.ramp || '火焰', solid: lp.color.solid || '#ff8932' };
      if (lp.blend) l.blend = lp.blend;
      if (lp.opacity !== undefined) l.opacity = lp.opacity;
      d.layers.push(l);
    });
    return d;
  }

  /* ───────────────────────────── 后处理 ─────────────────────────────
     全部在**灰度场**上做（Float32Array，0..1），顺序是：几何类 → 卷积类 → 调色类。
     上色（灰度/单色/色阶）在最后一步，所以后处理只看得见形状，不掺颜色，效果更好预期。

     这批算法的来路：噪声/卷积/距离场都是公开数学，我们自己写实现。
     噪声 / 卷积 / 距离场都是公开数学，实现是自己写的。
     功能清单是照着同类工具对齐的，代码一行没搬。                              */
  var POSTFX = [
    { k: 'pixelate', name: '像素化', params: [{ k: 'size', label: '方块尺寸', min: 2, max: 64, step: 1, def: 8 }],
      fn: function (f, n, p) {
        var s = Math.max(1, Math.round(p.size)), out = new Float32Array(f.length);
        for (var y = 0; y < n; y += s) for (var x = 0; x < n; x += s) {
          var sum = 0, cnt = 0;
          for (var j = 0; j < s && y + j < n; j++) for (var i = 0; i < s && x + i < n; i++) { sum += f[(y + j) * n + x + i]; cnt++; }
          var avg = cnt ? sum / cnt : 0;
          for (var j2 = 0; j2 < s && y + j2 < n; j2++) for (var i2 = 0; i2 < s && x + i2 < n; i2++) out[(y + j2) * n + x + i2] = avg;
        }
        return out;
      } },
    { k: 'kaleido', name: '万花筒', params: [{ k: 'seg', label: '分割数', min: 2, max: 24, step: 1, def: 6 },
      { k: 'rot', label: '旋转', min: 0, max: 360, step: 1, def: 0 }, { k: 'mix', label: '强度', min: 0, max: 1, step: 0.02, def: 1 }],
      fn: function (f, n, p) {
        var seg = Math.max(2, Math.round(p.seg)), rot = p.rot * Math.PI / 180, out = new Float32Array(f.length);
        var half = n / 2, sector = Math.PI * 2 / seg;
        for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
          var dx = x - half, dy = y - half;
          var r = Math.hypot(dx, dy), a = Math.atan2(dy, dx) + rot;
          var m = ((a % sector) + sector) % sector;
          if (m > sector / 2) m = sector - m;                  // 扇形内镜像
          var sx = Math.round(half + r * Math.cos(m)), sy = Math.round(half + r * Math.sin(m));
          sx = sx < 0 ? 0 : sx >= n ? n - 1 : sx; sy = sy < 0 ? 0 : sy >= n ? n - 1 : sy;
          out[y * n + x] = f[sy * n + sx] * p.mix + f[y * n + x] * (1 - p.mix);
        }
        return out;
      } },
    { k: 'swirl', name: '漩涡', params: [{ k: 'amount', label: '强度', min: 0, max: 3, step: 0.05, def: 1 },
      { k: 'radius', label: '影响半径', min: 0.1, max: 1.5, step: 0.02, def: 0.8 }],
      fn: function (f, n, p) {
        var out = new Float32Array(f.length), half = n / 2, R = p.radius * half;
        for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
          var dx = x - half, dy = y - half, r = Math.hypot(dx, dy);
          var a = Math.atan2(dy, dx), k = r < R ? (1 - r / R) : 0;
          a += k * k * p.amount * Math.PI;
          var sx = Math.round(half + r * Math.cos(a)), sy = Math.round(half + r * Math.sin(a));
          sx = sx < 0 ? 0 : sx >= n ? n - 1 : sx; sy = sy < 0 ? 0 : sy >= n ? n - 1 : sy;
          out[y * n + x] = f[sy * n + sx];
        }
        return out;
      } },
    { k: 'blur', name: '模糊', params: [{ k: 'r', label: '半径', min: 0, max: 40, step: 0.5, def: 6 },
      { k: 'amount', label: '强度', min: 0, max: 1, step: 0.02, def: 1 }],
      fn: function (f, n, p, t, hl) {
        var r = Math.max(0, Math.round(p.r));
        if (r < 1 || p.amount <= 0) return f;
        var tmp = new Float32Array(f.length), out = new Float32Array(f.length);
        hl.boxH(f, tmp, n, r); hl.boxV(tmp, out, n, r);
        hl.boxH(out, tmp, n, Math.max(1, r >> 1)); hl.boxV(tmp, out, n, Math.max(1, r >> 1));
        if (p.amount >= 1) return out;
        for (var i = 0; i < f.length; i++) out[i] = f[i] * (1 - p.amount) + out[i] * p.amount;
        return out;
      } },
    { k: 'bloom', name: '泛光', params: [{ k: 'thr', label: '阈值', min: 0, max: 1, step: 0.01, def: 0.6 },
      { k: 'r', label: '半径', min: 1, max: 40, step: 1, def: 10 }, { k: 'amount', label: '强度', min: 0, max: 1.5, step: 0.02, def: 0.6 }],
      fn: function (f, n, p, t, hl) {
        if (p.amount <= 0) return f;
        var bright = new Float32Array(f.length), thr = p.thr;
        for (var i = 0; i < f.length; i++) { var v = (f[i] - thr) / Math.max(0.001, 1 - thr); bright[i] = v > 0 ? v : 0; }
        var tmp = new Float32Array(f.length), out = new Float32Array(f.length);
        var r = Math.max(1, Math.round(p.r));
        hl.boxH(bright, tmp, n, r); hl.boxV(tmp, out, n, r);
        var res = new Float32Array(f.length);
        for (var j = 0; j < f.length; j++) { var v2 = f[j] + out[j] * p.amount; res[j] = v2 > 1 ? 1 : v2; }
        return res;
      } },
    { k: 'sharpen', name: '锐化', params: [{ k: 'amount', label: '强度', min: 0, max: 3, step: 0.05, def: 0.8 },
      { k: 'r', label: '半径', min: 1, max: 12, step: 1, def: 2 }],
      fn: function (f, n, p, t, hl) {
        if (p.amount <= 0) return f;
        var tmp = new Float32Array(f.length), soft = new Float32Array(f.length);
        var r = Math.max(1, Math.round(p.r));
        hl.boxH(f, tmp, n, r); hl.boxV(tmp, soft, n, r);
        var out = new Float32Array(f.length);
        for (var i = 0; i < f.length; i++) { var v = f[i] + (f[i] - soft[i]) * p.amount; out[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
        return out;
      } },
    { k: 'edge', name: '边缘检测', params: [{ k: 'amount', label: '强度', min: 0, max: 4, step: 0.05, def: 1.2 },
      { k: 'invert', label: '反相', min: 0, max: 1, step: 1, def: 0, enum: ['否', '是'] }],
      fn: function (f, n, p) {
        var out = new Float32Array(f.length);
        var at = function (x, y) { return f[Math.max(0, Math.min(n - 1, y)) * n + Math.max(0, Math.min(n - 1, x))]; };
        for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
          var gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
          var gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
          var m = Math.hypot(gx, gy) * p.amount;
          if (m > 1) m = 1;
          out[y * n + x] = p.invert > 0.5 ? 1 - m : m;
        }
        return out;
      } },
    { k: 'posterize', name: '阶调化', params: [{ k: 'steps', label: '阶数', min: 2, max: 16, step: 1, def: 5 },
      { k: 'mix', label: '强度', min: 0, max: 1, step: 0.02, def: 1 }],
      fn: function (f, n, p) {
        var s = Math.max(2, Math.round(p.steps)), out = new Float32Array(f.length), ia = 1 - p.mix;
        for (var i = 0; i < f.length; i++) {
          var q = Math.round(f[i] * (s - 1)) / (s - 1);
          out[i] = q * p.mix + f[i] * ia;
        }
        return out;
      } },
    { k: 'vignette', name: '暗角', params: [{ k: 'amount', label: '强度', min: 0, max: 1, step: 0.02, def: 0.6 },
      { k: 'radius', label: '影响半径', min: 0.2, max: 1.6, step: 0.02, def: 0.9 }],
      fn: function (f, n, p) {
        var out = new Float32Array(f.length), half = n / 2, R = p.radius * half;
        for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
          var d = Math.hypot(x - half, y - half) / R;
          var k = d <= 1 ? 1 : Math.max(0, 1 - (d - 1) * 2);
          out[y * n + x] = f[y * n + x] * (1 - p.amount * (1 - k));
        }
        return out;
      } },
    { k: 'scanlines', name: '扫描线', params: [{ k: 'density', label: '密度', min: 4, max: 200, step: 1, def: 60 },
      { k: 'amount', label: '强度', min: 0, max: 1, step: 0.02, def: 0.35 }, { k: 'speed', label: '速度', min: 0, max: 2, step: 0.05, def: 0 }],
      fn: function (f, n, p, t) {
        var out = new Float32Array(f.length), ph = t * p.speed * Math.PI * 2;
        for (var y = 0; y < n; y++) {
          var s = 0.5 + 0.5 * Math.sin(y / n * p.density * Math.PI * 2 + ph);
          var k = 1 - p.amount * s;
          for (var x = 0; x < n; x++) out[y * n + x] = f[y * n + x] * k;
        }
        return out;
      } },
    { k: 'radialMask', name: '径向遮罩', params: [{ k: 'radius', label: '影响半径', min: 0.05, max: 1.5, step: 0.02, def: 0.7 },
      { k: 'feather', label: '羽化', min: 0.01, max: 1, step: 0.01, def: 0.3 }, { k: 'invert', label: '反向', min: 0, max: 1, step: 1, def: 0, enum: ['否', '是'] }],
      fn: function (f, n, p) {
        var out = new Float32Array(f.length), half = n / 2, R = p.radius * half;
        for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
          var d = Math.hypot(x - half, y - half);
          var k = 1 - Math.min(1, Math.max(0, (d - R) / (p.feather * half)));   // 圆内 1，边缘羽化到 0
          if (p.invert > 0.5) k = 1 - k;
          out[y * n + x] = f[y * n + x] * k;
        }
        return out;
      } }
  ];
  var POSTFX_BY_KEY = {};
  POSTFX.forEach(function (F) { POSTFX_BY_KEY[F.k] = F; });
  /** 卷积类要用的两个方向的一维盒式模糊（滑窗，O(n)） */
  var boxHelpers = {
    boxH: function (src, dst, n, r) {
      var win = r * 2 + 1;
      for (var y = 0; y < n; y++) {
        var row = y * n, sum = 0;
        for (var i = -r; i <= r; i++) sum += src[row + Math.min(n - 1, Math.max(0, i))];
        for (var x = 0; x < n; x++) {
          dst[row + x] = sum / win;
          sum += src[row + Math.min(n - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
        }
      }
    },
    boxV: function (src, dst, n, r) {
      var win = r * 2 + 1;
      for (var x = 0; x < n; x++) {
        var sum = 0;
        for (var i = -r; i <= r; i++) sum += src[Math.min(n - 1, Math.max(0, i)) * n + x];
        for (var y = 0; y < n; y++) {
          dst[y * n + x] = sum / win;
          sum += src[Math.min(n - 1, y + r + 1) * n + x] - src[Math.max(0, y - r) * n + x];
        }
      }
    }
  };
  /** 跑一层图层的后处理链；layer.fx 形如 { blur: {on:true, r:6, amount:1}, ... } */
  function applyPostFx(field, size, fx, t) {
    if (!fx) return field;
    var f = field;
    for (var i = 0; i < POSTFX.length; i++) {
      var F = POSTFX[i], cfg = fx[F.k];
      if (!cfg || !cfg.on) continue;
      f = F.fn(f, size, cfg, t, boxHelpers);
    }
    return f;
  }

  /* ───────────────────────────── 渲染引擎 ───────────────────────────── */
  var scratch = document.createElement('canvas');
  var scratchCtx = scratch.getContext('2d');
  var docCanvas = document.createElement('canvas');
  var docCtx = docCanvas.getContext('2d');
  var imgCache = {};

  /** 只算灰度场（0..1），不碰颜色 —— 后处理和自检都吃这个 */
  function renderField(layer, size, t) {
    var T = TYPE_BY_ID[layer.type];
    if (!T) return null;
    var fn = T.fn, P = layer.params, seed = layer.seed | 0;
    TILING = layer.tile !== false;
    var f = new Float32Array(size * size);
    var inv = 1 / size;
    for (var y = 0; y < size; y++) {
      var v0 = y * inv;
      for (var x = 0; x < size; x++) {
        var v = fn(P, x * inv, v0, t, seed);
        f[y * size + x] = (!(v >= 0)) ? 0 : (v > 1 ? 1 : v);   // NaN / 负数一律当 0，防呆
      }
    }
    return applyPostFx(f, size, layer.fx, t);
  }
  /** 把灰度场渲染到离屏画布上（上色 + 可选「亮度转透明」） */
  function renderLayerField(layer, size, t) {
    var f = renderField(layer, size, t);
    if (!f) return null;
    var c = document.createElement('canvas'); c.width = c.height = size;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(size, size);
    var d = img.data;
    var mode = layer.color.mode, ramp = RAMPS[layer.color.ramp] || RAMPS.火焰, tint = hex2rgb(layer.color.solid);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var v = f[y * size + x];
        var i = (y * size + x) * 4;
        if (mode === 'solid') { d[i] = tint[0]; d[i + 1] = tint[1]; d[i + 2] = tint[2]; }
        else if (mode === 'ramp') {
          if (!imgCache[ramp]) {
            var LUT = new Uint8Array(256 * 3);
            for (var q = 0; q < 256; q++) { var cc = rampAt(ramp, q / 255); LUT[q * 3] = cc[0]; LUT[q * 3 + 1] = cc[1]; LUT[q * 3 + 2] = cc[2]; }
            imgCache[ramp] = LUT;
          }
          var L = imgCache[ramp], k = (v * 255) | 0;
          d[i] = L[k * 3]; d[i + 1] = L[k * 3 + 1]; d[i + 2] = L[k * 3 + 2];
        } else { var g = (v * 255) | 0; d[i] = g; d[i + 1] = g; d[i + 2] = g; }
        d[i + 3] = layer.alphaFromLum && mode !== 'solid' ? (v * 255) | 0 : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** 图片图层：按 contain 放进画布，不变形 */
  function renderImageLayer(layer, size) {
    var img = layer._img;
    if (!img) return null;
    var P = layer.params || {};
    var c = document.createElement('canvas'); c.width = c.height = size;
    var ctx = c.getContext('2d');
    var fit = Math.min(size / img.width, size / img.height);
    var s = fit * (P.imgScale === undefined ? 1 : P.imgScale);
    var w = img.width * s, h = img.height * s;
    ctx.translate(size / 2 + (P.imgX || 0) * size, size / 2 + (P.imgY || 0) * size);
    ctx.rotate((P.imgRot || 0) * Math.PI / 180);
    ctx.scale(P.imgFlipX ? -1 : 1, P.imgFlipY ? -1 : 1);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return c;
  }

  /** 合成整个文档 */
  function renderDoc(t) {
    var size = doc.size;
    if (docCanvas.width !== size) { docCanvas.width = docCanvas.height = size; }
    docCtx.clearRect(0, 0, size, size);
    for (var i = 0; i < doc.layers.length; i++) {
      var l = doc.layers[i];
      if (!l.visible) continue;
      var src = l.type === '__image' ? renderImageLayer(l, size) : renderLayerField(l, size, t);
      if (!src) continue;
      docCtx.globalAlpha = l.opacity;
      docCtx.globalCompositeOperation = l.blend;
      docCtx.drawImage(src, 0, 0);
    }
    docCtx.globalAlpha = 1;
    docCtx.globalCompositeOperation = 'source-over';
    return docCanvas;
  }

  /* ───────────────────────────── 无损 PNG 编码 ─────────────────────────────
     为什么不用 canvas.toBlob：画布内部是**预乘 alpha**，A=0 的像素 RGB 会被抹成 0。
     通道打包把 A 当数据用时，取回来就是坏的。所以这里自己写 PNG：
     zlib 用 stored 块（不压缩，但完全无损），CRC32 / Adler32 现算。            */
  var CRC_T = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf) { var c = 0xFFFFFFFF; for (var i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function adler32(buf) {
    var a = 1, b = 0;
    for (var i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  }
  function chunk(type, data) {
    var out = new Uint8Array(12 + data.length);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    var crcBuf = new Uint8Array(4 + data.length);
    for (var j = 0; j < 4; j++) crcBuf[j] = type.charCodeAt(j);
    crcBuf.set(data, 4);
    dv.setUint32(8 + data.length, crc32(crcBuf));
    return out;
  }
  function zlibStore(raw) {
    var blocks = [], MAX = 65535;
    for (var off = 0; off < raw.length; off += MAX) {
      var len = Math.min(MAX, raw.length - off);
      var last = (off + len >= raw.length) ? 1 : 0;
      var h = new Uint8Array(5 + len);
      h[0] = last; h[1] = len & 255; h[2] = (len >>> 8) & 255; h[3] = (~len) & 255; h[4] = ((~len) >>> 8) & 255;
      h.set(raw.subarray(off, off + len), 5);
      blocks.push(h);
    }
    var total = 2 + blocks.reduce(function (a, b) { return a + b.length; }, 0) + 4;
    var out = new Uint8Array(total), p = 0;
    out[p++] = 0x78; out[p++] = 0x01;
    blocks.forEach(function (b) { out.set(b, p); p += b.length; });
    var ad = adler32(raw), dv = new DataView(out.buffer);
    dv.setUint32(p, ad);
    return out;
  }
  function encodePNG(w, h, rgba) {
    var stride = w * 4;
    var raw = new Uint8Array(h * (stride + 1));
    for (var y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
    var ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    var parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibStore(raw)), chunk('IEND', new Uint8Array(0))];
    var len = parts.reduce(function (a, b) { return a + b.length; }, 0);
    var out = new Uint8Array(len), q = 0;
    parts.forEach(function (b) { out.set(b, q); q += b.length; });
    return out;
  }

  /* ───────────────────────────── 导出 ───────────────────────────── */
  function download(name, blobOrBytes, type) {
    var blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], { type: type || 'image/png' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

  function exportPNG() {
    renderDoc(tNow);
    docCanvas.toBlob(function (b) { if (b) download('texture-' + stamp() + '.png', b); }, 'image/png');
  }
  /** 由灰度生成切线空间法线图 */
  function exportNormal() {
    var size = doc.size;
    var src = renderDoc(tNow);
    var tmp = document.createElement('canvas'); tmp.width = tmp.height = size;
    var tctx = tmp.getContext('2d'); tctx.drawImage(src, 0, 0);
    var sd = tctx.getImageData(0, 0, size, size).data;
    var lum = new Float32Array(size * size);
    for (var i = 0; i < size * size; i++) lum[i] = (sd[i * 4] * 0.299 + sd[i * 4 + 1] * 0.587 + sd[i * 4 + 2] * 0.114) / 255;
    var out = new Uint8Array(size * size * 4);
    var strength = 2.2;
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
      var xm = (x - 1 + size) % size, xp = (x + 1) % size, ym = (y - 1 + size) % size, yp = (y + 1) % size;
      var dx = (lum[y * size + xp] - lum[y * size + xm]) * strength;
      var dy = (lum[yp * size + x] - lum[ym * size + x]) * strength;
      var nz = 1, len = Math.sqrt(dx * dx + dy * dy + nz * nz);
      var k = (y * size + x) * 4;
      out[k] = ((-dx / len) * 0.5 + 0.5) * 255;
      out[k + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out[k + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      out[k + 3] = 255;
    }
    download('normal-' + stamp() + '.png', encodePNG(size, size, out));
  }
  /* ── 序列帧导出：编号 PNG 打包成 zip ──
     不用 GIF 的两个理由：① 动画贴图喂引擎/AE 要的是**带透明通道的序列帧**，GIF 只有 1 位透明、还限 256 色；
     ② 自己写 GIF 编码器（LZW + 调色板量化）出来的质量还不如浏览器自己的 PNG 编码器。
     所以：每帧用 canvas.toBlob 出 PNG（浏览器自己的编码器，体积小），再用 store 模式打成 zip
     —— PNG 已经是压缩数据，zip 再压一遍没用。 */
  function zipStore(files) {
    var chunks = [], central = [], offset = 0, total = 0;
    files.forEach(function (f) {
      var nameBytes = new TextEncoder().encode(f.name);
      var crc = crc32(f.data), len = f.data.length;
      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);          // 本地文件头
      dv.setUint16(4, 20, true);                  // 需要的版本
      dv.setUint16(6, 0, true);                   // 标志位
      dv.setUint16(8, 0, true);                   // 压缩方式 0 = store
      dv.setUint16(10, 0, true);                  // 时间（固定值 → 同样内容出同样字节）
      dv.setUint16(12, 0x0021, true);             // 日期 1980-01-01
      dv.setUint32(14, crc, true);
      dv.setUint32(18, len, true);
      dv.setUint32(22, len, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);
      var ch = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);          // 中央目录
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x0021, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, len, true);
      cv.setUint32(24, len, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);
      chunks.push(lh, f.data);
      central.push(ch);
      offset += lh.length + len;
      total += 1;
    });
    var centralSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);            // 中央目录结束记录
    ev.setUint16(8, total, true);
    ev.setUint16(10, total, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    var out = new Uint8Array(offset + centralSize + 22), p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    central.forEach(function (c) { out.set(c, p); p += c.length; });
    out.set(eocd, p);
    return out;
  }
  function canvasToPngBytes(canvas) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) {
        if (!b) { resolve(null); return; }
        b.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); });
      }, 'image/png');
    });
  }
  /** 导出序列帧：t 从 0 到 1 均匀取 frames 帧，编号命名，打包成 zip */
  async function exportSequence(frames, prefix) {
    var size = doc.size, files = [], i;
    for (i = 0; i < frames; i++) {
      var src = renderDoc(i / frames);
      var c = document.createElement('canvas'); c.width = c.height = size;
      var ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0);
      var bytes = await canvasToPngBytes(c);
      if (!bytes) continue;
      var n2 = String(i + 1);
      while (n2.length < 4) n2 = '0' + n2;
      files.push({ name: prefix + '_' + n2 + '.png', data: bytes });
      if (typeof updateSeqProgress === 'function') updateSeqProgress(i + 1, frames);
    }
    if (!files.length) { toast('导出失败：这一帧都没渲染出来'); return 0; }
    var zip = zipStore(files);
    var kb = Math.round(zip.length / 1024);
    download(prefix + '_' + frames + 'f_' + stamp() + '.zip', new Blob([zip], { type: 'application/zip' }));
    toast('已导出 ' + files.length + ' 帧（' + kb + ' KB）');
    return files.length;
  }

  /* ───────────────── 翻转书 / 序列图（UE5 Flipbook 那种）─────────────────
     和「平铺检查」不是一回事：平铺检查是把整幅画面无缝拼起来看接缝（做无缝贴图用的）；
     翻转书是**每格一个独立小元素 + 四周留白**，是喂粒子 / Flipbook / Sprite 的格式。
     参考图那种效果靠三个量：每格尺寸（常见 128）、元素占比（留白多少）、
     元素遮罩（柔边圆形 —— 没有它，整幅噪波缩进格子里只会是一小块方形噪波，不是元素）。 */
  var sheetCfg = { cols: 8, rows: 8, cell: 128, inset: 0.55, mask: 'soft', mode: 'random', bg: 'transparent', spin: 0 };

  /** 纯函数：算每一格的位置和"元素框" —— 自检能直接验，不必依赖画布 */
  function sheetLayout(cfg, cell) {
    var c = cell || cfg.cell, cells = [];
    for (var i = 0; i < cfg.cols * cfg.rows; i++) {
      var x = (i % cfg.cols) * c, y = Math.floor(i / cfg.cols) * c;
      var e = c * cfg.inset, off = (c - e) / 2;
      cells.push({ i: i, x: x, y: y, ex: x + off, ey: y + off, es: e });
    }
    return { cols: cfg.cols, rows: cfg.rows, cell: c, w: c * cfg.cols, h: c * cfg.rows, cells: cells };
  }
  function renderSheet(cfg, forceCell) {
    var cell = forceCell || cfg.cell;
    var savedSize = doc.size;
    var savedSeeds = doc.layers.map(function (l) { return l.seed; });
    doc.size = cell;
    var c = document.createElement('canvas');
    c.width = cell * cfg.cols; c.height = cell * cfg.rows;
    var ctx = c.getContext('2d');
    var n = cfg.cols * cfg.rows;
    for (var i = 0; i < n; i++) {
      if (cfg.mode === 'random') doc.layers.forEach(function (l, k) { l.seed = (savedSeeds[k] + i * 7919) | 0; });
      var src = renderDoc(cfg.mode === 'time' ? i / n : 0.25);
      var L = sheetLayout(cfg, cell).cells[i];
      var x = L.x, y = L.y;
      // 元素先单独画在临时画布上：遮罩只作用于它，不会把刚填的背景也擦掉
      // （踩过：直接在主画布上用 destination-in，白底一起被清成透明）
      var tmp = document.createElement('canvas'); tmp.width = tmp.height = cell;
      var tc = tmp.getContext('2d');
      var s2 = L.es;
      tc.save();
      tc.translate(cell / 2, cell / 2);
      if (cfg.spin) tc.rotate((i / Math.max(1, n - 1)) * cfg.spin * Math.PI / 180);
      tc.drawImage(src, -s2 / 2, -s2 / 2, s2, s2);
      tc.restore();
      if (cfg.mask !== 'none') {
        var r = s2 * 0.5, cx = cell / 2, cy = cell / 2;
        tc.globalCompositeOperation = 'destination-in';
        if (cfg.mask === 'hard') {
          tc.fillStyle = '#000';
          tc.beginPath(); tc.arc(cx, cy, r, 0, TAU); tc.fill();
        } else {
          var g = tc.createRadialGradient(cx, cy, r * 0.3, cx, cy, r);
          g.addColorStop(0, 'rgba(0,0,0,1)');
          g.addColorStop(0.72, 'rgba(0,0,0,0.82)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          tc.fillStyle = g;
          tc.fillRect(0, 0, cell, cell);
        }
      }
      if (cfg.bg !== 'transparent') {
        ctx.fillStyle = cfg.bg === 'white' ? '#fff' : '#000';
        ctx.fillRect(x, y, cell, cell);
      }
      ctx.drawImage(tmp, x, y);
    }
    doc.layers.forEach(function (l, k) { l.seed = savedSeeds[k]; });
    doc.size = savedSize;
    return c;
  }
  var sheetTimer = null;
  function updateSheetPreview() {
    var cap = Math.max(14, Math.min(56, Math.floor(420 / Math.max(sheetCfg.cols, sheetCfg.rows))));
    var c = renderSheet(sheetCfg, cap);
    var pv = $('ws-sheet-preview');
    pv.width = c.width; pv.height = c.height;
    var ctx = pv.getContext('2d');
    ctx.clearRect(0, 0, pv.width, pv.height);
    ctx.drawImage(c, 0, 0);
    $('ws-sheet-size').textContent = '输出 ' + (sheetCfg.cols * sheetCfg.cell) + ' × ' + (sheetCfg.rows * sheetCfg.cell)
      + ' · ' + (sheetCfg.cols * sheetCfg.rows) + ' 格 · 每格 ' + sheetCfg.cell + 'px';
  }
  function queueSheetPreview() { clearTimeout(sheetTimer); sheetTimer = setTimeout(updateSheetPreview, 80); }
  function openSheet() {
    $('ws-sheet-cols').value = sheetCfg.cols;
    $('ws-sheet-rows').value = sheetCfg.rows;
    $('ws-sheet-cell').value = String(sheetCfg.cell);
    $('ws-sheet-inset').value = sheetCfg.inset;
    $('ws-sheet-inset-num').value = sheetCfg.inset;
    $('ws-sheet-mask').value = sheetCfg.mask;
    $('ws-sheet-mode').value = sheetCfg.mode;
    $('ws-sheet-bg').value = sheetCfg.bg;
    $('ws-sheet-spin').value = sheetCfg.spin;
    $('ws-sheet-spin-num').value = sheetCfg.spin;
    updateSheetPreview();
    $('ws-sheet-dialog').showModal();
  }
  function exportSheet() {
    var c = renderSheet(sheetCfg);
    var name = 'flipbook-' + sheetCfg.cols + 'x' + sheetCfg.rows + '-' + sheetCfg.cell + 'px-' + stamp() + '.png';
    c.toBlob(function (b) { if (b) download(name, b); }, 'image/png');
    $('ws-sheet-dialog').close();
    toast('已导出翻转书 ' + sheetCfg.cols + '×' + sheetCfg.rows + '（每格 ' + sheetCfg.cell + 'px）');
  }

  /** 通道打包：直接算灰度场，不经过画布 */
  function exportPack(mapCh) {
    var size = doc.size, out = new Uint8Array(size * size * 4);
    var CH = ['R', 'G', 'B', 'A'];
    for (var ch = 0; ch < 4; ch++) {
      var id = mapCh[CH[ch]];
      var layer = null;
      if (id === 'doc') layer = null;
      else layer = doc.layers.filter(function (l) { return l.id === id; })[0];
      var field = null;
      if (layer) {
        var src = layer.type === '__image' ? renderImageLayer(layer, size) : renderLayerField(layer, size, tNow);
        if (src) {
          var sd = src.getContext('2d').getImageData(0, 0, size, size).data;
          field = new Uint8Array(size * size);
          for (var i = 0; i < size * size; i++) field[i] = (sd[i * 4] * 0.299 + sd[i * 4 + 1] * 0.587 + sd[i * 4 + 2] * 0.114) | 0;
        }
      } else {
        var dsrc = renderDoc(tNow);
        var tmp = document.createElement('canvas'); tmp.width = tmp.height = size;
        var tc = tmp.getContext('2d'); tc.drawImage(dsrc, 0, 0);
        var dd = tc.getImageData(0, 0, size, size).data;
        field = new Uint8Array(size * size);
        for (var j = 0; j < size * size; j++) field[j] = dd[j * 4];
      }
      if (!field) continue;
      for (var k = 0; k < size * size; k++) out[k * 4 + ch] = field[k];
    }
    download('packed-rgba-' + stamp() + '.png', encodePNG(size, size, out));
  }

  /* ───────────────────────────── UI 基础 ───────────────────────────── */
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  var toastEl = h('div', { class: 'ws-toast' });
  document.body.appendChild(toastEl);
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2000);
  }

  /* ───────────────────────────── 状态 ───────────────────────────── */
  var selId = null;
  var tNow = 0, playing = false, playRaf = 0;
  var tileN = 1, zoomMode = 'fit';
  var filterCat = '全部', filterText = '';
  // 收藏 / 最近（存本机，不上传）
  var favs = {}, recent = [];
  try { favs = JSON.parse(localStorage.getItem('vfx-ws-favs') || '{}') || {}; } catch (e) { favs = {}; }
  try { recent = JSON.parse(localStorage.getItem('vfx-ws-recent') || '[]') || []; } catch (e) { recent = []; }
  function saveFavs() { try { localStorage.setItem('vfx-ws-favs', JSON.stringify(favs)); } catch (e) {} }
  function markRecent(id) {
    recent = [id].concat(recent.filter(function (x) { return x !== id; })).slice(0, 12);
    try { localStorage.setItem('vfx-ws-recent', JSON.stringify(recent)); } catch (e) {}
  }
  var history = [], future = [];
  try {
    var saved = localStorage.getItem('vfx-workshop-doc');
    if (saved) { doc = JSON.parse(saved); uid = doc.layers.length + 1; }
    else doc = defaultDoc();
  } catch (e) { doc = defaultDoc(); }
  if (!doc.layers || !doc.layers.length) doc = defaultDoc();
  selId = doc.layers[0].id;

  function serialize() { return JSON.stringify({ v: 1, size: doc.size, bg: doc.bg, layers: doc.layers }); }
  function persist() { try { localStorage.setItem('vfx-workshop-doc', serialize()); } catch (e) { /* 图太大就算了 */ } }
  function snapshot() {
    history.push(serialize());
    if (history.length > 40) history.shift();
    future.length = 0;
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    $('ws-undo').disabled = !history.length;
    $('ws-redo').disabled = !future.length;
  }
  function restore(json) {
    var d = JSON.parse(json);
    doc.size = d.size; doc.bg = d.bg; doc.layers = d.layers;
    doc.layers.forEach(function (l) { if (l.type === '__image' && l.image && !l._img) { var im = new Image(); im.src = l.image; l._img = im; im.onload = function () { draw(); }; } });
    if (!doc.layers.some(function (l) { return l.id === selId; })) selId = doc.layers[0] ? doc.layers[0].id : null;
    rebuildAll();
  }
  function undo() { if (!history.length) return; future.push(serialize()); restore(history.pop()); updateHistoryButtons(); }
  function redo() { if (!future.length) return; history.push(serialize()); restore(future.pop()); updateHistoryButtons(); }
  function curLayer() { return doc.layers.filter(function (l) { return l.id === selId; })[0] || null; }
  function touch(rebuildParams) { persist(); draw(); if (rebuildParams) buildParams(); }

  /* ───────────────────────────── 舞台 ───────────────────────────── */
  var stageWrap = $('ws-canvas-wrap'), view = $('ws-canvas');
  /** 只决定「显示多大」——像素尺寸永远等于 画布尺寸 × 平铺数，缩放交给 CSS */
  function applyZoom() {
    var n = doc.size * tileN;
    var stage = $('ws-stage');
    var availW = Math.max(160, stage.clientWidth - 48);
    var availH = Math.max(200, stage.clientHeight - 48);
    var scale = zoomMode === 'fit' ? Math.min(availW / n, availH / n) : 1;
    scale = clamp(scale, 0.05, 4);
    view.style.width = (n * scale) + 'px';
    view.style.height = (n * scale) + 'px';
  }
  function draw() {
    var t0 = performance.now();
    var src = renderDoc(tNow);
    var n = doc.size * tileN;
    if (view.width !== n || view.height !== n) { view.width = n; view.height = n; }
    var ctx = view.getContext('2d');
    ctx.clearRect(0, 0, n, n);
    for (var j = 0; j < tileN; j++) for (var i = 0; i < tileN; i++) {
      if (doc.bg === 'white' || doc.bg === 'black') {
        ctx.fillStyle = doc.bg === 'white' ? '#fff' : '#000';
        ctx.fillRect(i * doc.size, j * doc.size, doc.size, doc.size);
      }
      ctx.drawImage(src, i * doc.size, j * doc.size);
    }
    applyZoom();
    $('ws-perf').textContent = '渲染 ' + (performance.now() - t0).toFixed(0) + ' ms · ' + doc.size + '×' + doc.size + (tileN > 1 ? ' × ' + tileN + '×' + tileN : '');
  }

  /* ───────────────────────────── 类型浏览器 ───────────────────────────── */
  function renderThumb(T) {
    var S = 56;
    var c = document.createElement('canvas'); c.width = c.height = S;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(S, S), d = img.data;
    var P = {};
    T.params.forEach(function (p) { P[p.k] = p.def; });
    var seed = 12345;
    for (var y = 0; y < S; y++) for (var x = 0; x < S; x++) {
      var v = T.fn(P, x / S, y / S, 0.25, seed);
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      var g = (v * 255) | 0, i = (y * S + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  function buildBrowser() {
    var tabs = $('ws-cats');
    tabs.textContent = '';
    var TAB_EXTRA = ['收藏', '最近'];
    CATS_ALL.concat(TAB_EXTRA).forEach(function (cat) {
      var n = cat === '全部' ? TYPES.length
        : cat === '收藏' ? TYPES.filter(function (t) { return favs[t.id]; }).length
        : cat === '最近' ? recent.length
        : TYPES.filter(function (t) { return t.cat === cat; }).length;
      if ((cat === '收藏' || cat === '最近') && !n) return;      // 空的时候不占地方
      var b = h('button', { class: 'ws-tab', type: 'button', 'aria-pressed': String(cat === filterCat) }, [document.createTextNode(cat + ' ' + n)]);
      b.addEventListener('click', function () { filterCat = cat; buildBrowser(); });
      tabs.appendChild(b);
    });
    var list = $('ws-thumbs');
    list.textContent = '';
    var kw = filterText.trim().toLowerCase();
    var shown = TYPES.filter(function (T) {
      if (filterCat === '收藏') { if (!favs[T.id]) return false; }
      else if (filterCat === '最近') { if (recent.indexOf(T.id) < 0) return false; }
      else if (filterCat !== '全部' && T.cat !== filterCat) return false;
      if (!kw) return true;
      return (T.name + ' ' + T.cat + ' ' + T.tags.join(' ')).toLowerCase().indexOf(kw) >= 0;
    });
    if (filterCat === '最近') shown.sort(function (a, b) { return recent.indexOf(a.id) - recent.indexOf(b.id); });
    $('ws-type-count').textContent = shown.length + ' / ' + TYPES.length + ' 种';
    if (!shown.length) { list.appendChild(h('p', { class: 'ws-empty', text: '没有匹配的类型。换个词，或点「全部」清掉筛选。' })); return; }
    shown.forEach(function (T) {
      var badges = [];
      if (T.tile) badges.push('无缝');
      if (T.anim) badges.push('动态');
      var btn = h('button', { class: 'ws-thumb', type: 'button', title: T.name + (badges.length ? '（' + badges.join(' / ') + '）' : '') }, [
        renderThumb(T),
        h('span', { class: 'ws-thumb-name', text: T.name }),
        h('span', { class: 'ws-thumb-tags', text: badges.length ? badges.join(' · ') : '静态' })
      ]);
      btn.addEventListener('click', function () {
        markRecent(T.id);
        var l = curLayer();
        if (!l) { addLayer(T.id); return; }
        snapshot();
        var fresh = newLayer(T.id);
        l.type = T.id; l.name = T.name; l.params = fresh.params; l.color = l.color || fresh.color;
        if (l.type === '__image') { delete l.image; delete l._img; }
        rebuildAll();
        toast('已切换成「' + T.name + '」');
      });
      var star = h('span', { class: 'ws-star' + (favs[T.id] ? ' is-on' : ''), role: 'button', title: '收藏 / 取消收藏', text: favs[T.id] ? '★' : '☆' });
      star.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        favs[T.id] = !favs[T.id];
        saveFavs(); buildBrowser();
      });
      var shell = h('div', { class: 'ws-thumb-shell' });
      shell.appendChild(btn); shell.appendChild(star);
      list.appendChild(shell);
    });
  }

  /* ───────────────────────────── 参数面板 ───────────────────────────── */
  function buildParams() {
    var box = $('ws-params');
    box.textContent = '';
    var l = curLayer();
    if (!l) { box.appendChild(h('p', { class: 'ws-empty', text: '还没有选中图层。右边点「＋ 新建」加一层。' })); return; }

    if (l.type === '__image') {
      box.appendChild(h('p', { class: 'ws-note', text: '这是一个图片图层：原图直接当素材用，下面是它的变换（等比缩放，不会拉变形）。' }));
      [{ k: 'imgScale', label: '缩放', min: 0.05, max: 4, step: 0.01, def: 1 },
       { k: 'imgX', label: '左右位移', min: -1, max: 1, step: 0.01, def: 0 },
       { k: 'imgY', label: '上下位移', min: -1, max: 1, step: 0.01, def: 0 },
       { k: 'imgRot', label: '旋转°', min: -180, max: 180, step: 1, def: 0 }].forEach(function (pp) {
        if (l.params[pp.k] === undefined) l.params[pp.k] = pp.def;
        var slider = sliderInput(pp, l.params, function () { draw(); });
        var num = numInput(pp, l.params, pp.def);
        slider.addEventListener('input', function () { num.value = slider.value; });
        box.appendChild(h('div', { class: 'ws-param' }, [h('div', { class: 'ws-param-label', text: pp.label }), slider, num]));
      });
      [['imgFlipX', '水平翻转'], ['imgFlipY', '垂直翻转']].forEach(function (pp) {
        var cb = h('input', { type: 'checkbox' });
        cb.checked = !!l.params[pp[0]];
        cb.addEventListener('change', function () { snapshot(); l.params[pp[0]] = cb.checked; touch(false); });
        box.appendChild(h('label', { class: 'ws-check' }, [cb, h('span', { text: pp[1] })]));
      });
    } else {
      var T = TYPE_BY_ID[l.type];
      if (T && T.params.length) {
        T.params.forEach(function (p) { box.appendChild(paramRow(p, l)); });
      } else {
        box.appendChild(h('p', { class: 'ws-empty', text: '这个类型没有可调参数。' }));
      }
    }

    // ── 连续（四方连续开关）──
    var tileBox = h('input', { type: 'checkbox' });
    tileBox.checked = l.tile !== false;
    tileBox.addEventListener('change', function () { snapshot(); l.tile = tileBox.checked; touch(false); });
    box.appendChild(h('div', { class: 'ws-param-group', text: '连续' }));
    box.appendChild(h('label', { class: 'ws-check' }, [tileBox,
      h('span', { text: '四方连续（整数密度下平铺无缝）' })]));

    // ── 后处理（对齐了同类工具里最常用的 11 项）──
    box.appendChild(h('div', { class: 'ws-param-group', text: '后处理' }));
    var fxOn = 0;
    POSTFX.forEach(function (F) {
      if (!l.fx) l.fx = {};
      var cfg = l.fx[F.k] || (l.fx[F.k] = { on: false });
      F.params.forEach(function (p) { if (cfg[p.k] === undefined) cfg[p.k] = p.def; });
      var box2 = h('input', { type: 'checkbox' });
      box2.checked = !!cfg.on;
      box2.addEventListener('change', function () { snapshot(); cfg.on = box2.checked; touch(true); });
      box.appendChild(h('label', { class: 'ws-fx-head' + (cfg.on ? ' is-on' : '') }, [box2, h('span', { text: F.name })]));
      if (cfg.on) {
        fxOn++;
        var fxBody = h('div', { class: 'ws-fx-body' });
        F.params.forEach(function (p) { fxBody.appendChild(paramRow(p, { params: cfg })); });
        box.appendChild(fxBody);
      }
    });
    if (!fxOn) box.appendChild(h('p', { class: 'ws-note', text: '后处理是形状做完之后的加工：模糊、泛光、像素化、暗角这些。勾一个试试。' }));

    // ── 着色 ──
    box.appendChild(h('div', { class: 'ws-param-group', text: '着色' }));
    var seg = h('div', { class: 'ws-seg', style: 'margin:2px 0 6px' });
    [['gray', '灰度'], ['ramp', '色阶'], ['solid', '单色']].forEach(function (m) {
      var b = h('button', { type: 'button', 'aria-pressed': String(l.color.mode === m[0]) }, [document.createTextNode(m[1])]);
      b.addEventListener('click', function () { snapshot(); l.color.mode = m[0]; touch(true); });
      seg.appendChild(b);
    });
    box.appendChild(seg);
    if (l.color.mode === 'ramp') {
      var sel = h('select');
      Object.keys(RAMPS).forEach(function (k) {
        var o = h('option', { value: k }, [document.createTextNode(k)]);
        if (l.color.ramp === k) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { snapshot(); l.color.ramp = sel.value; touch(false); });
      box.appendChild(h('div', { class: 'ws-param' }, [h('div', { class: 'ws-param-label', text: '色阶' }), sel, h('div')]));
    } else if (l.color.mode === 'solid') {
      var col = h('input', { type: 'color', value: l.color.solid, style: 'width:100%;height:34px;padding:2px' });
      col.addEventListener('input', function () { l.color.solid = col.value; touch(false); });
      box.appendChild(h('div', { class: 'ws-param' }, [h('div', { class: 'ws-param-label', text: '颜色' }), col, h('div')]));
    }
    var chk = h('label', { class: 'ws-check' }, [
      (function () { var i = h('input', { type: 'checkbox' }); i.checked = !!l.alphaFromLum; i.addEventListener('change', function () { snapshot(); l.alphaFromLum = i.checked; touch(false); }); return i; })(),
      h('span', { text: '亮度转透明（把黑底变透明）' })
    ]);
    box.appendChild(chk);

    // ── 合成 ──
    box.appendChild(h('div', { class: 'ws-param-group', text: '合成' }));
    box.appendChild(h('div', { class: 'ws-param' }, [
      h('div', { class: 'ws-param-label', text: '混合' }),
      (function () {
        var s = h('select');
        BLENDS.forEach(function (b) { var o = h('option', { value: b[0] }, [document.createTextNode(b[1])]); if (l.blend === b[0]) o.selected = true; s.appendChild(o); });
        s.addEventListener('change', function () { snapshot(); l.blend = s.value; touch(false); });
        return s;
      })(),
      h('div')
    ]));
    var op = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: l.opacity });
    var opN = h('input', { class: 'ws-num', type: 'number', min: 0, max: 1, step: 0.01, value: l.opacity });
    op.addEventListener('input', function () { l.opacity = +op.value; opN.value = op.value; draw(); });
    op.addEventListener('change', function () { persist(); });
    opN.addEventListener('change', function () { var v = clamp(+opN.value || 0, 0, 1); l.opacity = v; op.value = v; opN.value = v; touch(false); });
    box.appendChild(h('div', { class: 'ws-param' }, [h('div', { class: 'ws-param-label', text: '不透明度' }), op, opN]));

    // ── 种子 ──
    box.appendChild(h('div', { class: 'ws-param' }, [
      h('div', { class: 'ws-param-label', text: '随机种子' }),
      (function () { var b = h('button', { class: 'button secondary small', type: 'button', text: '换一组' }); b.addEventListener('click', function () { snapshot(); l.seed = (Math.random() * 1e6) | 0; touch(false); }); return b; })(),
      h('div', { class: 'ws-dim', text: String(l.seed).slice(0, 6) })
    ]));
  }
  function sliderInput(p, store, onInput) {
    var inp = h('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: store[p.k] });
    inp.addEventListener('input', function () { store[p.k] = +inp.value; draw(); });
    inp.addEventListener('change', function () { persist(); });
    return inp;
  }
  function numInput(p, store, def) {
    var inp = h('input', { class: 'ws-num', type: 'number', min: p.min, max: p.max, step: p.step, value: store[p.k] });
    inp.addEventListener('change', function () {
      var v = +inp.value;
      if (!isFinite(v)) v = def;
      v = clamp(v, p.min, p.max);
      v = Math.round(v / p.step) * p.step;
      v = +v.toFixed(6);
      store[p.k] = v; inp.value = v;
      var sib = inp.parentNode.querySelector('input[type=range]');
      if (sib) sib.value = v;
      persist(); draw();
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { inp.value = store[p.k]; inp.blur(); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        var d = (e.key === 'ArrowUp' ? 1 : -1) * (p.step || 1) * (e.shiftKey ? 10 : 1);
        inp.value = +(clamp(store[p.k] + d, p.min, p.max)).toFixed(6);
        inp.dispatchEvent(new Event('change'));
      }
    });
    return inp;
  }
  function paramRow(p, l) {
    var store = l.params;
    var slider = sliderInput(p, store, null);
    var num = numInput(p, store, p.def);
    slider.addEventListener('input', function () { num.value = slider.value; });
    var reset = function () {
      store[p.k] = p.def; slider.value = p.def; num.value = p.def;
      snapshot(); touch(false);
    };
    num.addEventListener('dblclick', reset);
    slider.addEventListener('dblclick', reset);
    if (p.enum) {
      var sel = h('select');
      p.enum.forEach(function (label, i) { var o = h('option', { value: i }, [document.createTextNode(label)]); if (Math.round(store[p.k]) === i) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', function () { store[p.k] = +sel.value; touch(false); });
      return h('div', { class: 'ws-param' }, [h('div', { class: 'ws-param-label', text: p.label }), sel, h('div', { class: 'ws-dim', text: '' })]);
    }
    return h('div', { class: 'ws-param' }, [h('div', { class: 'ws-param-label', text: p.label }), slider, num]);
  }

  /* ───────────────────────────── 图层列表 ───────────────────────────── */
  function buildLayers() {
    var ul = $('ws-layers');
    ul.textContent = '';
    doc.layers.slice().reverse().forEach(function (l) {
      var eye = h('button', { class: 'ws-layer-eye', type: 'button', title: '显示 / 隐藏', text: l.visible ? '◉' : '○' });
      eye.addEventListener('click', function (e) { e.stopPropagation(); snapshot(); l.visible = !l.visible; rebuildAll(); });
      var info = h('div', { style: 'min-width:0' }, [
        h('div', { class: 'ws-layer-name', text: l.name }),
        h('div', { class: 'ws-layer-sub', text: blendLabel(l.blend) + ' · ' + Math.round(l.opacity * 100) + '%' })
      ]);
      var up = h('button', { class: 'ws-icon-btn', type: 'button', title: '上移', text: '↑' });
      var dn = h('button', { class: 'ws-icon-btn', type: 'button', title: '下移', text: '↓' });
      var cp = h('button', { class: 'ws-icon-btn', type: 'button', title: '复制', text: '⧉' });
      var rm = h('button', { class: 'ws-icon-btn', type: 'button', title: '删除', text: '✕' });
      function move(dir) {
        var i = doc.layers.indexOf(l), j = i + dir;
        if (j < 0 || j >= doc.layers.length) return;
        snapshot();
        doc.layers.splice(i, 1); doc.layers.splice(j, 0, l);
        rebuildAll();
      }
      up.addEventListener('click', function (e) { e.stopPropagation(); move(1); });
      dn.addEventListener('click', function (e) { e.stopPropagation(); move(-1); });
      cp.addEventListener('click', function (e) { e.stopPropagation(); snapshot(); var c = cloneLayer(l); doc.layers.splice(doc.layers.indexOf(l) + 1, 0, c); selId = c.id; rebuildAll(); });
      rm.addEventListener('click', function (e) {
        e.stopPropagation();
        if (doc.layers.length <= 1) { toast('至少留一层'); return; }
        snapshot();
        doc.layers = doc.layers.filter(function (x) { return x !== l; });
        if (selId === l.id) selId = doc.layers[doc.layers.length - 1].id;
        rebuildAll();
      });
      var row = h('li', { class: 'ws-layer' + (l.visible ? '' : ' is-off'), 'aria-selected': String(l.id === selId) }, [
        eye, info, h('div', { class: 'ws-layer-acts' }, [up, dn, cp, rm])
      ]);
      row.addEventListener('click', function () { selId = l.id; buildLayers(); buildParams(); });
      ul.appendChild(row);
    });
  }
  function blendLabel(v) {
    for (var i = 0; i < BLENDS.length; i++) if (BLENDS[i][0] === v) return BLENDS[i][1];
    return v;
  }

  /* ───────────────────────────── 增删图层 ───────────────────────────── */
  function addLayer(typeId) {
    snapshot();
    var l = newLayer(typeId || (curLayer() ? curLayer().type : 'fbm'));
    l.seed = (Math.random() * 1e6) | 0;
    doc.layers.push(l);
    selId = l.id;
    rebuildAll();
  }
  function rebuildAll() { buildLayers(); buildParams(); buildBrowser(); syncStageControls(); draw(); persist(); }

  /* ───────────────────────────── 舞台控件 ───────────────────────────── */
  function syncStageControls() {
    [['ws-bg', doc.bg], ['ws-tile', String(tileN)], ['ws-zoom', zoomMode]].forEach(function (pair) {
      var box = $(pair[0]);
      Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === pair[1]));
      });
    });
    var l = curLayer();
    var T = l && l.type !== '__image' ? TYPE_BY_ID[l.type] : null;
    var anim = !!(T && T.anim);
    $('ws-play').disabled = !anim;
    $('ws-time').disabled = !anim;
  }
  function bindSeg(id, fn) {
    Array.prototype.forEach.call($(id).querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { fn(b.getAttribute('data-v')); });
    });
  }

  /* ───────────────────────────── 导出对话框 ───────────────────────────── */
  function buildExportDialog() {
    var list = $('ws-export-list');
    list.textContent = '';
    var items = [
      ['PNG 贴图', '把当前画面导出成 PNG，保留透明。这是最常用的一个。', '下载 PNG', function () { exportPNG(); }],
      ['法线图', '由当前画面的灰度生成切线空间法线图（绿通道向上），直接能给引擎用。', '下载法线图', function () { exportNormal(); }],
      ['序列帧（zip）', '把动画按帧导出成编号 PNG（每秒 24 帧就导 24 张），打包成一个 zip —— AE、UE5、Nuke 直接吃。带完整透明通道，比 GIF 实用。', '导出序列帧', function () { $('ws-export-dialog').close(); askSequence(); }],
      ['翻转书 / 序列图', '一张图排 N×N 格，每格一个小元素、四周留白 —— UE5 Flipbook / 粒子贴图 / Sprite Sheet 都是这个格式。每格尺寸、留白多少、柔边遮罩都能调。', '打开设置', function () { $('ws-export-dialog').close(); openSheet(); }],
      ['通道打包', '把不同图层分别写进 R / G / B / A，压成一张 PNG。', '打开设置', function () { $('ws-export-dialog').close(); openPack(); }],
      ['复制到剪贴板', '直接粘进引擎、聊天窗或文档里。', '复制', function () { copyToClipboard(); }]
    ];
    items.forEach(function (it) {
      var btn = h('button', { class: 'button secondary small', type: 'button', text: it[2] });
      btn.addEventListener('click', it[3]);
      list.appendChild(h('div', { class: 'ws-export-item' }, [
        h('div', {}, [h('h3', { text: it[0] }), h('p', { text: it[1] })]), btn
      ]));
    });
  }
  function copyToClipboard() {
    renderDoc(tNow);
    docCanvas.toBlob(function (b) {
      if (!b) return;
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).then(function () { toast('已复制到剪贴板'); }, function () { toast('浏览器拒绝了剪贴板，请用「下载 PNG」'); });
      } else { toast('这个浏览器不支持直接复制，请用「下载 PNG」'); }
    }, 'image/png');
  }
  function askSequence() {
    var n = parseInt(prompt('要导出多少帧？（建议 8–48；每帧是一张完整的 PNG）', '24') || '0', 10);
    if (!n || n < 2) { if (n) toast('至少 2 帧'); return; }
    if (n > 96) { toast('最多 96 帧（再多浏览器内存扛不住）'); return; }
    var p = prompt('文件名前缀：', 'frame') || 'frame';
    p = p.replace(/[^\w\-]/g, '') || 'frame';
    var name = '序列帧 ' + n + ' 帧 · 生成中…';
    toast(name);
    exportSequence(n, p).then(function (done) { if (done) persist(); });
  }

  /* ───────────────────────────── 通道打包 ───────────────────────────── */
  var packMap = { R: 'doc', G: null, B: null, A: null };
  function openPack() {
    var grid = $('ws-pack-grid');
    grid.textContent = '';
    [['R', 'r', '红通道', '一般放遮罩 / 主形状'], ['G', 'g', '绿通道', '一般放溶解 / 噪声'],
      ['B', 'b', '蓝通道', '一般放发光 / 高光'], ['A', 'a', 'Alpha 通道', '当数据用，无损写入']].forEach(function (c) {
      var sel = h('select');
      sel.appendChild(h('option', { value: 'doc' }, [document.createTextNode('（当前画面）')]));
      doc.layers.forEach(function (l) { sel.appendChild(h('option', { value: l.id }, [document.createTextNode(l.name)])); });
      var cur = packMap[c[0]];
      if (cur && cur !== 'doc' && !doc.layers.some(function (l) { return l.id === cur; })) cur = 'doc';
      sel.value = cur || 'doc';
      sel.addEventListener('change', function () { packMap[c[0]] = sel.value; });
      packMap[c[0]] = sel.value;
      grid.appendChild(h('div', { class: 'ws-pack-cell' }, [
        h('div', { class: 'ws-pack-head' }, [h('span', { class: 'ws-pack-sw ' + c[1], text: c[0] }), h('strong', { text: c[2] })]),
        h('div', { class: 'ws-field' }, [sel]),
        h('small', { text: c[3] })
      ]));
    });
    $('ws-pack-dialog').showModal();
  }

  /* ───────────────────────────── 存 / 读 / 分享 ───────────────────────────── */
  function saveDoc() {
    var data = new Blob([serialize()], { type: 'application/json' });
    download('texture-doc-' + stamp() + '.json', data);
  }
  function loadDocFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var d = JSON.parse(String(fr.result));
        if (!d.layers) throw new Error('bad');
        snapshot();
        doc.size = d.size || 512; doc.bg = d.bg || 'transparent'; doc.layers = d.layers;
        doc.layers.forEach(function (l) { if (l.type === '__image' && l.image) { var im = new Image(); im.src = l.image; l._img = im; im.onload = function () { draw(); }; } });
        selId = doc.layers[0].id;
        rebuildAll();
        toast('已读入文档');
      } catch (e) { toast('这个文件读不了'); }
    };
    fr.readAsText(file);
  }
  async function shareLink() {
    try {
      var json = serialize();
      var b64;
      if (window.CompressionStream) {
        var cs = new CompressionStream('deflate-raw');
        var w = cs.writable.getWriter(); w.write(new TextEncoder().encode(json)); w.close();
        var buf = await new Response(cs.readable).arrayBuffer();
        b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
        b64 = 'z' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      } else {
        b64 = 'p' + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }
      var url = location.origin + location.pathname + '#d=' + b64;
      if (url.length > 8000) { toast('图层太多了，链接会很长（' + url.length + ' 字符），建议改用「存文件」'); }
      try { await navigator.clipboard.writeText(url); toast('分享链接已复制'); }
      catch (e) { prompt('复制这个链接：', url); }
    } catch (e) { toast('生成分享链接失败，请用「存文件」'); }
  }
  async function readHash() {
    var m = /[#&]d=([^&]+)/.exec(location.hash || '');
    if (!m) return false;
    try {
      var s = m[1], mode = s[0];
      s = s.slice(1).replace(/-/g, '+').replace(/_/g, '/');
      var bin = atob(s);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var json;
      if (mode === 'z' && window.DecompressionStream) {
        var ds = new DecompressionStream('deflate-raw');
        var w = ds.writable.getWriter(); w.write(bytes); w.close();
        json = await new Response(ds.readable).text();
      } else { json = decodeURIComponent(escape(bin)); }
      var d = JSON.parse(json);
      if (!d.layers) return false;
      doc.size = d.size || 512; doc.bg = d.bg || 'transparent'; doc.layers = d.layers;
      selId = doc.layers[0].id;
      return true;
    } catch (e) { return false; }
  }

  /* ───────────────────────────── 无缝化 ─────────────────────────────
     为什么这样算：把画面和它的**四向镜像**（左右、上下、对角）做加权平均之后，
     out(0,y) 与 out(w-1,y) 是同一个平均值 —— 也就是说平铺时左右/上下边界**在数学上完全相等**，
     接缝为 0（不是「看起来好一点」，是可测的 0 差）。
     代价：结果是四向对称的，细节会软一点，所以给了强度（amount）；amount<1 时接缝按 (1-amount) 残留。
     同类工具这一步通常是送去后台生图 API 重画的，我们这里没有服务端，所以换成本地算法。 */
  /** 纯函数：只吃 Uint8ClampedArray，不碰 canvas —— 自检能直接对它验数学 */
  function seamlessPixels(src, size, amount) {
    var out = new Uint8ClampedArray(src.length);
    var a = clamp(amount, 0, 1), ia = 1 - a;
    for (var y = 0; y < size; y++) {
      var ym = size - 1 - y;
      for (var x = 0; x < size; x++) {
        var xm = size - 1 - x;
        var i00 = (y * size + x) * 4, i10 = (y * size + xm) * 4, i01 = (ym * size + x) * 4, i11 = (ym * size + xm) * 4;
        for (var c = 0; c < 4; c++) {
          var m = (src[i00 + c] + src[i10 + c] + src[i01 + c] + src[i11 + c]) * 0.25;
          out[i00 + c] = src[i00 + c] * ia + m * a;
        }
      }
    }
    return out;
  }
  function makeSeamlessImage(amount) {
    var size = doc.size;
    var src0 = renderDoc(tNow);
    var tmp = document.createElement('canvas'); tmp.width = tmp.height = size;
    var tc = tmp.getContext('2d'); tc.drawImage(src0, 0, 0);
    var src = tc.getImageData(0, 0, size, size).data;
    var out = seamlessPixels(src, size, amount);
    var c2 = document.createElement('canvas'); c2.width = c2.height = size;
    c2.getContext('2d').putImageData(new ImageData(out, size, size), 0, 0);
    return c2;
  }
  /** 把接缝误差量出来（左右列 + 上下行），无缝化前后各测一次就是验收依据 */
  function seamError(size, data) {
    var sum = 0, n = 0;
    for (var y = 0; y < size; y++) {
      var l = (y * size) * 4, r = (y * size + size - 1) * 4;
      for (var c = 0; c < 3; c++) { sum += Math.abs(data[l + c] - data[r + c]); n++; }
    }
    for (var x = 0; x < size; x++) {
      var t = x * 4, b = ((size - 1) * size + x) * 4;
      for (var c2 = 0; c2 < 3; c2++) { sum += Math.abs(data[t + c2] - data[b + c2]); n++; }
    }
    return sum / n;
  }
  function applySeamless(amount) {
    var a = amount === undefined ? 0.75 : amount;
    var size = doc.size;
    var canvas = makeSeamlessImage(a);
    snapshot();
    var l = newLayer('fbm');
    l.type = '__image'; l.name = '无缝化 ' + Math.round(a * 100) + '%';
    l.color = { mode: 'gray', ramp: '火焰', solid: '#ff8932' };
    l.image = canvas.toDataURL('image/png');
    l._img = new Image(); l._img.src = l.image;
    l.params = { imgScale: 1 };
    doc.layers.push(l);
    selId = l.id;
    rebuildAll();
    toast('已生成无缝图层（平铺 3×3 看看）');
  }

  /* ───────────────────────────── 导入图片 ───────────────────────────── */
  function importImage(file) {
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () {
      var im = new Image();
      im.onload = function () {
        var c = document.createElement('canvas');
        var maxSide = 1024;
        var s = Math.min(1, maxSide / Math.max(im.width, im.height));
        c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        snapshot();
        var l = newLayer('fbm');
        l.type = '__image'; l.name = file.name.replace(/\.[^.]+$/, '').slice(0, 18);
        l.color = { mode: 'gray', ramp: '火焰', solid: '#ff8932' };
        l.image = c.toDataURL('image/png');
        l._img = new Image(); l._img.src = l.image;
        l.params = { imgScale: 1 };
        doc.layers.push(l);
        selId = l.id;
        rebuildAll();
        toast('已导入 ' + c.width + '×' + c.height);
      };
      im.onerror = function () { toast('这张图读不了'); };
      im.src = String(fr.result);
    };
    fr.readAsDataURL(file);
  }

  /* ───────────────────────────── 播放 ───────────────────────────── */
  function tick(ts) {
    if (!playing) return;
    tNow = (tNow + 0.004) % 1;
    $('ws-time').value = tNow;
    $('ws-tval').textContent = 't = ' + tNow.toFixed(2) + ' s';
    draw();
    playRaf = requestAnimationFrame(tick);
  }
  function togglePlay() {
    playing = !playing;
    $('ws-play').textContent = playing ? '❚❚ 暂停' : '▶ 播放';
    if (playing) playRaf = requestAnimationFrame(tick); else cancelAnimationFrame(playRaf);
  }

  /* ───────────────────────────── 接线 ───────────────────────────── */
  function boot() {
    // 主题
    var tt = $('theme-toggle');
    function syncTheme() {
      var dark = document.documentElement.dataset.theme === 'dark';
      tt.textContent = dark ? '白天' : '夜间';
    }
    syncTheme();
    tt.addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('vfx-theme', next); } catch (e) {}
      syncTheme();
    });

    $('ws-search').addEventListener('input', function (e) { filterText = e.target.value; buildBrowser(); });
    $('ws-add').addEventListener('click', function () { addLayer(); });
    $('ws-import').addEventListener('click', function () { $('ws-file-image').click(); });
    $('ws-file-image').addEventListener('change', function (e) { importImage(e.target.files[0]); e.target.value = ''; });
    $('ws-file-doc').addEventListener('change', function (e) { loadDocFile(e.target.files[0]); e.target.value = ''; });
    $('ws-reset-layer').addEventListener('click', function () {
      var l = curLayer(); if (!l) return;
      snapshot();
      var f = newLayer(l.type);
      l.params = f.params; l.colors = f.color; l.color = f.color; l.opacity = 1; l.blend = 'source-over'; l.alphaFromLum = false;
      rebuildAll(); toast('本层已重置');
    });
    $('ws-play').addEventListener('click', togglePlay);
    $('ws-time').addEventListener('input', function (e) { tNow = +e.target.value; $('ws-tval').textContent = 't = ' + tNow.toFixed(2) + ' s'; draw(); });
    $('ws-copy').addEventListener('click', copyToClipboard);
    $('ws-seamless').addEventListener('click', function () {
      var v = prompt('无缝化强度（0–1，越大越无缝但细节越软）：', '0.75');
      if (v === null) return;
      var n2 = parseFloat(v);
      if (!isFinite(n2)) { toast('请输入 0–1 的数字'); return; }
      applySeamless(clamp(n2, 0, 1));
    });
    $('ws-export').addEventListener('click', function () { buildExportDialog(); $('ws-export-dialog').showModal(); });
    $('ws-help').addEventListener('click', function () { $('ws-help-dialog').showModal(); });
    $('ws-pack-go').addEventListener('click', function () { exportPack({ R: packMap.R, G: packMap.G, B: packMap.B, A: packMap.A }); $('ws-pack-dialog').close(); });
    // 翻转书：控件改动 → 存进 sheetCfg → 重画预览（防抖）
    $('ws-sheet-go').addEventListener('click', exportSheet);
    $('ws-sheet-cols').addEventListener('change', function (e) { sheetCfg.cols = clamp(parseInt(e.target.value, 10) || 8, 1, 16); queueSheetPreview(); });
    $('ws-sheet-rows').addEventListener('change', function (e) { sheetCfg.rows = clamp(parseInt(e.target.value, 10) || 8, 1, 16); queueSheetPreview(); });
    $('ws-sheet-cell').addEventListener('change', function (e) { sheetCfg.cell = parseInt(e.target.value, 10) || 128; queueSheetPreview(); });
    $('ws-sheet-mask').addEventListener('change', function (e) { sheetCfg.mask = e.target.value; queueSheetPreview(); });
    $('ws-sheet-mode').addEventListener('change', function (e) { sheetCfg.mode = e.target.value; queueSheetPreview(); });
    $('ws-sheet-bg').addEventListener('change', function (e) { sheetCfg.bg = e.target.value; queueSheetPreview(); });
    [['ws-sheet-inset', 'inset'], ['ws-sheet-spin', 'spin']].forEach(function (pair) {
      var range = $(pair[0]), num = $(pair[0] + '-num');
      range.addEventListener('input', function () { sheetCfg[pair[1]] = parseFloat(range.value); num.value = range.value; queueSheetPreview(); });
      num.addEventListener('change', function () {
        var v = parseFloat(num.value);
        if (!isFinite(v)) v = pair[1] === 'spin' ? 0 : 0.55;
        v = clamp(v, pair[1] === 'spin' ? 0 : 0.15, pair[1] === 'spin' ? 360 : 1);
        sheetCfg[pair[1]] = v; range.value = v; num.value = v; queueSheetPreview();
      });
    });
    $('ws-save').addEventListener('click', saveDoc);
    $('ws-load').addEventListener('click', function () { $('ws-file-doc').click(); });
    $('ws-share').addEventListener('click', shareLink);
    $('ws-size').addEventListener('change', function (e) { snapshot(); doc.size = +e.target.value; rebuildAll(); });
    $('ws-undo').addEventListener('click', undo);
    $('ws-redo').addEventListener('click', redo);
    $('ws-quick-toggle').addEventListener('click', function () {
      var q = $('ws-quick'), on = q.querySelector('.ws-steps').hasAttribute('hidden');
      if (on) { q.querySelector('.ws-steps').removeAttribute('hidden'); $('ws-quick-toggle').textContent = '收起'; }
      else { q.querySelector('.ws-steps').setAttribute('hidden', ''); $('ws-quick-toggle').textContent = '展开'; }
      applyZoom();
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
      b.addEventListener('click', function () { b.closest('dialog').close(); });
    });
    bindSeg('ws-bg', function (v) { doc.bg = v; syncStageControls(); draw(); persist(); });
    bindSeg('ws-tile', function (v) { tileN = +v; syncStageControls(); draw(); });
    bindSeg('ws-zoom', function (v) { zoomMode = v; syncStageControls(); draw(); });
    window.addEventListener('resize', function () { applyZoom(); });
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        var l = curLayer();
        if (l && doc.layers.length > 1) { snapshot(); doc.layers = doc.layers.filter(function (x) { return x !== l; }); selId = doc.layers[doc.layers.length - 1].id; rebuildAll(); }
      }
    });
  }

  /* ───────────────────────────── 启动 ───────────────────────────── */
  boot();
  readHash().then(function (ok) {
    if (ok) toast('已从分享链接载入');
    rebuildAll();
    updateHistoryButtons();
    // 缩略图分批渲染，先让页面出来
    if (ok) { try { history.length = 0; } catch (e) {} }
  });

  // 给自检用的钩子（无头浏览器里跑，验证每个生成器都真的出图）
  window.__ws = {
    types: TYPES.map(function (T) { return T.id; }),
    render: function (typeId, size, t) {
      var T = TYPE_BY_ID[typeId];
      var P = {}; T.params.forEach(function (p) { P[p.k] = p.def; });
      var n = size || 48, out = new Float64Array(n * n), i = 0, sum = 0;
      for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) { var v = T.fn(P, x / n, y / n, t === undefined ? 0.25 : t, 12345); out[i++] = v; sum += v; }
      var mean = sum / out.length, varSum = 0;
      for (var k = 0; k < out.length; k++) { var d = out[k] - mean; varSum += d * d; }
      return { mean: mean, std: Math.sqrt(varSum / out.length), min: Math.min.apply(null, out), max: Math.max.apply(null, out) };
    },
    presets: PRESETS.map(function (p) { return p.name; }),
    categories: CATS.slice(),
    ramps: Object.keys(RAMPS),
    stats: function () { return { layers: doc.layers.length, size: doc.size, selected: selId }; },
    applyPreset: function (name) {
      var p = PRESETS.filter(function (x) { return x.name === name; })[0];
      if (!p) return false;
      var d = loadPreset(p);
      doc.layers = d.layers; selId = doc.layers[0].id; rebuildAll(); return true;
    },
    exportPNG: exportPNG, exportNormal: exportNormal, exportPack: exportPack, encodePNG: encodePNG,
    applySeamless: applySeamless, seamlessPixels: seamlessPixels,
    /** 自检用：量翻转书 —— 尺寸对不对、元素是不是只占一部分、格子四角是不是空的 */
    sheetLayout: sheetLayout,
    sheetProbe: function (over) {
      var cfg = { cols: sheetCfg.cols, rows: sheetCfg.rows, cell: 48, inset: sheetCfg.inset,
        mask: sheetCfg.mask, mode: sheetCfg.mode, bg: sheetCfg.bg, spin: sheetCfg.spin };
      if (over) Object.keys(over).forEach(function (k) { cfg[k] = over[k]; });
      var c = renderSheet(cfg, cfg.cell);
      var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      var opaque = 0, total = c.width * c.height, cornerAlpha = [];
      for (var i = 0; i < total; i++) if (d[i * 4 + 3] > 8) opaque++;
      for (var k = 0; k < Math.min(cfg.cols, 4); k++) {
        cornerAlpha.push(d[(k * cfg.cell) * 4 + 3]);                 // 每格左上角
        cornerAlpha.push(d[(k * cfg.cell + cfg.cell - 1) * 4 + 3]);  // 每格右上角
      }
      var bgAlpha = d[3];      // 左上角像素的 alpha：白底/黑底时应该是 255
      return { w: c.width, h: c.height, cells: cfg.cols * cfg.rows, fill: opaque / total,
        maxCorner: Math.max.apply(null, cornerAlpha), bgAlpha: bgAlpha };
    },
    /** 自检用：造一个 zip 出来的字节（验证 zip 结构 + 能不能被真解压工具打开） */
    zipBytes: function (entries) {
      return zipStore(entries.map(function (e) {
        return { name: e.name, data: new TextEncoder().encode(e.text) };
      }));
    },
    zipInfo: function (bytes) {
      var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { len: bytes.length, local: dv.getUint32(0, true), eocd: dv.getUint32(bytes.length - 22, true),
        count: dv.getUint16(bytes.length - 22 + 10, true), cdSize: dv.getUint32(bytes.length - 22 + 12, true),
        cdOffset: dv.getUint32(bytes.length - 22 + 16, true) };
    },
    postfxKeys: POSTFX.map(function (F) { return F.k; }),
    /** 自检用：算某个生成器的场，跑一个后处理，报前后统计 + 不同取值个数 */
    fxCheck: function (typeId, size, key, cfg) {
      var T = TYPE_BY_ID[typeId];
      var P = {}; T.params.forEach(function (p) { P[p.k] = p.def; });
      var n = size || 48, f = new Float32Array(n * n);
      for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) f[y * n + x] = T.fn(P, x / n, y / n, 0.3, 12345);
      var stat = function (a) {
        var sum = 0, i;
        for (i = 0; i < a.length; i++) sum += a[i];
        var m = sum / a.length, vs = 0;
        for (i = 0; i < a.length; i++) { var d = a[i] - m; vs += d * d; }
        var seen = {}, distinct = 0;
        for (i = 0; i < a.length; i++) { var q = Math.round(a[i] * 255); if (!seen[q]) { seen[q] = 1; distinct++; } }
        return { mean: m, std: Math.sqrt(vs / a.length), distinct: distinct };
      };
      var F = POSTFX_BY_KEY[key];
      var use = {};
      if (F) F.params.forEach(function (p) { use[p.k] = (cfg && cfg[p.k] !== undefined) ? cfg[p.k] : p.def; });
      var out = F ? F.fn(f.slice(), n, use, 0.3, boxHelpers) : f;
      return { before: stat(f), after: stat(out), n: n };
    },
    /** 自检用：量平铺接缝，验证「四方连续」开关真的起作用 */
    tileSeam: function (typeId, tile, size) {
      var T = TYPE_BY_ID[typeId];
      var P = {}; T.params.forEach(function (p) { P[p.k] = p.def; });
      var n = size || 64;
      var f = renderField({ type: typeId, params: P, seed: 12345, tile: tile, fx: {} }, n, 0.3);
      var sum = 0, cnt = 0;
      for (var y = 0; y < n; y++) { sum += Math.abs(f[y * n] - f[y * n + n - 1]); cnt++; }
      for (var x = 0; x < n; x++) { sum += Math.abs(f[x] - f[(n - 1) * n + x]); cnt++; }
      return sum / cnt;
    },
    /** 量接缝误差：返回 {before, after} —— 自检/验证用，无缝化到底有没有效看这个 */
    seamCheck: function (amount) {
      var size = doc.size;
      var src0 = renderDoc(tNow);
      var t1 = document.createElement('canvas'); t1.width = t1.height = size;
      var c1 = t1.getContext('2d'); c1.drawImage(src0, 0, 0);
      var before = seamError(size, c1.getImageData(0, 0, size, size).data);
      var sc = makeSeamlessImage(amount === undefined ? 1 : amount);
      var after = seamError(size, sc.getContext('2d').getImageData(0, 0, size, size).data);
      return { before: before, after: after, size: size };
    },
    pack: function (map) { exportPack(map); }
  };
})();

/* ─────────────────────────────────────────────────────────────
   更新检查：只做一件事 —— 让"你看到的是旧页面"这件事自己说出来。

   为什么需要：GitHub Pages 连 HTML 也会带缓存，部署完短时间内浏览器可能还在用旧页面。
   部署脚本给 JS/CSS 打的 ?v=<build> 只能保证资源是新的，**保证不了 HTML 本身**；
   而用户看到"上传了却没变"，十有八九就是这个。

   做法：本页的资源地址里带着自己的构建号（部署时打进去的），
   再和线上的 version.json（强制不走缓存地取）比一比，落后就自己冒一条提示。
   ───────────────────────────────────────────────────────────── */
(function () {
  try {
    var mine = 0;
    for (var i = 0; i < document.scripts.length; i++) {
      var m = (document.scripts[i].src || '').match(/[?&]v=(\d+)/);
      if (m) mine = Math.max(mine, Number(m[1]));
    }
    if (!mine) return;                                  // 本地直接打开文件时没有版本号，跳过
    fetch('./version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.build || Number(j.build) <= mine + 1000) return;
        var d = document.createElement('div');
        d.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;'
          + 'background:#1f6feb;color:#fff;padding:9px 14px;display:flex;gap:12px;align-items:center;'
          + 'justify-content:center;flex-wrap:wrap;font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif');
        var sp = document.createElement('span');
        sp.innerHTML = '你看的是<b>旧版页面</b>（被浏览器缓存了）—— 线上已经有 <b>v' + String(j.version || '') + '</b>。';
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = '刷新到最新版';
        b.setAttribute('style', 'border:0;border-radius:8px;padding:5px 12px;font:inherit;font-weight:600;'
          + 'background:#fff;color:#1f6feb;cursor:pointer');
        b.addEventListener('click', function () { location.href = location.pathname + '?r=' + Date.now(); });
        d.appendChild(sp); d.appendChild(b);
        document.body.appendChild(d);
      })
      .catch(function () { /* 离线或取不到就算了，不打扰 */ });
  } catch (e) { /* 静默：这只是个提示，不该影响页面 */ }
})();

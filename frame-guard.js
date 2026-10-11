/* ─────────────────────────────────────────────────────────────
   防内嵌：不允许别的网站把本站塞进 iframe 里。
   为什么做：我们自己会去内嵌别人的工具（贴图工具页），别人同样可能照着嵌我们 ——
   顶着我们的界面挂广告、冒充我们、误导访客，都不干净。
   注意，这只管「我们被别人嵌」；我们自己 iframe 别人（lab.html）完全不受影响。

   为什么用脚本而不是响应头：
   · GitHub Pages **不能自定义响应头**，所以 X-Frame-Options / CSP 都没有办法设；
   · `frame-ancestors` 写在 <meta http-equiv> 里**规范上被忽略**（它只在响应头里生效），别用那个；
   · 所以静态站只剩脚本这一条路（这也是同行站点普遍的做法）。

   留了个口子：地址后面加 `?embed=1` 就允许被内嵌（自己想嵌自己时有地方可用）。
   ───────────────────────────────────────────────────────────── */
(function () {
  try {
    if (/[?&]embed=1(&|$)/.test(location.search)) return;   // 自己人明确放行
    var framed = false;
    try { framed = window.top !== window.self; } catch (e) { framed = true; }
    if (!framed) return;                                    // 正常打开：什么都不做

    // ① 先试着跳出对方的框（对方若加了 sandbox 会抛，所以要 try）
    try { window.top.location.href = window.location.href; } catch (e) { /* 忽略 */ }

    // ② 跳不出去也必须盖住 —— 不能让本站界面顶在别人页面上
    function cover() {
      if (!document.body) return;
      if (document.getElementById('frame-guard')) return;
      var d = document.createElement('div');
      d.id = 'frame-guard';
      d.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;background:#0d1117;color:#e6edf3;'
        + 'font:15px/1.9 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;display:flex;align-items:center;'
        + 'justify-content:center;padding:32px;text-align:center;box-sizing:border-box');
      d.innerHTML = '<div style="max-width:44em">'
        + '<div style="font-size:17px;font-weight:700;margin-bottom:10px">本站不允许被别的网页内嵌</div>'
        + '<div style="color:#9aa7b4">你现在是从别的页面看到这一页的。为了不让人顶着本站的界面挂广告或误导你，'
        + '本站在被内嵌时不会正常显示。请直接访问本站，或在新窗口打开。</div>'
        + '<div style="margin-top:14px"><a href="' + location.href + '" target="_blank" rel="noopener" '
        + 'style="color:#6ea8fe">在新窗口打开本站 →</a></div>'
        + '</div>';
      document.body.appendChild(d);
    }
    if (document.body) cover();
    else document.addEventListener('DOMContentLoaded', cover);
  } catch (e) { /* 任何意外都不该拖垮页面，宁可放行 */ }
})();

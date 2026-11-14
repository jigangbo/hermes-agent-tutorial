/* 文末上一页/下一页按钮：按左侧导航顺序计算前后页。
   兼容 Material 的 navigation.instant（通过 document$ 订阅在每次换页后重新注入）。 */
(function () {
  function norm(pathname) {
    return pathname.replace(/index\.html$/, "");
  }

  function inject() {
    var container = document.querySelector(".md-content__inner");
    if (!container || container.querySelector(".dsh-pager")) return;

    var anchors = Array.prototype.slice.call(
      document.querySelectorAll(".md-sidebar--primary a.md-nav__link")
    );
    if (!anchors.length) return;

    var curPath = norm(location.pathname);
    var entries = [];
    anchors.forEach(function (a) {
      var h = a.getAttribute("href");
      if (!h) return;
      var u;
      try {
        u = new URL(h, location.origin + location.pathname);
      } catch (e) {
        return;
      }
      // 排除当前页自身的页内目录锚点（锚点且路径与当前页相同）
      if (u.hash && norm(u.pathname) === curPath) return;
      entries.push({ a: a, path: norm(u.pathname) });
    });
    if (!entries.length) return;

    var idx = -1;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].path === curPath) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return; // 导航中找不到当前页（如 404）则不注入

    var prev = idx > 0 ? entries[idx - 1] : null;
    var next = idx >= 0 && idx + 1 < entries.length ? entries[idx + 1] : null;

    var wrap = document.createElement("nav");
    wrap.className = "dsh-pager";
    wrap.appendChild(makeBtn(prev, "← 上一页", "dsh-pager__btn--prev"));
    wrap.appendChild(makeBtn(next, "下一页 →", "dsh-pager__btn--next"));
    container.appendChild(wrap);
  }

  function makeBtn(entry, dir, cls) {
    var a = document.createElement("a");
    a.className = "dsh-pager__btn " + cls + (entry ? "" : " dsh-pager__btn--off");
    if (entry) a.setAttribute("href", entry.a.getAttribute("href") || entry.path);
    a.innerHTML =
      '<span class="dsh-pager__dir">' + dir + "</span>" +
      '<span class="dsh-pager__title">' +
      (entry ? entry.a.textContent.trim() : "—") +
      "</span>";
    return a;
  }

  if (window.document$ && window.document$.subscribe) {
    window.document$.subscribe(inject);
  } else {
    if (document.readyState !== "loading") inject();
    else document.addEventListener("DOMContentLoaded", inject);
  }
})();

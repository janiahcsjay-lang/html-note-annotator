/* 标注总览页 */
(function () {
  "use strict";
  var CATS = { copy: "文案", visual: "视觉", interact: "交互", question: "疑问" };
  var SEVS = { must: "必改", suggest: "建议" };
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(ms) { var t = new Date(ms); return t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()) + " " + pad(t.getHours()) + ":" + pad(t.getMinutes()); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function shortName(url, title) {
    if (title) return title;
    try {
      var u = url.split("#")[0];
      var seg = decodeURIComponent(u.split("/").pop() || "");
      return seg || u;
    } catch (e) { return url; }
  }
  function locLine(n) {
    if (n.kind === "text") return "划词「" + n.exact + "」";
    if (n.kind === "rect") return "框选区域 · " + (n.label || "");
    return n.label || n.sel || "";
  }
  function buildMD(url, v) {
    var notes = v.notes || [];
    var open = notes.filter(function (n) { return !n.done; }).length;
    var out = [];
    out.push("# 《" + (v.title || shortName(url)) + "》标注清单");
    out.push("文件：" + url);
    out.push("导出：" + fmt(Date.now()) + " ｜ 共 " + notes.length + " 条，未完成 " + open + " 条");
    out.push("");
    Object.keys(CATS).forEach(function (ck) {
      var g = notes.filter(function (n) { return (n.cat || "visual") === ck; });
      if (!g.length) return;
      g.sort(function (a, b) { return (a.sev === "must" ? 0 : 1) - (b.sev === "must" ? 0 : 1); });
      out.push("## " + CATS[ck] + "（" + g.length + " 条）");
      g.forEach(function (n, i) {
        out.push("- [" + (n.done ? "x" : " ") + "] " + (SEVS[n.sev] || "建议") + " ｜ " + locLine(n) + " ｜ " + n.text);
      });
      out.push("");
    });
    return out.join("\n");
  }
  function download(name, data, mime) {
    var blob = new Blob([data], { type: (mime || "text/plain") + ";charset=utf-8" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function render() {
    chrome.storage.local.get(null, function (all) {
      var rows = [];
      Object.keys(all || {}).forEach(function (k) {
        if (k.indexOf("hna:") !== 0) return;
        var v = all[k] || {}; var ns = v.notes || [];
        rows.push({ key: k, url: k.slice(4), v: v, count: ns.length, open: ns.filter(function (n) { return !n.done; }).length, t: v.t || 0 });
      });
      rows.sort(function (a, b) { return b.t - a.t; });
      var total = rows.reduce(function (s, r) { return s + r.count; }, 0);
      document.getElementById("meta").textContent = rows.length ? (rows.length + " 个文件 · 共 " + total + " 条标注") : "";
      var list = document.getElementById("list");
      if (!rows.length) { list.innerHTML = '<div class="empty">还没有任何标注记录。打开一个 HTML，点插件图标，再点「标注」开始。</div>'; return; }
      list.innerHTML = rows.map(function (r, i) {
        return '<div class="card" data-i="' + i + '">' +
          '<div style="flex:1;min-width:200px"><div class="name">' + esc(shortName(r.url, r.v.title)) + '</div>' +
          '<div class="sub">' + esc(r.url) + '</div></div>' +
          '<span class="cnt">' + r.count + " 条" + (r.open ? "（未完成 <b>" + r.open + "</b>）" : "") + (r.t ? " · " + fmt(r.t) : "") + "</span>" +
          '<span class="ops">' +
          '<button class="pri" data-op="open" data-i="' + i + '">打开</button>' +
          '<button data-op="md" data-i="' + i + '">导出清单</button>' +
          '<button data-op="del" data-i="' + i + '">删除记录</button>' +
          "</span></div>";
      }).join("");
      list.onclick = function (e) {
        var b = e.target.closest("[data-op]"); if (!b) return;
        var r = rows[Number(b.getAttribute("data-i"))]; if (!r) return;
        var op = b.getAttribute("data-op");
        if (op === "open") { chrome.tabs.create({ url: r.url }); }
        else if (op === "md") { download("标注清单_" + shortName(r.url, r.v.title).replace(/\.[^.]+$/, "") + ".md", buildMD(r.url, r.v), "text/markdown"); }
        else if (op === "del") {
          if (!b.getAttribute("data-armed")) { b.setAttribute("data-armed", "1"); b.textContent = "确认删除"; return; }
          chrome.storage.local.remove([r.key], render);
        }
      };
    });
  }
  render();
})();

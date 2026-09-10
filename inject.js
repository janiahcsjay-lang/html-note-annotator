/* HTML 标注笔记 v3 —— 注入式标注层
 * 同一份代码三种活法：
 *  1) Chrome 插件 content script（点图标注入，chrome.storage 按 URL 存标注）
 *  2) 被「导出」进 HTML 文件后随文件自启（标注嵌在文件里，localStorage 存草稿）
 *  3) 手动 <script> 引入任何页面
 * 标注三种锚：元素（点选）、划词/划线（文字选区）、框选（拖矩形按比例挂在承载元素上）。
 * v3：阅读模式（选中即划线、三色、随手想法）；所有书写动作在原地小气泡完成，右侧面板只作清单管理。
 */
(function () {
  "use strict";
  if (window.__hnaBooted) { if (window.__hnaToggleUI) window.__hnaToggleUI(); return; }
  window.__hnaBooted = true;

  var d = document;
  var hasChrome = false, hasRuntime = false;
  try { hasChrome = !!(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local); } catch (e) { hasChrome = false; }
  try { hasRuntime = !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage && chrome.runtime.id); } catch (e) { hasRuntime = false; }
  var DOCKEY = "hna:" + String(location.href).split("#")[0];

  var CATS = { copy: "文案", visual: "视觉", interact: "交互", question: "疑问", note: "想法" };
  var CATCOLOR = { copy: "#B4781F", visual: "#2E7D6E", interact: "#3A6EA5", question: "#8A6FB8", note: "#5F6B7A" };
  var SEVS = { must: "必改", suggest: "建议" };
  var HLS = ["#F6D55C", "#9BC995", "#F1A9A0"]; /* 划线三色：黄 / 绿 / 粉 */

  /* ---------------- 状态 ---------------- */
  var notes = [];
  var hidden = false;
  var annotating = false, regioning = false, editing = false, reading = false;
  var activeId = null;
  var composing = null;      // {kind, label, ...} 评审类书写中
  var editingNoteId = null;  // 面板里改文字
  var hoverEl = null;
  var uiVisible = true;
  var catFilter = "all";
  var showDone = false;
  var lastCat = "visual", lastSev = "suggest";
  var contentDirty = false;
  var capturing = false;
  var importing = false;
  var saveTimer = null, pinTimer = null, toastTimer = null;
  var prevBodyEditable = null;
  var lastTextComposeAt = 0;
  var drag = null;
  var pendingSel = null;     // 阅读模式待处理的选区
  var bubMode = null;        // 'sel' | 'compose' | 'mark' | 'view'
  var bubNoteId = null;

  /* ---------------- 小工具 ---------------- */
  function el(tag, cls) { var e = d.createElement(tag); if (cls) e.className = cls; return e; }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(ms) { var t = new Date(ms); return pad(t.getMonth() + 1) + "-" + pad(t.getDate()) + " " + pad(t.getHours()) + ":" + pad(t.getMinutes()); }
  function newId() { return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function snip(t, n) { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; }
  function isMark(n) { return !!n.hl && !(n.text && n.text.trim()); }
  function catName(n) { return CATS[n.cat] || CATS.visual; }
  function catColor(n) { return n.hl || CATCOLOR[n.cat] || CATCOLOR.visual; }
  function inUI(node) { return !!(node && node.nodeType === 1 && (ui.root.contains(node) || ui.pins.contains(node))); }

  /* ---------------- 存取 ---------------- */
  function loadEmbedded() {
    var node = d.getElementById("hna-data");
    if (!node) return null;
    try { var o = JSON.parse(node.textContent || "null"); return (o && Array.isArray(o.notes)) ? o : null; } catch (e) { return null; }
  }
  function storeGet(cb) {
    if (hasChrome) { try { chrome.storage.local.get([DOCKEY], function (r) { cb((r && r[DOCKEY]) || null); }); return; } catch (e) {} }
    try { var v = localStorage.getItem(DOCKEY); cb(v ? JSON.parse(v) : null); } catch (e) { cb(null); }
  }
  function storeGetAll(cb) {
    if (hasChrome) { try { chrome.storage.local.get(null, function (r) { cb(r || {}); }); return; } catch (e) {} }
    cb({});
  }
  function storeSet(val) {
    if (hasChrome) { try { var o = {}; o[DOCKEY] = val; chrome.storage.local.set(o); return; } catch (e) {} }
    try { localStorage.setItem(DOCKEY, JSON.stringify(val)); } catch (e) {}
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { storeSet({ notes: notes, hidden: hidden, title: d.title || "", t: Date.now() }); }, 400);
  }

  /* ---------------- 元素锚 ---------------- */
  function cssPath(node) {
    var parts = [], cur = node, depth = 0;
    while (cur && cur.nodeType === 1 && cur !== d.body && cur !== d.documentElement && depth < 12) {
      var tag = cur.tagName.toLowerCase();
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift(tag + "#" + cur.id); break; }
      var i = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === cur.tagName) i++; }
      parts.unshift(tag + ":nth-of-type(" + i + ")");
      cur = cur.parentElement; depth++;
    }
    return parts.length ? parts.join(" > ") : null;
  }
  function resolveEl(n) {
    var cand = null;
    if (n.sel) { try { cand = d.querySelector(n.sel); } catch (e) { cand = null; } }
    if (cand && inUI(cand)) cand = null;
    if (cand) {
      if (!n.snippet || n.snippet.indexOf("[") === 0) return cand;
      var t = String(cand.textContent || "").replace(/\s+/g, " ").trim();
      var want0 = n.snippet.replace(/…$/, "");
      if (t.indexOf(want0) === 0) return cand;
      cand = null;
    }
    if (n.snippet && n.snippet.indexOf("[") !== 0 && n.tag) {
      var want = n.snippet.replace(/…$/, "");
      var segs = String(n.sel || "").split(" > ");
      var all = d.getElementsByTagName(n.tag), k = 0, best = null, bestScore = 0;
      for (var i = 0; i < all.length && k < 4000; i++, k++) {
        var e2 = all[i];
        if (inUI(e2)) continue;
        var tx = String(e2.textContent || "").replace(/\s+/g, " ").trim();
        if (!tx || tx.indexOf(want) !== 0) continue;
        var ps = String(cssPath(e2) || "").split(" > "), s = 0;
        while (s < segs.length && s < ps.length && segs[s] === ps[s]) s++;
        if (s > bestScore) { bestScore = s; best = e2; }
      }
      if (best && bestScore >= 1) return best;
    }
    return null;
  }
  function labelFor(node) {
    var tag = node.tagName.toLowerCase();
    var cls = (typeof node.className === "string") ? node.className.trim().split(/\s+/).filter(function (k) { return k && k.indexOf("hna-") !== 0; })[0] || "" : "";
    var txt = snip(node.textContent, 18);
    var img = (tag === "img" || (node.querySelector && node.querySelector("img,svg,canvas,video")));
    if (!txt && img) txt = "[图]";
    return tag + (cls ? "." + cls : "") + (txt ? "「" + txt + "」" : "");
  }

  /* ---------------- 划词/划线锚 ---------------- */
  function grabSelection() {
    var s = window.getSelection && window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    var r = s.getRangeAt(0);
    var exact = r.toString();
    if (!exact || !exact.trim() || exact.length > 400) return null;
    var c = r.commonAncestorContainer;
    if (c.nodeType !== 1) c = c.parentElement;
    if (!c || inUI(c)) return null;
    if (c === d.body || c === d.documentElement) return "toobig";
    var pre = d.createRange(); pre.selectNodeContents(c); pre.setEnd(r.startContainer, r.startOffset);
    var suf = d.createRange(); suf.selectNodeContents(c); suf.setStart(r.endContainer, r.endOffset);
    var rect = null;
    try { rect = r.getBoundingClientRect(); } catch (e2) { rect = null; }
    return {
      kind: "text", sel: cssPath(c), tag: c.tagName.toLowerCase(),
      exact: exact, prefix: pre.toString().slice(-30), suffix: suf.toString().slice(0, 30),
      snippet: snip(c.textContent, 40) || "[图]",
      label: "划词「" + snip(exact, 20) + "」",
      rect: rect
    };
  }
  function sharedEnd(a, b) { var i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }
  function sharedStart(a, b) { var i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
  function resolveTextRange(n) {
    var c = null;
    if (n.sel) { try { c = d.querySelector(n.sel); } catch (e) { c = null; } }
    if (!c || inUI(c)) c = resolveEl({ sel: n.sel, tag: n.tag, snippet: n.snippet });
    if (!c) return null;
    var hay = c.textContent || "";
    var idxs = [], from = 0, ix;
    while ((ix = hay.indexOf(n.exact, from)) !== -1 && idxs.length < 20) { idxs.push(ix); from = ix + 1; }
    if (!idxs.length) return null;
    var best = idxs[0], bestScore = -1;
    for (var i = 0; i < idxs.length; i++) {
      var p = idxs[i];
      var sc = sharedEnd(hay.slice(0, p), n.prefix || "") + sharedStart(hay.slice(p + n.exact.length), n.suffix || "");
      if (sc > bestScore) { bestScore = sc; best = p; }
    }
    var start = best, end = best + n.exact.length;
    var walker = d.createTreeWalker(c, NodeFilter.SHOW_TEXT, null);
    var acc = 0, node, range = d.createRange(), s1 = false, s2 = false;
    while ((node = walker.nextNode())) {
      var len = node.nodeValue.length;
      if (!s1 && acc + len > start) { range.setStart(node, start - acc); s1 = true; }
      if (s1 && acc + len >= end) { range.setEnd(node, Math.min(len, end - acc)); s2 = true; break; }
      acc += len;
    }
    return (s1 && s2) ? range : null;
  }

  /* ---------------- 框选锚 ---------------- */
  function hostForPoint(vx, vy) {
    var elx = d.elementFromPoint(vx, vy);
    if (!elx || inUI(elx)) return d.body;
    var t = targetFor(elx);
    return t || d.body;
  }
  function resolveRectBox(n) {
    var host = resolveEl(n);
    if (!host) return null;
    var r = host.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return {
      left: r.left + window.pageXOffset + n.rx * r.width,
      top: r.top + window.pageYOffset + n.ry * r.height,
      width: Math.max(8, n.rw * r.width),
      height: Math.max(8, n.rh * r.height)
    };
  }

  /* ---------------- 统一解析 ---------------- */
  function noteBoxes(n) {
    var boxes = [], i, r;
    if (n.kind === "text") {
      var range = resolveTextRange(n);
      if (!range) return null;
      var rects = range.getClientRects();
      if (!rects.length) return null;
      for (i = 0; i < rects.length && i < 40; i++) {
        r = rects[i];
        if (!r.width && !r.height) continue;
        boxes.push({ left: r.left + window.pageXOffset, top: r.top + window.pageYOffset, width: r.width, height: r.height });
      }
      if (!boxes.length) return null;
      var lastB = boxes[boxes.length - 1];
      return { boxes: boxes, pin: { x: lastB.left + lastB.width + 4, y: lastB.top + 2 } };
    }
    if (n.kind === "rect") {
      var b = resolveRectBox(n);
      if (!b) return null;
      return { boxes: [b], rectStyle: true, pin: { x: b.left + b.width - 2, y: b.top + 2 } };
    }
    var a = resolveEl(n);
    if (!a) return null;
    r = a.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { boxes: [], pin: { x: r.right + window.pageXOffset - 2, y: r.top + window.pageYOffset + 2 } };
  }

  /* ---------------- UI 骨架 ---------------- */
  var CSS = "" +
    "#hna-ui,#hna-pins{all:initial}" +
    "#hna-ui *,#hna-pins *{box-sizing:border-box;font-family:-apple-system,'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif}" +
    "#hna-ui [hidden],#hna-pins [hidden]{display:none!important}" +
    "#hna-ui{position:fixed;z-index:2147483000}" +
    ".hna-bar{position:fixed;top:14px;right:14px;z-index:2147483200;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:calc(100vw - 28px)}" +
    ".hna-bar button{font-size:12px;line-height:1.4;padding:6px 12px;border-radius:999px;border:1px solid #D8D5CC;background:#FFFEFA;color:#2C2A26;cursor:pointer;white-space:nowrap;box-shadow:0 2px 8px rgba(30,30,25,.10)}" +
    ".hna-bar button.hna-on{background:#1F401B;color:#F3F4EE;border-color:#1F401B}" +
    ".hna-bar button:focus-visible{outline:2px solid #B4781F;outline-offset:2px}" +
    ".hna-pill{position:fixed;top:14px;right:14px;z-index:2147483200;width:36px;height:36px;border-radius:50%;border:1px solid #1F401B;background:#1F401B;color:#F3F4EE;font-size:13px;cursor:pointer;box-shadow:0 2px 10px rgba(30,30,25,.2)}" +
    ".hna-hint{position:fixed;top:52px;right:14px;z-index:2147483200;font-size:11px;color:#7A776F;background:#FFFEFA;border:1px solid #D8D5CC;border-radius:8px;padding:6px 10px;max-width:340px;line-height:1.55;box-shadow:0 2px 8px rgba(30,30,25,.08)}" +
    ".hna-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483300;font-size:12px;color:#F3F4EE;background:#1F401B;border-radius:10px;padding:8px 14px;max-width:calc(100vw - 28px);line-height:1.5;box-shadow:0 6px 18px rgba(20,35,28,.2)}" +
    "#hna-pins{position:absolute;left:0;top:0;width:100%;height:0;z-index:2147482900;pointer-events:none}" +
    ".hna-pin{position:absolute;width:20px;height:20px;border-radius:50% 50% 50% 3px;background:#B4781F;color:#FFF;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;box-shadow:0 2px 6px rgba(20,35,28,.25);border:1.5px solid #FFF;transform:translate(-50%,-100%)}" +
    ".hna-pin.hna-done{background:#FFFEFA!important;color:#7A776F;border-color:#7A776F;box-shadow:0 2px 6px rgba(20,35,28,.18)}" +
    ".hna-pin.hna-act{box-shadow:0 0 0 2px #1F401B,0 2px 6px rgba(20,35,28,.25)}" +
    ".hna-pin.hna-must{box-shadow:0 0 0 2px #C43D2B,0 2px 6px rgba(20,35,28,.25)}" +
    ".hna-mark{position:absolute;pointer-events:none;border-radius:2px}" +
    ".hna-rectmark{position:absolute;pointer-events:none;border:1.5px dashed #B4781F;border-radius:3px;background:rgba(180,120,31,.07)}" +
    ".hna-box{position:absolute;pointer-events:none;display:none;border-radius:3px}" +
    ".hna-boxh{outline:1.5px dashed #B4781F;outline-offset:2px}" +
    ".hna-boxt{outline:2px solid #B4781F;outline-offset:2px}" +
    ".hna-dragbox{position:absolute;pointer-events:none;border:1.5px dashed #B4781F;background:rgba(180,120,31,.10);border-radius:3px;display:none}" +
    /* 原地小气泡 */
    ".hna-bub{position:fixed;z-index:2147483240;background:#FFFEFA;border:1px solid #D8D5CC;border-radius:12px;box-shadow:0 8px 26px rgba(20,35,28,.18);padding:8px 10px;max-width:300px;min-width:120px;font-size:12px;color:#2C2A26}" +
    ".hna-bub .hna-row{display:flex;align-items:center;gap:8px}" +
    ".hna-dot{width:19px;height:19px;border-radius:50%;border:2px solid #FFF;box-shadow:0 0 0 1px #C9C6BC;cursor:pointer;flex:none;padding:0}" +
    ".hna-dot.hna-cur{box-shadow:0 0 0 2px #1F401B}" +
    ".hna-bub .hna-lnkb{border:0;background:transparent;color:#1F401B;font-size:12px;cursor:pointer;padding:2px 4px;white-space:nowrap}" +
    ".hna-bub .hna-lnkb[data-armed]{color:#A0341C}" +
    ".hna-bub .hna-x{border:0;background:transparent;color:#9B978C;font-size:13px;cursor:pointer;padding:2px 4px;margin-left:auto}" +
    ".hna-bub textarea{display:block;width:100%;min-height:52px;font-size:12px;line-height:1.5;border:1px solid #D8D5CC;border-radius:8px;padding:6px 8px;resize:vertical;background:#FFFEFA;color:#2C2A26;margin-top:6px}" +
    ".hna-bub .hna-tgt{font-size:10.5px;color:#7A776F;line-height:1.4;margin-bottom:2px;word-break:break-all;max-width:270px}" +
    ".hna-bub .hna-text{margin:4px 0 2px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-width:270px}" +
    ".hna-bub .hna-meta{font-size:10.5px;color:#7A776F}" +
    ".hna-bub .hna-btns{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}" +
    ".hna-bub .hna-btns button{font-size:11px;padding:4px 10px;border-radius:999px;border:1px solid #D8D5CC;background:#FFFEFA;color:#2C2A26;cursor:pointer}" +
    ".hna-bub .hna-btns button.hna-pri{background:#1F401B;color:#F3F4EE;border-color:#1F401B}" +
    ".hna-chips{display:flex;gap:4px;flex-wrap:wrap;margin:4px 0 2px}" +
    ".hna-chip{font-size:10.5px;padding:2px 9px;border-radius:999px;border:1px solid #D8D5CC;cursor:pointer;color:#5C5952;background:#FFFEFA;line-height:1.5}" +
    ".hna-chip.on{color:#FFF;border-color:transparent;background:#1F401B}" +
    ".hna-chip.on[data-cat=copy]{background:#B4781F}.hna-chip.on[data-cat=visual]{background:#2E7D6E}.hna-chip.on[data-cat=interact]{background:#3A6EA5}.hna-chip.on[data-cat=question]{background:#8A6FB8}.hna-chip.on[data-cat=note]{background:#5F6B7A}" +
    ".hna-chip.on[data-sev=must]{background:#C43D2B}.hna-chip.on[data-sev=suggest]{background:#7A776F}" +
    /* 面板（仅清单管理） */
    ".hna-panel{position:fixed;top:56px;right:14px;bottom:16px;width:330px;max-width:calc(100vw - 28px);z-index:2147483100;background:#FFFEFA;border:1px solid #D8D5CC;border-radius:14px;box-shadow:0 10px 30px rgba(20,35,28,.14);display:flex;flex-direction:column;overflow:hidden;font-size:12px;color:#2C2A26}" +
    ".hna-ph{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #E3E2DA;font-weight:600;color:#1F401B}" +
    ".hna-ph label{font-weight:400;font-size:11px;color:#7A776F;margin-left:auto;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}" +
    ".hna-ph .hna-exp{font-weight:400;font-size:11px;border:1px solid #D8D5CC;border-radius:999px;background:#FFFEFA;padding:2px 10px;cursor:pointer;color:#2C2A26}" +
    ".hna-pb{overflow:auto;padding:10px 12px;flex:1}" +
    ".hna-chint{font-size:10.5px;color:#7A776F;line-height:1.5;margin-bottom:8px}" +
    ".hna-form{border:1px solid #C9B27A;background:#FBF7EE;border-radius:10px;padding:8px 10px;margin-bottom:10px}" +
    ".hna-tgt{font-size:10.5px;color:#7A776F;line-height:1.4;margin-bottom:4px;word-break:break-all}" +
    ".hna-panel textarea{display:block;width:100%;min-height:52px;font-size:12px;line-height:1.5;border:1px solid #D8D5CC;border-radius:8px;padding:6px 8px;resize:vertical;background:#FFFEFA;color:#2C2A26}" +
    ".hna-btns{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}" +
    ".hna-btns.hna-left{justify-content:flex-start;gap:2px;margin-top:2px}" +
    ".hna-panel button{font-size:11px;padding:4px 10px;border-radius:999px;border:1px solid #D8D5CC;background:#FFFEFA;color:#2C2A26;cursor:pointer}" +
    ".hna-panel button.hna-pri{background:#1F401B;color:#F3F4EE;border-color:#1F401B}" +
    ".hna-panel button.hna-lnk{border:0;background:transparent;color:#1F401B;padding:2px 6px}" +
    ".hna-panel button.hna-lnk[data-armed]{color:#A0341C}" +
    ".hna-item{border-top:1px solid #E3E2DA;padding:10px 0}" +
    ".hna-item.hna-done{opacity:.6}" +
    ".hna-item.hna-act{background:#FBF7EE;margin:0 -12px;padding:10px 12px;border-top-color:transparent}" +
    ".hna-num{display:inline-flex;width:18px;height:18px;border-radius:50%;background:#B4781F;color:#fff;font-size:10px;font-weight:700;align-items:center;justify-content:center;margin-right:6px;vertical-align:middle}" +
    ".hna-cat{display:inline-block;font-size:9.5px;border-radius:4px;padding:0 5px;line-height:15px;color:#FFF;vertical-align:middle;margin-right:4px}" +
    ".hna-sev{display:inline-block;font-size:9.5px;border-radius:4px;padding:0 5px;line-height:15px;border:1px solid #C43D2B;color:#C43D2B;vertical-align:middle}" +
    ".hna-meta{font-size:10.5px;color:#7A776F;margin-top:2px}" +
    ".hna-text{margin:3px 0 6px;line-height:1.55;white-space:pre-wrap;word-break:break-word;font-size:12px;color:#2C2A26}" +
    ".hna-empty{color:#7A776F;font-size:11.5px;line-height:1.6;padding:6px 0}" +
    ".hna-mask{position:fixed;inset:0;background:rgba(20,35,28,.45);z-index:2147483250;display:flex;align-items:center;justify-content:center;padding:20px}" +
    ".hna-modal{background:#FFFEFA;border:1px solid #D8D5CC;border-radius:14px;max-width:640px;width:100%;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 14px 40px rgba(20,35,28,.2)}" +
    ".hna-mh{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #E3E2DA;font-weight:600;color:#1F401B;font-size:13px}" +
    ".hna-mh button{border:0;background:transparent;font-size:14px;color:#7A776F;cursor:pointer;padding:2px 6px}" +
    ".hna-modal textarea{flex:1;min-height:240px;margin:12px 14px 0;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:11.5px;line-height:1.6;border:1px solid #D8D5CC;border-radius:8px;padding:8px 10px;resize:none;background:#F8F9F3;color:#2C2A26;white-space:pre;overflow:auto}" +
    ".hna-mb{display:flex;gap:8px;align-items:center;padding:10px 14px;flex-wrap:wrap}" +
    ".hna-mb .hna-tip{font-size:10.5px;color:#7A776F;margin-right:auto;line-height:1.4}" +
    ".hna-mb button{font-size:12px;padding:5px 12px;border-radius:999px;border:1px solid #D8D5CC;background:#FFFEFA;cursor:pointer;color:#2C2A26}" +
    ".hna-mb button.hna-pri{background:#1F401B;color:#F3F4EE;border-color:#1F401B}" +
    ".hna-mb button:disabled{opacity:.55;cursor:default}" +
    "@media print{#hna-ui,#hna-pins{display:none!important}}";

  var ui = {};
  function buildUI() {
    if (!d.getElementById("hna-style")) {
      var st = el("style"); st.id = "hna-style"; st.textContent = CSS;
      (d.head || d.documentElement).appendChild(st);
    }
    ui.root = el("div"); ui.root.id = "hna-ui"; ui.root.setAttribute("contenteditable", "false");
    ui.pins = el("div"); ui.pins.id = "hna-pins"; ui.pins.setAttribute("contenteditable", "false");
    ui.markWrap = el("div"); ui.pinWrap = el("div");
    ui.hoverBox = el("div", "hna-box hna-boxh");
    ui.targetBox = el("div", "hna-box hna-boxt");
    ui.dragBox = el("div", "hna-dragbox");
    ui.pins.appendChild(ui.markWrap); ui.pins.appendChild(ui.hoverBox); ui.pins.appendChild(ui.targetBox); ui.pins.appendChild(ui.dragBox); ui.pins.appendChild(ui.pinWrap);
    ui.bar = el("div", "hna-bar");
    ui.bar.innerHTML =
      '<button type="button" data-hna="note">标注</button>' +
      '<button type="button" data-hna="region">框选</button>' +
      '<button type="button" data-hna="read">阅读</button>' +
      '<button type="button" data-hna="hide">隐藏标注</button>' +
      '<button type="button" data-hna="edit">编辑内容</button>' +
      '<button type="button" data-hna="list">清单</button>' +
      '<button type="button" data-hna="export">导出 HTML</button>' +
      (hasRuntime ? '<button type="button" data-hna="overview" title="所有标注过的文件">总览</button>' : "") +
      '<button type="button" data-hna="fold" title="收起（再点插件图标恢复）">收起</button>';
    ui.pill = el("button", "hna-pill"); ui.pill.type = "button"; ui.pill.textContent = "读"; ui.pill.title = "阅读模式：点这里展开工具条"; ui.pill.hidden = true;
    ui.hint = el("div", "hna-hint"); ui.hint.hidden = true;
    ui.toast = el("div", "hna-toast"); ui.toast.hidden = true;
    ui.panel = el("aside", "hna-panel"); ui.panel.hidden = true;
    ui.bub = el("div", "hna-bub"); ui.bub.hidden = true;
    ui.root.appendChild(ui.bar); ui.root.appendChild(ui.pill); ui.root.appendChild(ui.hint); ui.root.appendChild(ui.toast); ui.root.appendChild(ui.panel); ui.root.appendChild(ui.bub);
    d.body.appendChild(ui.root); d.body.appendChild(ui.pins);
  }
  function toast(msg, ms) {
    ui.toast.textContent = msg; ui.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { ui.toast.hidden = true; }, ms || 3200);
  }
  function hint(msg) { if (!msg) { ui.hint.hidden = true; return; } ui.hint.textContent = msg; ui.hint.hidden = false; }
  function btn(name) { return ui.bar.querySelector('[data-hna="' + name + '"]'); }
  function syncBar() {
    btn("note").textContent = annotating ? "完成标注" : "标注";
    btn("note").classList.toggle("hna-on", annotating);
    btn("region").textContent = regioning ? "完成框选" : "框选";
    btn("region").classList.toggle("hna-on", regioning);
    btn("read").textContent = reading ? "完成阅读" : "阅读";
    btn("read").classList.toggle("hna-on", reading);
    btn("hide").textContent = hidden ? "显示标注" : "隐藏标注";
    btn("hide").classList.toggle("hna-on", hidden);
    btn("edit").textContent = editing ? "完成编辑" : "编辑内容";
    btn("edit").classList.toggle("hna-on", editing);
  }

  /* ---------------- 高亮框 ---------------- */
  function positionBox(box, node) {
    if (!node || !d.contains(node)) { box.style.display = "none"; return; }
    var r = node.getBoundingClientRect();
    if (!r.width && !r.height) { box.style.display = "none"; return; }
    box.style.display = "block";
    box.style.left = (r.left + window.pageXOffset) + "px";
    box.style.top = (r.top + window.pageYOffset) + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }
  function positionBoxAt(box, b) {
    if (!b) { box.style.display = "none"; return; }
    box.style.display = "block";
    box.style.left = b.left + "px"; box.style.top = b.top + "px";
    box.style.width = b.width + "px"; box.style.height = b.height + "px";
  }
  function unionBox(boxes) {
    var l = 1e9, t = 1e9, r = -1e9, b = -1e9;
    boxes.forEach(function (x) { l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.left + x.width); b = Math.max(b, x.top + x.height); });
    return { left: l, top: t, width: r - l, height: b - t };
  }
  function refreshTarget() {
    if (composing) {
      if (composing.kind === "el" && composing.el && d.contains(composing.el)) { positionBox(ui.targetBox, composing.el); return; }
      if (composing.kind === "text") { var nb = noteBoxes(composing); positionBoxAt(ui.targetBox, nb && nb.boxes.length ? unionBox(nb.boxes) : null); return; }
      if (composing.kind === "rect") { positionBoxAt(ui.targetBox, resolveRectBox(composing)); return; }
    }
    if (activeId != null) {
      var k = byId(activeId);
      if (k) {
        if (k.kind === "el") { positionBox(ui.targetBox, resolveEl(k)); return; }
        var nb2 = noteBoxes(k);
        positionBoxAt(ui.targetBox, nb2 && nb2.boxes.length ? unionBox(nb2.boxes) : null);
        if (!nb2) ui.targetBox.style.display = "none";
        return;
      }
    }
    ui.targetBox.style.display = "none";
  }

  /* ---------------- 图钉与高亮 ---------------- */
  var lastMarkHits = []; /* [{id, boxes}] 供阅读模式点击命中 */
  function visibleMatch(n) {
    if (n.done && !showDone) return false;
    if (catFilter === "mark") return isMark(n);
    if (catFilter !== "all" && (isMark(n) || (n.cat || "visual") !== catFilter)) return false;
    return true;
  }
  function schedulePins() { clearTimeout(pinTimer); pinTimer = setTimeout(renderPins, 120); }
  function renderPins() {
    ui.pinWrap.innerHTML = ""; ui.markWrap.innerHTML = "";
    lastMarkHits = [];
    if (hidden || !uiVisible || capturing) { positionBox(ui.hoverBox, null); positionBoxAt(ui.targetBox, null); return; }
    refreshTarget();
    var per = {};
    notes.forEach(function (n, idx) {
      if (!visibleMatch(n)) return;
      var nb = noteBoxes(n); if (!nb) return;
      var col = catColor(n);
      if (nb.boxes.length) lastMarkHits.push({ id: n.id, boxes: nb.boxes });
      nb.boxes.forEach(function (b2) {
        var m = el("div", nb.rectStyle ? "hna-rectmark" : "hna-mark");
        m.style.left = b2.left + "px"; m.style.top = b2.top + "px";
        m.style.width = b2.width + "px"; m.style.height = b2.height + "px";
        if (nb.rectStyle) { m.style.borderColor = col; m.style.background = hexA(col, n.id === activeId ? 0.14 : 0.07); }
        else { m.style.background = hexA(col, n.id === activeId ? (n.hl ? 0.55 : 0.4) : (n.hl ? 0.34 : 0.24)); }
        ui.markWrap.appendChild(m);
      });
      if (isMark(n)) return; /* 纯划线不出钉子，划线本身就是标记 */
      var key = (n.sel || "") + "|" + (n.kind || "el"), c = per[key] || 0; per[key] = c + 1;
      var p = el("div", "hna-pin" + (n.done ? " hna-done" : "") + (n.id === activeId ? " hna-act" : "") + (n.sev === "must" && !n.done ? " hna-must" : ""));
      p.textContent = idx + 1;
      p.title = catName(n) + (n.sev === "must" ? "·必改" : "") + "：" + n.text;
      p.setAttribute("data-id", n.id);
      p.style.background = n.done ? "" : (n.hl ? CATCOLOR[n.cat || "note"] || "#5F6B7A" : col);
      p.style.left = (nb.pin.x - c * 22) + "px";
      p.style.top = nb.pin.y + "px";
      ui.pinWrap.appendChild(p);
    });
  }
  function hexA(hex, a) {
    var m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
    if (!m) return hex;
    return "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + a + ")";
  }
  function findMarkAt(px, py) {
    for (var i = lastMarkHits.length - 1; i >= 0; i--) {
      var h = lastMarkHits[i];
      for (var j = 0; j < h.boxes.length; j++) {
        var b = h.boxes[j];
        if (px >= b.left - 2 && px <= b.left + b.width + 2 && py >= b.top - 2 && py <= b.top + b.height + 2) return byId(h.id);
      }
    }
    return null;
  }

  /* ---------------- 原地气泡 ---------------- */
  var bubShownAt = 0;
  function showBubbleAt(vx, vy) {
    bubShownAt = Date.now();
    ui.bub.hidden = false;
    ui.bub.style.left = "0px"; ui.bub.style.top = "0px";
    var w = ui.bub.offsetWidth, h = ui.bub.offsetHeight;
    var x = Math.min(Math.max(8, vx - w / 2), window.innerWidth - w - 8);
    var y = vy + 10;
    if (y + h > window.innerHeight - 8) y = Math.max(8, vy - h - 12);
    ui.bub.style.left = x + "px"; ui.bub.style.top = y + "px";
  }
  function hideBubble() {
    ui.bub.hidden = true; bubMode = null; bubNoteId = null; pendingSel = null;
    if (composing) { composing = null; refreshTarget(); }
  }
  function dotsHTML(cur) {
    return HLS.map(function (c) {
      return '<button type="button" class="hna-dot' + (cur === c ? " hna-cur" : "") + '" data-dot="' + c + '" style="background:' + c + '"></button>';
    }).join("");
  }
  function chipsHTML(cat, sev, withSev) {
    var h = '<div class="hna-chips">';
    Object.keys(CATS).forEach(function (k) { h += '<span class="hna-chip' + (cat === k ? " on" : "") + '" data-cat="' + k + '">' + CATS[k] + "</span>"; });
    if (withSev !== false) {
      h += '<span style="width:6px"></span>';
      Object.keys(SEVS).forEach(function (k) { h += '<span class="hna-chip' + (sev === k ? " on" : "") + '" data-sev="' + k + '">' + SEVS[k] + "</span>"; });
    }
    return h + "</div>";
  }
  function bubSelection(vx, vy) {
    bubMode = "sel";
    ui.bub.innerHTML = '<div class="hna-row">' + dotsHTML(null) +
      '<button type="button" class="hna-lnkb" data-bub="idea">写想法</button>' +
      '<button type="button" class="hna-x" data-bub="close">✕</button></div>';
    showBubbleAt(vx, vy);
  }
  function bubIdeaForm(vx, vy) {
    bubMode = "idea";
    ui.bub.innerHTML = '<div class="hna-tgt">' + esc(pendingSel ? pendingSel.label : "") + "</div>" +
      '<div class="hna-row">' + dotsHTML(pendingSel && pendingSel.hlPick || HLS[0]) + "</div>" +
      '<textarea placeholder="写点想法…（Enter 提交，Shift+Enter 换行）" data-role="text"></textarea>' +
      '<div class="hna-btns"><button type="button" data-bub="close">取消</button><button type="button" class="hna-pri" data-bub="save-idea">保存</button></div>';
    showBubbleAt(vx, vy);
    var ta = ui.bub.querySelector("textarea"); if (ta) ta.focus();
  }
  function bubCompose(vx, vy) {
    bubMode = "compose";
    ui.bub.innerHTML = '<div class="hna-tgt">位置：' + esc(composing.label) + "</div>" +
      chipsHTML(lastCat, lastSev) +
      '<textarea placeholder="写点什么…（Enter 提交，Shift+Enter 换行）" data-role="text"></textarea>' +
      '<div class="hna-btns"><button type="button" data-bub="close">取消</button><button type="button" class="hna-pri" data-bub="post">保存</button></div>';
    showBubbleAt(vx, vy);
    var ta = ui.bub.querySelector("textarea"); if (ta) ta.focus();
  }
  function bubNote(n, vx, vy, editNow) {
    bubMode = "view"; bubNoteId = n.id;
    setActive(n.id);
    var h = "";
    if (isMark(n)) {
      h = '<div class="hna-row">' + dotsHTML(n.hl) +
        '<button type="button" class="hna-lnkb" data-bub="add-idea">写想法</button>' +
        '<button type="button" class="hna-lnkb" data-bub="del">删除划线</button>' +
        '<button type="button" class="hna-x" data-bub="close">✕</button></div>';
    } else if (editNow) {
      h = '<div class="hna-tgt">' + esc(n.label) + "</div>" +
        chipsHTML(n.cat || "visual", n.sev || "suggest") +
        '<textarea data-role="text">' + esc(n.text) + "</textarea>" +
        '<div class="hna-btns"><button type="button" data-bub="close">取消</button><button type="button" class="hna-pri" data-bub="save-edit">保存</button></div>';
    } else {
      h = '<div class="hna-tgt"><span class="hna-cat" style="background:' + catColor(n) + '">' + catName(n) + "</span>" +
        (n.sev === "must" ? '<span class="hna-sev">必改</span> ' : "") + esc(n.label) + "</div>" +
        '<div class="hna-text">' + esc(n.text) + "</div>";
      if (n.replies && n.replies.length) {
        n.replies.forEach(function (r2) { h += '<div class="hna-text" style="border-left:2px solid #E3E2DA;padding-left:8px;color:#5C5952">↳ ' + esc((r2.author ? r2.author + "：" : "") + r2.text) + "</div>"; });
      }
      h += '<div class="hna-meta">' + fmt(n.time) + (n.done ? " · 已完成" : "") + "</div>" +
        '<div class="hna-btns" style="justify-content:flex-start;gap:2px">' +
        '<button type="button" class="hna-lnkb" data-bub="edit">修改</button>' +
        '<button type="button" class="hna-lnkb" data-bub="done">' + (n.done ? "重开" : "完成") + "</button>" +
        '<button type="button" class="hna-lnkb" data-bub="del">删除</button>' +
        '<button type="button" class="hna-x" data-bub="close">✕</button></div>';
    }
    ui.bub.innerHTML = h;
    showBubbleAt(vx, vy);
  }
  ;

  /* ---------------- 面板（清单管理） ---------------- */
  var panelOpen = false;
  function setActive(id) { activeId = id; refreshTarget(); }
  function byId(id) { for (var i = 0; i < notes.length; i++) if (notes[i].id === id) return notes[i]; return null; }
  function noteIndex(n) { return notes.indexOf(n); }
  function scrollToBox(b) {
    if (!b) return;
    var top = b.top - 120;
    if (b.top - window.pageYOffset < 80 || b.top + b.height - window.pageYOffset > window.innerHeight - 40) window.scrollTo({ top: top < 0 ? 0 : top, behavior: "smooth" });
  }
  function renderPanel() {
    if (ui.panel.hidden) return;
    var open = notes.filter(function (n) { return !n.done; }).length;
    var must = notes.filter(function (n) { return !n.done && n.sev === "must" && !isMark(n); }).length;
    var marks = notes.filter(isMark).length;
    var h = '<div class="hna-ph"><span>标注 ' + notes.length + (notes.length ? "（未完成 " + open + (must ? "，必改 " + must : "") + "）" : "") + "</span>" +
      '<button type="button" class="hna-exp" data-act="export-open">导出</button>' +
      '<label><input type="checkbox" data-act="toggle-done"' + (showDone ? " checked" : "") + ">已完成</label>" +
      '<button type="button" class="hna-lnk" data-act="close" title="收起面板">✕</button></div>';
    var b = '<div class="hna-pb">';
    if (notes.length) {
      b += '<div class="hna-chips"><span class="hna-chip' + (catFilter === "all" ? " on" : "") + '" data-filter="all">全部</span>';
      if (marks) b += '<span class="hna-chip' + (catFilter === "mark" ? " on" : "") + '" data-filter="mark">划线 ' + marks + "</span>";
      Object.keys(CATS).forEach(function (k) {
        var cnt = notes.filter(function (n) { return !isMark(n) && (n.cat || "visual") === k; }).length;
        if (cnt) b += '<span class="hna-chip' + (catFilter === k ? " on" : "") + '" data-filter="' + k + '" data-cat="' + k + '">' + CATS[k] + " " + cnt + "</span>";
      });
      b += "</div>";
    }
    if (!notes.length) {
      b += '<div class="hna-empty">还没有标注。「标注」点选/划词，「框选」拖区域，「阅读」选中即划线。</div>';
      if (hasChrome && !importing) b += '<div class="hna-btns hna-left"><button type="button" class="hna-lnk" data-act="import">从其他文件导入标注…</button></div>';
    }
    if (importing) {
      b += '<div class="hna-form"><div class="hna-tgt">选择来源（比如这个文件改名前的记录），标注会复制过来，原记录保留：</div><div data-role="imports" class="hna-empty">读取中…</div>' +
        '<div class="hna-btns"><button type="button" data-act="cancel-import">取消</button></div></div>';
    }
    var list = notes.filter(visibleMatch);
    if (notes.length && !list.length) b += '<div class="hna-empty">该筛选下没有标注。</div>';
    list.forEach(function (n) {
      var idx = noteIndex(n);
      var nb = noteBoxes(n);
      b += '<div class="hna-item' + (n.done ? " hna-done" : "") + (n.id === activeId ? " hna-act" : "") + '" data-id="' + n.id + '">';
      if (isMark(n)) {
        b += '<div class="hna-tgt"><span class="hna-num" style="background:' + n.hl + ';color:#5C5330">' + (idx + 1) + "</span>划线摘录" + (nb ? "" : " <i>（不在当前画面）</i>") + "</div>" +
          '<div class="hna-text">' + esc(snip(n.exact, 90)) + "</div>" +
          '<div class="hna-meta">' + fmt(n.time) + "</div>";
      } else {
        b += '<div class="hna-tgt"><span class="hna-num" style="background:' + catColor(n) + '">' + (idx + 1) + "</span>" +
          '<span class="hna-cat" style="background:' + catColor(n) + '">' + catName(n) + "</span>" +
          (n.sev === "must" ? '<span class="hna-sev">必改</span> ' : "") +
          esc(n.label) + (nb ? "" : " <i>（不在当前画面，切到对应交互状态后会回来）</i>") + "</div>";
        if (editingNoteId === n.id) {
          b += '<div class="hna-form" style="margin-top:6px">' + chipsHTML(n.cat || "visual", n.sev || "suggest") +
            '<textarea data-role="edittext">' + esc(n.text) + "</textarea>" +
            '<div class="hna-btns"><button type="button" data-act="cancel-edit">取消</button><button type="button" class="hna-pri" data-act="save-edit" data-id="' + n.id + '">保存</button></div></div>';
        } else {
          b += '<div class="hna-text">' + esc(n.text) + "</div>";
          if (n.replies && n.replies.length) {
            n.replies.forEach(function (r2) { b += '<div class="hna-text" style="border-left:2px solid #E3E2DA;padding-left:8px;color:#5C5952">↳ ' + esc((r2.author ? r2.author + "：" : "") + r2.text) + "</div>"; });
          }
          b += '<div class="hna-meta">' + fmt(n.time) + (n.done ? " · 已完成" : "") + "</div>";
        }
      }
      if (editingNoteId !== n.id) {
        b += '<div class="hna-btns hna-left">' +
          '<button type="button" class="hna-lnk" data-act="locate" data-id="' + n.id + '">定位</button>' +
          (isMark(n) ? "" : '<button type="button" class="hna-lnk" data-act="edit" data-id="' + n.id + '">修改</button>' +
            '<button type="button" class="hna-lnk" data-act="done" data-id="' + n.id + '">' + (n.done ? "重开" : "完成") + "</button>") +
          '<button type="button" class="hna-lnk" data-act="del" data-id="' + n.id + '">删除</button></div>';
      }
      b += "</div>";
    });
    b += "</div>";
    ui.panel.innerHTML = h + b;
    if (importing) fillImports();
  }
  function openPanel() { panelOpen = true; ui.panel.hidden = false; renderPanel(); }
  function closePanel() { panelOpen = false; ui.panel.hidden = true; editingNoteId = null; importing = false; setActive(null); }
  function fillImports() {
    storeGetAll(function (all) {
      var box = ui.panel.querySelector('[data-role="imports"]');
      if (!box) return;
      var rows = [];
      Object.keys(all).forEach(function (k) {
        if (k.indexOf("hna:") !== 0 || k === DOCKEY) return;
        var v = all[k] || {}; var ns = v.notes || [];
        if (!ns.length) return;
        var name = k.slice(4);
        try { name = decodeURIComponent(name.split("/").pop() || name); } catch (e) {}
        rows.push({ key: k, name: v.title || name || k, count: ns.length, t: v.t || 0 });
      });
      rows.sort(function (a, b2) { return b2.t - a.t; });
      if (!rows.length) { box.textContent = "没有其他文件的标注记录。"; return; }
      box.innerHTML = rows.slice(0, 12).map(function (r) {
        return '<div class="hna-btns hna-left" style="margin:2px 0"><button type="button" class="hna-lnk" data-import-key="' + esc(r.key) + '">' + esc(snip(r.name, 34)) + "</button><span style='color:#7A776F;font-size:10.5px'>" + r.count + " 条 · " + (r.t ? fmt(r.t) : "") + "</span></div>";
      }).join("");
    });
  }

  /* ---------------- 模式 ---------------- */
  function targetFor(node) {
    if (!node) return null;
    if (node.nodeType !== 1) node = node.parentElement;
    if (!node) return null;
    if (inUI(node)) return null;
    var svg = node.closest && node.closest("svg");
    if (svg) { var g = node.closest("g"); if (g && svg.contains(g)) node = g; }
    if (node === d.body || node === d.documentElement) return null;
    return node;
  }
  function setHover(node) { hoverEl = node; positionBox(ui.hoverBox, node); }
  function exitOthers(except) {
    if (except !== "note" && annotating) setAnnotating(false);
    if (except !== "region" && regioning) setRegioning(false);
    if (except !== "read" && reading) setReading(false);
    if (except !== "edit" && editing) setEditing(false);
  }
  function setAnnotating(v) {
    if (v) { exitOthers("note"); if (hidden) setHidden(false); }
    annotating = v;
    d.documentElement.style.cursor = v ? "crosshair" : (regioning ? "crosshair" : "");
    if (v) hint("标注模式：点元素、或划选一段文字（松手即可写意见）。要操作页面交互，先点「完成标注」或按 Esc。");
    else { setHover(null); if (bubMode === "compose") hideBubble(); hint(null); }
    syncBar(); schedulePins();
  }
  function setRegioning(v) {
    if (v) { exitOthers("region"); if (hidden) setHidden(false); }
    regioning = v;
    d.documentElement.style.cursor = v ? "crosshair" : (annotating ? "crosshair" : "");
    if (v) hint("框选模式：按住拖一个矩形（箭头、间距、留白都能框），松手写意见。Esc 退出。");
    else { drag = null; ui.dragBox.style.display = "none"; if (bubMode === "compose") hideBubble(); hint(null); }
    syncBar(); schedulePins();
  }
  function setReading(v) {
    if (v) { exitOthers("read"); if (hidden) setHidden(false); closePanel(); }
    reading = v;
    if (v) {
      ui.bar.hidden = true; ui.pill.hidden = false; hint(null);
      toast("阅读模式：划选文字即划线；点已划的线可改色、写想法、删除。点右上角圆点可展开工具条。", 4500);
    } else {
      ui.bar.hidden = false; ui.pill.hidden = true; hideBubble();
    }
    syncBar(); schedulePins();
  }
  function setEditing(v) {
    if (v) exitOthers("edit");
    editing = v;
    try {
      if (v) { prevBodyEditable = d.body.getAttribute("contenteditable"); d.body.setAttribute("contenteditable", "true"); }
      else { if (prevBodyEditable == null) d.body.removeAttribute("contenteditable"); else d.body.setAttribute("contenteditable", prevBodyEditable); }
    } catch (e) {}
    ui.root.setAttribute("contenteditable", "false"); ui.pins.setAttribute("contenteditable", "false");
    hint(v ? "编辑模式：直接点正文改字（Ctrl/⌘+Z 撤销）。「导出 HTML」才会存成文件；交互式原型的改动可能被页面脚本重画覆盖。" : null);
    syncBar(); schedulePins();
  }
  function setHidden(v) {
    hidden = v;
    if (v) { closePanel(); hideBubble(); if (annotating) setAnnotating(false); if (regioning) setRegioning(false); if (reading) setReading(false); }
    syncBar(); schedulePins(); scheduleSave();
  }

  function beginCompose(c, vx, vy) {
    composing = c; editingNoteId = null; setActive(null);
    refreshTarget();
    bubCompose(vx, vy);
  }
  function createMark(info, color) {
    var nn = {
      id: newId(), kind: "text", sel: info.sel, tag: info.tag, snippet: info.snippet,
      label: "划线「" + snip(info.exact, 20) + "」",
      exact: info.exact, prefix: info.prefix, suffix: info.suffix,
      hl: color, text: "", time: Date.now(), done: false
    };
    notes.push(nn);
    schedulePins(); scheduleSave();
    return nn;
  }

  /* ---------------- 事件：指针 ---------------- */
  function onMove(e) {
    if (annotating) setHover(targetFor(e.target));
    if (regioning && drag) {
      drag.x1 = e.pageX; drag.y1 = e.pageY;
      positionBoxAt(ui.dragBox, dragBoxNow());
      ui.dragBox.style.display = "block";
    }
  }
  function dragBoxNow() {
    return { left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) };
  }
  function onDown(e) {
    if (!regioning) return;
    if (inUI(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    drag = { x0: e.pageX, y0: e.pageY, x1: e.pageX, y1: e.pageY };
  }
  function onUp(e) {
    if (regioning && drag) {
      var b = dragBoxNow(); drag = null; ui.dragBox.style.display = "none";
      if (b.width < 10 || b.height < 10) return;
      var cx = b.left + b.width / 2 - window.pageXOffset, cy = b.top + b.height / 2 - window.pageYOffset;
      var host = hostForPoint(cx, cy) || d.body;
      var hr = host.getBoundingClientRect();
      var hl2 = hr.left + window.pageXOffset, ht = hr.top + window.pageYOffset;
      if (!hr.width || !hr.height) return;
      beginCompose({
        kind: "rect", sel: cssPath(host), tag: host.tagName.toLowerCase(),
        snippet: snip(host.textContent, 40) || "[图]",
        rx: (b.left - hl2) / hr.width, ry: (b.top - ht) / hr.height,
        rw: b.width / hr.width, rh: b.height / hr.height,
        label: "框选 · " + labelFor(host)
      }, e.clientX, e.clientY);
      schedulePins();
      return;
    }
    if (!(annotating || reading)) return;
    if (inUI(e.target)) return;
    setTimeout(function () {
      var info = grabSelection();
      if (info === "toobig") { toast("选区太大了，缩小一点再划。"); return; }
      if (!info) return;
      lastTextComposeAt = Date.now();
      var vx = info.rect ? (info.rect.left + info.rect.width / 2) : e.clientX;
      var vy = info.rect ? info.rect.bottom : e.clientY;
      if (reading) {
        pendingSel = info;
        bubSelection(vx, vy);
      } else {
        try { window.getSelection().removeAllRanges(); } catch (err) {}
        beginCompose(info, vx, vy);
      }
      schedulePins();
    }, 0);
  }
  function onClick(e) {
    /* 气泡内部的点击交给气泡自己的监听器 */
    if (ui.bub && !ui.bub.hidden && ui.bub.contains(e.target)) return;
    var pin = e.target && e.target.closest && e.target.closest(".hna-pin");
    if (pin) {
      e.preventDefault(); e.stopPropagation();
      var id = pin.getAttribute("data-id");
      var n0 = byId(id);
      if (n0) { hideBubble(); var r0 = pin.getBoundingClientRect(); bubNote(n0, r0.left + 10, r0.bottom + 2); renderPanel(); schedulePins(); }
      return;
    }
    /* 点气泡外面：先收气泡（同一手势冒出来的 click 不算） */
    if (ui.bub && !ui.bub.hidden && Date.now() - bubShownAt > 350) {
      var wasCompose = (bubMode === "compose" || bubMode === "idea");
      hideBubble(); renderPanel(); schedulePins();
      if (wasCompose) { e.preventDefault(); e.stopPropagation(); return; }
    }
    if (reading) {
      if (inUI(e.target)) return;
      if (Date.now() - lastTextComposeAt < 450) { return; }
      var hitN = findMarkAt(e.pageX, e.pageY);
      if (hitN) {
        e.preventDefault(); e.stopPropagation();
        bubNote(hitN, e.clientX, e.clientY);
        schedulePins();
      }
      return;
    }
    if (regioning) { if (!inUI(e.target)) { e.preventDefault(); e.stopPropagation(); } return; }
    if (!annotating) return;
    if (inUI(e.target)) return;
    if (Date.now() - lastTextComposeAt < 450) { e.preventDefault(); e.stopPropagation(); return; }
    var node = targetFor(e.target); if (!node) return;
    e.preventDefault(); e.stopPropagation();
    beginCompose({
      kind: "el", el: node, sel: cssPath(node), tag: node.tagName.toLowerCase(),
      snippet: snip(node.textContent, 40) || "[图]",
      label: labelFor(node)
    }, e.clientX, e.clientY);
  }

  /* ---------------- Enter 提交（中文输入法组合态豁免） ---------------- */
  function bindEnterSubmit(container, findPrimary) {
    container.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.isComposing || e.keyCode === 229) return; /* 拼音候选未上屏时，Enter 是输入法的 */
      var ta = e.target;
      if (!ta || ta.tagName !== "TEXTAREA") return;
      var btn2 = findPrimary(ta);
      if (btn2) { e.preventDefault(); e.stopPropagation(); btn2.click(); }
    }, true);
  }

  /* ---------------- 气泡按钮 ---------------- */
  function bindBubble() {
    bindEnterSubmit(ui.bub, function () { return ui.bub.querySelector(".hna-pri[data-bub]"); });
    ui.bub.addEventListener("click", function (e) {
      var dot = e.target.closest("[data-dot]");
      if (dot) {
        var color = dot.getAttribute("data-dot");
        if (bubMode === "sel" && pendingSel) {
          createMark(pendingSel, color);
          try { window.getSelection().removeAllRanges(); } catch (err) {}
          hideBubble();
        } else if (bubMode === "idea" && pendingSel) {
          pendingSel.hlPick = color;
          ui.bub.querySelectorAll(".hna-dot").forEach(function (x) { x.classList.toggle("hna-cur", x.getAttribute("data-dot") === color); });
        } else if (bubMode === "view" && bubNoteId) {
          var n = byId(bubNoteId);
          if (n) { n.hl = color; schedulePins(); scheduleSave(); ui.bub.querySelectorAll(".hna-dot").forEach(function (x) { x.classList.toggle("hna-cur", x.getAttribute("data-dot") === color); }); }
        }
        return;
      }
      var chip = e.target.closest(".hna-chip");
      if (chip) {
        if (chip.hasAttribute("data-cat")) lastCat = chip.getAttribute("data-cat");
        if (chip.hasAttribute("data-sev")) lastSev = chip.getAttribute("data-sev");
        ui.bub.querySelectorAll(".hna-chip[data-cat]").forEach(function (c2) { c2.classList.toggle("on", c2.getAttribute("data-cat") === lastCat); });
        ui.bub.querySelectorAll(".hna-chip[data-sev]").forEach(function (c2) { c2.classList.toggle("on", c2.getAttribute("data-sev") === lastSev); });
        return;
      }
      var b = e.target.closest("[data-bub]"); if (!b) return;
      var act = b.getAttribute("data-bub");
      if (act === "close") { hideBubble(); schedulePins(); return; }
      if (act === "idea") { if (pendingSel) { pendingSel.hlPick = HLS[0]; bubIdeaForm(parseFloat(ui.bub.style.left) + 20, parseFloat(ui.bub.style.top)); } return; }
      if (act === "save-idea") {
        var ta = ui.bub.querySelector("textarea");
        var text = (ta && ta.value || "").trim(); if (!text) { if (ta) ta.focus(); return; }
        if (!pendingSel) { hideBubble(); return; }
        var nn = createMark(pendingSel, pendingSel.hlPick || HLS[0]);
        nn.text = text; nn.cat = "note"; nn.sev = "suggest";
        nn.label = "划词「" + snip(nn.exact, 20) + "」";
        try { window.getSelection().removeAllRanges(); } catch (err) {}
        hideBubble(); renderPanel(); schedulePins(); scheduleSave();
        return;
      }
      if (act === "post") {
        var ta2 = ui.bub.querySelector("textarea");
        var t2 = (ta2 && ta2.value || "").trim(); if (!t2) { if (ta2) ta2.focus(); return; }
        if (!composing) { hideBubble(); return; }
        var nn2 = {
          id: newId(), kind: composing.kind === "el" ? "el" : composing.kind,
          sel: composing.sel, tag: composing.tag, snippet: composing.snippet, label: composing.label,
          text: t2, cat: lastCat, sev: lastSev, time: Date.now(), done: false
        };
        if (composing.kind === "text") { nn2.exact = composing.exact; nn2.prefix = composing.prefix; nn2.suffix = composing.suffix; }
        if (composing.kind === "rect") { nn2.rx = composing.rx; nn2.ry = composing.ry; nn2.rw = composing.rw; nn2.rh = composing.rh; }
        notes.push(nn2); composing = null;
        try { window.getSelection().removeAllRanges(); } catch (err) {}
        hideBubble(); setActive(nn2.id);
        renderPanel(); schedulePins(); scheduleSave(); return;
      }
      var n2 = bubNoteId ? byId(bubNoteId) : null;
      if (!n2) { hideBubble(); return; }
      if (act === "add-idea") {
        bubMode = "view";
        ui.bub.innerHTML = '<div class="hna-tgt">' + esc(n2.label) + "</div>" +
          '<textarea data-role="text" placeholder="写点想法…（Enter 提交，Shift+Enter 换行）"></textarea>' +
          '<div class="hna-btns"><button type="button" data-bub="close">取消</button><button type="button" class="hna-pri" data-bub="save-add-idea">保存</button></div>';
        var ta3 = ui.bub.querySelector("textarea"); if (ta3) ta3.focus();
        return;
      }
      if (act === "save-add-idea") {
        var ta4 = ui.bub.querySelector("textarea");
        var t4 = (ta4 && ta4.value || "").trim(); if (!t4) { if (ta4) ta4.focus(); return; }
        n2.text = t4; n2.cat = "note"; n2.sev = n2.sev || "suggest";
        hideBubble(); renderPanel(); schedulePins(); scheduleSave(); return;
      }
      if (act === "edit") { bubNote(n2, parseFloat(ui.bub.style.left) + 20, parseFloat(ui.bub.style.top) + 10, true); return; }
      if (act === "save-edit") {
        var ta5 = ui.bub.querySelector("textarea");
        var t5 = (ta5 && ta5.value || "").trim(); if (!t5) { if (ta5) ta5.focus(); return; }
        n2.text = t5; n2.cat = lastCat; n2.sev = lastSev;
        hideBubble(); renderPanel(); schedulePins(); scheduleSave(); return;
      }
      if (act === "done") { n2.done = !n2.done; hideBubble(); renderPanel(); schedulePins(); scheduleSave(); return; }
      if (act === "del") {
        if (!b.getAttribute("data-armed")) { b.setAttribute("data-armed", "1"); b.textContent = "确认删除"; return; }
        notes = notes.filter(function (z) { return z !== n2; });
        if (activeId === n2.id) setActive(null);
        hideBubble(); renderPanel(); schedulePins(); scheduleSave(); return;
      }
    });
  }

  /* ---------------- 清单（文字版） ---------------- */
  function locLine(n) {
    if (isMark(n)) return "划线「" + n.exact + "」";
    if (n.kind === "text") return "划词「" + n.exact + "」（所在块：" + (n.snippet || "") + "）";
    if (n.kind === "rect") return "框选区域，挂在 " + (n.label || "").replace(/^框选 · /, "") + "（相对位置 " + Math.round(n.rx * 100) + "%," + Math.round(n.ry * 100) + "%）";
    return (n.label || "") + (n.sel ? "（" + n.sel + "）" : "");
  }
  function docOrder(a, b) {
    var na = noteBoxes(a), nb = noteBoxes(b);
    var ya = na ? (na.boxes.length ? na.boxes[0].top : na.pin.y) : 1e12;
    var yb = nb ? (nb.boxes.length ? nb.boxes[0].top : nb.pin.y) : 1e12;
    return ya === yb ? a.time - b.time : ya - yb;
  }
  function listMD() {
    var open = notes.filter(function (n) { return !n.done; }).length;
    var must = notes.filter(function (n) { return !n.done && n.sev === "must" && !isMark(n); }).length;
    var marks = notes.filter(isMark);
    var t = new Date();
    var out = [];
    out.push("# 《" + (d.title || "页面") + "》标注清单");
    out.push("导出：" + t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()) + " " + pad(t.getHours()) + ":" + pad(t.getMinutes()) + " ｜ 共 " + notes.length + " 条（划线摘录 " + marks.length + "），未完成 " + open + "，必改 " + must);
    out.push("");
    if (marks.length) {
      out.push("## 摘录划线（" + marks.length + " 条，按原文顺序）");
      out.push("");
      marks.slice().sort(docOrder).forEach(function (n) {
        out.push("> " + n.exact.replace(/\s*\n\s*/g, " "));
        out.push("");
      });
    }
    var hasReview = notes.some(function (n) { return !isMark(n); });
    if (hasReview) {
      out.push("给 AI 的说明：以下意见针对同名 HTML 页面，按类型分组、必改在前。「位置」给出了元素路径或原文，请逐条评估并直接修改该 HTML；不建议执行的条目请说明原因。");
      out.push("");
    }
    Object.keys(CATS).forEach(function (ck) {
      var group = notes.filter(function (n) { return !isMark(n) && (n.cat || "visual") === ck; });
      if (!group.length) return;
      group.sort(function (a, b2) { return (a.sev === "must" ? 0 : 1) - (b2.sev === "must" ? 0 : 1); });
      out.push("## " + CATS[ck] + "（" + group.length + " 条）");
      out.push("");
      group.forEach(function (n) {
        out.push("### #" + (noteIndex(n) + 1) + " ｜ " + (SEVS[n.sev] || "建议") + " ｜ " + (n.done ? "已完成" : "未完成"));
        out.push("位置：" + locLine(n));
        out.push(fmt(n.time) + "：" + n.text);
        (n.replies || []).forEach(function (r2) { out.push("  ↳ " + (r2.author ? r2.author + "：" : "") + r2.text); });
        out.push("");
      });
    });
    return out.join("\n");
  }

  /* ---------------- 清单弹窗 ---------------- */
  var modal = null, modalTA = null;
  function fileBase() {
    var seg = "";
    try { seg = decodeURIComponent((location.pathname.split("/").pop() || "")).replace(/\.[^.]+$/, ""); } catch (e) { seg = ""; }
    return seg || (d.title || "页面").slice(0, 40);
  }
  function tsName() { var t = new Date(); return t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + "_" + pad(t.getHours()) + pad(t.getMinutes()); }
  function download(name, data, mime) {
    try {
      var blob = new Blob([data], { type: (mime || "text/html") + ";charset=utf-8" });
      var a = d.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
      ui.root.appendChild(a); a.click(); ui.root.removeChild(a);
      toast("已导出：" + name, 4000);
      return true;
    } catch (e) { toast("这里导出不了文件，请改用「复制全文」。", 4500); return false; }
  }
  function openListModal() {
    if (!notes.length) { toast("还没有标注：「标注」「框选」「阅读」任选一个开始。"); return; }
    if (!modal) {
      modal = el("div", "hna-mask"); modal.hidden = true;
      modal.innerHTML = '<div class="hna-modal"><div class="hna-mh"><span>标注清单</span><button type="button" data-lm="close">✕</button></div>' +
        '<textarea readonly spellcheck="false"></textarea>' +
        '<div class="hna-mb"><span class="hna-tip">复制全文粘给 AI 或丢进笔记库；「带图报告」逐条截图生成图文 HTML</span>' +
        '<button type="button" class="hna-pri" data-lm="copy">复制全文</button>' +
        '<button type="button" data-lm="dl">下载 .md</button>' +
        (hasRuntime ? '<button type="button" data-lm="report">带图报告</button>' : "") +
        "</div></div>";
      ui.root.appendChild(modal);
      modalTA = modal.querySelector("textarea");
      modal.addEventListener("click", function (e) {
        if (e.target === modal) { modal.hidden = true; return; }
        var b = e.target.closest("[data-lm]"); if (!b) return;
        var act = b.getAttribute("data-lm");
        if (act === "close") { modal.hidden = true; }
        else if (act === "copy") {
          var ok = false;
          try { modalTA.focus(); modalTA.select(); ok = d.execCommand("copy"); } catch (err) { ok = false; }
          if (!ok && navigator.clipboard) { try { navigator.clipboard.writeText(modalTA.value).catch(function () {}); } catch (err) {} }
          toast(ok ? "已复制全文，直接粘贴即可。" : "如果没复制上，请全选文本框内容手动复制。", 3500);
        } else if (act === "dl") {
          download("标注清单_" + fileBase() + "_" + tsName() + ".md", modalTA.value, "text/markdown");
        } else if (act === "report") {
          modal.hidden = true;
          runReport(b);
        }
      });
    }
    modalTA.value = listMD(); modal.hidden = false; modalTA.scrollTop = 0;
  }

  /* ---------------- 带图报告 ---------------- */
  function captureTab() {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; reject(new Error("timeout")); } }, 4000);
      try {
        chrome.runtime.sendMessage({ type: "hna-capture" }, function (resp) {
          if (done) return; done = true; clearTimeout(timer);
          var le = chrome.runtime.lastError;
          if (le || !resp || !resp.ok) reject(new Error((le && le.message) || (resp && resp.error) || "capture failed"));
          else resolve(resp.dataUrl);
        });
      } catch (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    });
  }
  function loadImg(url) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error("img")); };
      im.src = url;
    });
  }
  function cropShot(img, vb, color, num) {
    var scale = img.naturalWidth / window.innerWidth;
    var padPx = 36;
    var x = Math.max(0, (vb.left - padPx)), y = Math.max(0, (vb.top - padPx));
    var w = Math.min(window.innerWidth - x, vb.width + padPx * 2), h = Math.min(window.innerHeight - y, vb.height + padPx * 2);
    if (w <= 0 || h <= 0) return null;
    var cv = d.createElement("canvas");
    cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
    var ctx = cv.getContext("2d");
    ctx.drawImage(img, x * scale, y * scale, w * scale, h * scale, 0, 0, cv.width, cv.height);
    ctx.lineWidth = Math.max(2, 2 * scale);
    ctx.strokeStyle = color;
    ctx.strokeRect((vb.left - x) * scale, (vb.top - y) * scale, vb.width * scale, vb.height * scale);
    var r = 11 * scale, cx0 = (vb.left - x) * scale, cy0 = (vb.top - y) * scale;
    ctx.beginPath(); ctx.arc(cx0, cy0, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = Math.max(1.5, 1.5 * scale); ctx.strokeStyle = "#FFFFFF"; ctx.stroke();
    ctx.fillStyle = "#FFF"; ctx.font = "bold " + Math.round(11 * scale) + "px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(num), cx0, cy0 + 0.5 * scale);
    return cv.toDataURL("image/jpeg", 0.85);
  }
  function runReport(btnEl) {
    if (!hasRuntime) { toast("这个环境拿不到截图能力。"); return; }
    if (capturing) return;
    capturing = true;
    var wasHidden = hidden, wasAnn = annotating, wasReg = regioning, wasEdit = editing, wasRead = reading;
    if (wasAnn) setAnnotating(false); if (wasReg) setRegioning(false); if (wasEdit) setEditing(false); if (wasRead) setReading(false);
    hideBubble();
    var sx = window.pageXOffset, sy = window.pageYOffset;
    var oldTitle = d.title;
    ui.root.style.visibility = "hidden"; ui.pins.style.visibility = "hidden";
    renderPins();
    var items = [], i = 0;
    var seq = notes.slice();
    function step() {
      if (i >= seq.length) { finish(); return; }
      var n = seq[i]; i++;
      try { d.title = "截图 " + i + "/" + seq.length + "…"; } catch (e) {}
      var nb = noteBoxes(n);
      if (!nb) { items.push({ n: n, img: null }); step(); return; }
      var box = nb.boxes.length ? unionBox(nb.boxes) : { left: nb.pin.x - 60, top: nb.pin.y, width: 120, height: 60 };
      if (n.kind === "el") { var a = resolveEl(n); if (a) { var r0 = a.getBoundingClientRect(); box = { left: r0.left + window.pageXOffset, top: r0.top + window.pageYOffset, width: r0.width, height: r0.height }; } }
      window.scrollTo(0, Math.max(0, box.top - Math.max(60, (window.innerHeight - box.height) / 2)));
      setTimeout(function () {
        var vb = { left: box.left - window.pageXOffset, top: box.top - window.pageYOffset, width: box.width, height: box.height };
        vb.left = Math.max(0, vb.left); vb.top = Math.max(0, vb.top);
        vb.width = Math.min(vb.width, window.innerWidth - vb.left);
        vb.height = Math.min(vb.height, window.innerHeight - vb.top);
        captureTab().then(function (dataUrl) { return loadImg(dataUrl); }).then(function (img) {
          var shot = null;
          try { shot = cropShot(img, vb, catColor(n), noteIndex(n) + 1); } catch (e) { shot = null; }
          items.push({ n: n, img: shot });
          setTimeout(step, 650);
        }, function (err) {
          items.push({ n: n, img: null, err: String(err && err.message || err) });
          setTimeout(step, 650);
        });
      }, 420);
    }
    function finish() {
      try { d.title = oldTitle; } catch (e) {}
      window.scrollTo(sx, sy);
      ui.root.style.visibility = ""; ui.pins.style.visibility = "";
      capturing = false;
      renderPins();
      var failed = items.filter(function (it) { return !it.img; }).length;
      download("标注报告_" + fileBase() + "_" + tsName() + ".html", reportHTML(items), "text/html");
      toast("带图报告已生成" + (failed ? "（" + failed + " 条没截到图，已用文字代替）" : "") + "。", 5000);
      if (wasHidden) setHidden(true);
    }
    step();
  }
  function reportHTML(items) {
    var t = new Date();
    var open = notes.filter(function (n) { return !n.done; }).length;
    var must = notes.filter(function (n) { return !n.done && n.sev === "must" && !isMark(n); }).length;
    var h = "<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>标注报告 · " + esc(d.title || fileBase()) + "</title><style>" +
      "body{margin:0;background:#F5F6F3;color:#2C2A26;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7}" +
      ".wrap{max-width:860px;margin:0 auto;padding:40px 20px 80px}" +
      "h1{font-size:22px;color:#1F401B;margin:0 0 4px}" +
      ".meta{font-size:12px;color:#7A776F;margin-bottom:28px}" +
      "h2{font-size:15px;color:#1F401B;border-bottom:1px solid #D8D5CC;padding-bottom:6px;margin:34px 0 14px}" +
      ".card{background:#FFFEFA;border:1px solid #E3E2DA;border-radius:12px;padding:14px 16px;margin-bottom:14px}" +
      ".card.done{opacity:.65}" +
      ".hd{display:flex;align-items:center;gap:6px;font-size:12px;flex-wrap:wrap}" +
      ".num{display:inline-flex;width:20px;height:20px;border-radius:50%;color:#fff;font-size:11px;font-weight:700;align-items:center;justify-content:center}" +
      ".cat{display:inline-block;font-size:10px;border-radius:4px;padding:1px 6px;color:#fff}" +
      ".sev{display:inline-block;font-size:10px;border-radius:4px;padding:1px 6px;border:1px solid #C43D2B;color:#C43D2B}" +
      ".st{font-size:10.5px;color:#7A776F;margin-left:auto}" +
      ".loc{font-size:11px;color:#7A776F;margin:6px 0 2px;word-break:break-all}" +
      ".txt{margin:4px 0 8px;white-space:pre-wrap}" +
      "blockquote{margin:4px 0 8px;padding:6px 12px;border-left:3px solid #C9B27A;background:#FBF7EE;border-radius:0 8px 8px 0}" +
      "img{max-width:100%;border:1px solid #E3E2DA;border-radius:8px;display:block}" +
      ".noimg{font-size:11px;color:#7A776F;border:1px dashed #D8D5CC;border-radius:8px;padding:10px;text-align:center}" +
      "</style></head><body><div class=\"wrap\">" +
      "<h1>标注报告 · " + esc(d.title || fileBase()) + "</h1>" +
      "<div class=\"meta\">" + t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()) + " " + pad(t.getHours()) + ":" + pad(t.getMinutes()) +
      " ｜ 共 " + notes.length + " 条 · 未完成 " + open + " · 必改 " + must + "</div>";
    var markItems = items.filter(function (it) { return isMark(it.n); });
    if (markItems.length) {
      h += "<h2>摘录划线（" + markItems.length + "）</h2>";
      markItems.forEach(function (it) {
        var n = it.n;
        h += "<div class=\"card\"><blockquote>" + esc(n.exact) + "</blockquote>" +
          (it.img ? "<img src=\"" + it.img + "\" alt=\"划线截图\">" : "") + "</div>";
      });
    }
    Object.keys(CATS).forEach(function (ck) {
      var group = items.filter(function (it) { return !isMark(it.n) && ((it.n.cat || "visual") === ck); });
      if (!group.length) return;
      group.sort(function (a, b2) { return (a.n.sev === "must" ? 0 : 1) - (b2.n.sev === "must" ? 0 : 1); });
      h += "<h2>" + CATS[ck] + "（" + group.length + "）</h2>";
      group.forEach(function (it) {
        var n = it.n, col = catColor(n);
        h += "<div class=\"card" + (n.done ? " done" : "") + "\"><div class=\"hd\">" +
          "<span class=\"num\" style=\"background:" + col + "\">" + (noteIndex(n) + 1) + "</span>" +
          "<span class=\"cat\" style=\"background:" + col + "\">" + catName(n) + "</span>" +
          (n.sev === "must" ? "<span class=\"sev\">必改</span>" : "") +
          "<span class=\"st\">" + fmt(n.time) + (n.done ? " · 已完成" : "") + "</span></div>" +
          "<div class=\"loc\">" + esc(locLine(n)) + "</div>" +
          "<div class=\"txt\">" + esc(n.text) + "</div>" +
          (it.img ? "<img src=\"" + it.img + "\" alt=\"标注 " + (noteIndex(n) + 1) + " 截图\">" : "<div class=\"noimg\">这条没截到图（不在当前画面，或截图失败）</div>") +
          "</div>";
      });
    });
    h += "</div></body></html>";
    return h;
  }

  /* ---------------- 导出自包含 HTML ---------------- */
  function ownSource(cb) {
    var tag = d.getElementById("hna-script");
    if (tag && tag.textContent && tag.textContent.length > 100) { cb(tag.textContent); return; }
    if (window.__HNA_SRC) { cb(window.__HNA_SRC); return; }
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
        fetch(chrome.runtime.getURL("inject.js")).then(function (r) { return r.text(); }).then(cb, function () { cb(null); });
        return;
      }
    } catch (e) {}
    cb(null);
  }
  function doExport() {
    var wasEdit = editing; if (wasEdit) setEditing(false);
    ownSource(function (src) {
      var clone = d.documentElement.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll("#hna-ui,#hna-pins,#hna-style,#hna-data,#hna-script"), function (n) { n.parentNode.removeChild(n); });
      Array.prototype.forEach.call(clone.querySelectorAll("script"), function (n) {
        if (n.textContent && n.textContent.indexOf("__hnaBooted") !== -1) n.parentNode.removeChild(n);
      });
      Array.prototype.forEach.call(clone.querySelectorAll("[contenteditable]"), function (n) { n.removeAttribute("contenteditable"); });
      var body = clone.querySelector("body");
      if (body) {
        var dataTag = d.createElement("script"); dataTag.id = "hna-data"; dataTag.setAttribute("type", "application/json");
        dataTag.textContent = JSON.stringify({ notes: notes, hidden: hidden }).replace(/<\//g, "<\\/");
        body.appendChild(dataTag);
        if (src) {
          var jsTag = d.createElement("script"); jsTag.id = "hna-script";
          jsTag.textContent = "\n" + src.replace(/<\/script/gi, "<\\/script") + "\n";
          body.appendChild(jsTag);
        }
      }
      var dt = "<!doctype html>";
      try { if (d.doctype && d.doctype.name) dt = "<!doctype " + d.doctype.name + ">"; } catch (e) {}
      var ok = download(fileBase() + "_标注.html", dt + "\n" + clone.outerHTML, "text/html");
      if (ok) contentDirty = false;
      if (!src) toast("已导出（此环境拿不到标注层代码，导出文件里的标注需用插件打开查看）。", 5000);
      if (wasEdit) setEditing(true);
    });
  }

  /* ---------------- UI 显隐 ---------------- */
  window.__hnaToggleUI = function () {
    if (!ui.root) return;
    uiVisible = !uiVisible;
    ui.root.style.display = uiVisible ? "" : "none";
    if (!uiVisible) { if (annotating) setAnnotating(false); if (regioning) setRegioning(false); if (editing) setEditing(false); if (reading) setReading(false); }
    schedulePins();
  };

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    ui.bar.addEventListener("click", function (e) {
      var b = e.target.closest("[data-hna]"); if (!b) return;
      var act = b.getAttribute("data-hna");
      if (act === "note") setAnnotating(!annotating);
      else if (act === "region") setRegioning(!regioning);
      else if (act === "read") setReading(!reading);
      else if (act === "hide") setHidden(!hidden);
      else if (act === "edit") setEditing(!editing);
      else if (act === "list") { if (ui.panel.hidden) openPanel(); else closePanel(); }
      else if (act === "export") doExport();
      else if (act === "overview") { try { chrome.runtime.sendMessage({ type: "hna-overview" }); } catch (err) {} }
      else if (act === "fold") window.__hnaToggleUI();
    });
    ui.pill.addEventListener("click", function () {
      ui.bar.hidden = false; ui.pill.hidden = true;
    });
    ui.panel.addEventListener("click", function (e) {
      var chip = e.target.closest(".hna-chip");
      if (chip && chip.hasAttribute("data-filter")) { catFilter = chip.getAttribute("data-filter"); renderPanel(); schedulePins(); return; }
      if (chip) {
        var form = chip.closest(".hna-form");
        if (form) {
          if (chip.hasAttribute("data-cat")) lastCat = chip.getAttribute("data-cat");
          if (chip.hasAttribute("data-sev")) lastSev = chip.getAttribute("data-sev");
          form.querySelectorAll(".hna-chip[data-cat]").forEach(function (c2) { c2.classList.toggle("on", c2.getAttribute("data-cat") === lastCat); });
          form.querySelectorAll(".hna-chip[data-sev]").forEach(function (c2) { c2.classList.toggle("on", c2.getAttribute("data-sev") === lastSev); });
        }
        return;
      }
      var imp = e.target.closest("[data-import-key]");
      if (imp) {
        var key = imp.getAttribute("data-import-key");
        storeGetAll(function (all) {
          var v = all[key];
          if (v && Array.isArray(v.notes) && v.notes.length) {
            var have = {}; notes.forEach(function (n) { have[n.id] = 1; });
            var added = 0;
            v.notes.forEach(function (n) { if (!have[n.id]) { notes.push(n); added++; } });
            importing = false; renderPanel(); schedulePins(); scheduleSave();
            toast("已导入 " + added + " 条标注（原记录保留）。", 4000);
          } else { toast("这条记录读不到标注。"); }
        });
        return;
      }
      var b = e.target.closest("[data-act]"); if (!b) return;
      var act = b.getAttribute("data-act"), id = b.getAttribute("data-id"), n = id ? byId(id) : null;
      if (act === "close") { closePanel(); return; }
      if (act === "export-open") { openListModal(); return; }
      if (act === "toggle-done") { showDone = b.checked; renderPanel(); schedulePins(); return; }
      if (act === "import") { importing = true; renderPanel(); return; }
      if (act === "cancel-import") { importing = false; renderPanel(); return; }
      if (!n) return;
      if (act === "locate") {
        setActive(n.id);
        var nb = noteBoxes(n);
        if (nb) scrollToBox(nb.boxes.length ? unionBox(nb.boxes) : { left: nb.pin.x, top: nb.pin.y, width: 10, height: 10 });
        renderPanel(); schedulePins(); return;
      }
      if (act === "edit") { editingNoteId = n.id; lastCat = n.cat || "visual"; lastSev = n.sev || "suggest"; renderPanel(); var rt = ui.panel.querySelector('[data-role="edittext"]'); if (rt) rt.focus(); return; }
      if (act === "cancel-edit") { editingNoteId = null; renderPanel(); return; }
      if (act === "save-edit") {
        var ta2 = ui.panel.querySelector('[data-role="edittext"]');
        var t2 = (ta2 && ta2.value || "").trim(); if (!t2) { if (ta2) ta2.focus(); return; }
        n.text = t2; n.cat = lastCat; n.sev = lastSev;
        editingNoteId = null; renderPanel(); schedulePins(); scheduleSave(); return;
      }
      if (act === "done") { n.done = !n.done; renderPanel(); schedulePins(); scheduleSave(); return; }
      if (act === "del") {
        if (!b.getAttribute("data-armed")) { b.setAttribute("data-armed", "1"); b.textContent = "确认删除"; return; }
        notes = notes.filter(function (z) { return z !== n; });
        if (activeId === n.id) setActive(null);
        renderPanel(); schedulePins(); scheduleSave(); return;
      }
    });
    ui.panel.addEventListener("change", function (e) {
      var b = e.target.closest('[data-act="toggle-done"]');
      if (b) { showDone = b.checked; renderPanel(); schedulePins(); }
    });
    bindEnterSubmit(ui.panel, function (ta) {
      var form = ta.closest(".hna-form");
      return form ? form.querySelector('[data-act="save-edit"]') : null;
    });
    bindBubble();
    d.addEventListener("mousemove", onMove, true);
    d.addEventListener("mousedown", onDown, true);
    d.addEventListener("mouseup", onUp, true);
    d.addEventListener("click", onClick, true);
    d.addEventListener("input", function () { if (editing) contentDirty = true; }, true);
    window.addEventListener("beforeunload", function (e) {
      if (contentDirty) { e.preventDefault(); e.returnValue = "页面内容有未导出的修改"; return e.returnValue; }
    });
    d.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (modal && !modal.hidden) { modal.hidden = true; e.stopPropagation(); return; }
      if (ui.bub && !ui.bub.hidden) { hideBubble(); schedulePins(); e.stopPropagation(); return; }
      if (reading) { setReading(false); e.stopPropagation(); return; }
      if (regioning) { if (drag) { drag = null; ui.dragBox.style.display = "none"; } else setRegioning(false); e.stopPropagation(); return; }
      if (annotating) { setAnnotating(false); e.stopPropagation(); }
    }, true);
    window.addEventListener("resize", schedulePins);
    window.addEventListener("load", schedulePins);
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(schedulePins);
    d.addEventListener("scroll", function () {
      if (bubMode === "sel") { hideBubble(); }
      schedulePins();
    }, true);
    if (window.MutationObserver) {
      var mo = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var t = records[i].target;
          if (t && !ui.root.contains(t) && !ui.pins.contains(t) && t !== ui.root && t !== ui.pins) { schedulePins(); return; }
        }
      });
      try {
        mo.observe(d.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "hidden", "open"] });
      } catch (e) {}
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    buildUI(); bind(); syncBar();
    var embedded = loadEmbedded();
    storeGet(function (stored) {
      if (stored && Array.isArray(stored.notes) && (stored.notes.length || !embedded)) {
        notes = stored.notes; hidden = !!stored.hidden;
      } else if (embedded) {
        notes = embedded.notes || []; hidden = !!embedded.hidden;
      }
      notes.forEach(function (n) {
        if (!n.kind) n.kind = "el";
        if (!isMark(n)) { if (!n.cat) n.cat = "visual"; if (!n.sev) n.sev = "suggest"; }
      });
      syncBar(); schedulePins();
      if (notes.length) toast("已载入 " + notes.length + " 条标注（" + (hidden ? "当前隐藏" : "点钉子或划线查看") + "）。", 3500);
    });
  }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

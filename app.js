// Triad — application logic.
// CodeMirror, the starter content, and the storage helper are all loaded as
// globals by the classic scripts before this file runs. If CodeMirror is
// somehow missing we fall back to <textarea>.

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ---------------- State ---------------- */
  const prefs = store.loadPrefs();
  const state = {
    pens: store.loadPens(),
    autoRun: prefs.autoRun !== false,
    layout: prefs.layout === "stack" ? "stack" : "split",
    active: ["html", "css", "js"].includes(prefs.active) ? prefs.active : "html",
    title: "Untitled pen",
    split: {
      x: clampN(prefs.splitX, 18, 82, 50),
      y: clampN(prefs.splitY, 18, 82, 46)
    },
    fontFs: clampN(prefs.fontFs, 11, 18, 13.5),
    previewW: ["full", "375", "768"].includes(prefs.previewW) ? prefs.previewW : "full",
    conFilter: ["all", "logs", "warn", "error"].includes(prefs.conFilter) ? prefs.conFilter : "all",
    theme: prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : null // null = follow system
  };
  let runId = 0;
  let debounceTimer = null;
  let draftTimer = null;

  function clampN(v, lo, hi, dflt) {
    v = Number(v);
    if (!isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }

  /* ---------------- DOM refs ---------------- */
  const app = $("app"), frame = $("frame"), output = $("output"), stage = $("stage");
  const conFeed = $("conFeed"), conCount = $("conCount");
  const liveDot = $("liveDot"), liveText = $("liveText"), lastRun = $("lastRun");
  const stLive = $("stLive"), stState = $("stState"), stRun = $("stRun"), stPos = $("stPos"), stSaved = $("stSaved");
  const autorunEl = $("autorun");
  const fileInput = $("file");
  const splitter = $("splitter"), popout = $("popout");
  const toastBox = $("toasts");

  /* ---------------- Small helpers ---------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // Neutralize a raw closing tag inside a raw-text block (script/style) of generated docs.
  function escTag(code, tag) {
    return String(code == null ? "" : code).replace(new RegExp("</(" + tag + ")", "gi"), "<\\/$1");
  }
  function nowTime() {
    const d = new Date();
    const p = (n) => (n < 10 ? "0" : "") + n;
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  /* ---------------- Editors (CodeMirror, with textarea fallback) ---------------- */
  function makeEditor(host, mode, onChange, onCursor) {
    let api;
    if (window.CodeMirror) {
      const opts = {
        mode, theme: "triad",
        lineNumbers: true, lineWrapping: true,
        autoCloseBrackets: true, matchBrackets: true,
        styleActiveLine: true, tabSize: 2, indentUnit: 2, indentWithTabs: false,
        extraKeys: {
          "Cmd-Enter": run, "Ctrl-Enter": run,
          "Cmd-F": "findPersistent", "Ctrl-F": "findPersistent",
          "Cmd-G": "findNext", "Ctrl-G": "findNext",
          "Shift-Cmd-G": "findPrev", "Shift-Ctrl-G": "findPrev",
          "Cmd-Alt-F": "replace", "Shift-Ctrl-F": "replace"
        }
      };
      if (mode === "htmlmixed") opts.autoCloseTags = true;
      const cm = window.CodeMirror(host, opts);
      cm.on("change", () => onChange());
      cm.on("cursorActivity", () => onCursor());
      api = {
        cm,
        get: () => cm.getValue(),
        set: (v) => cm.setValue(v == null ? "" : v),
        focus: () => cm.focus(),
        refresh: () => cm.refresh(),
        lines: () => cm.lineCount(),
        pos: () => { const c = cm.getCursor(); return { line: c.line + 1, col: c.ch + 1 }; },
        goTo: (line) => {
          const l = Math.max(0, Math.min(cm.lineCount() - 1, (line || 1) - 1));
          cm.setCursor({ line: l, ch: 0 }); cm.focus();
          if (cm.addLineClass) {
            cm.addLineClass(l, "background", "cm-jump-flash");
            setTimeout(() => { try { cm.removeLineClass(l, "background", "cm-jump-flash"); } catch (e) {} }, 1200);
          }
          try { cm.scrollIntoView({ line: l, ch: 0 }, 80); } catch (e) {}
        },
        insert: (text) => { cm.replaceSelection(text == null ? "" : String(text)); cm.focus(); },
        onFocus: (fn) => cm.on("focus", fn)
      };
    } else {
      const ta = document.createElement("textarea");
      ta.className = "fallback"; ta.spellcheck = false;
      ta.setAttribute("aria-label", mode + " source");
      host.appendChild(ta);
      ta.addEventListener("input", onChange);
      ta.addEventListener("keyup", onCursor);
      ta.addEventListener("click", onCursor);
      api = {
        cm: null,
        get: () => ta.value,
        set: (v) => { ta.value = v == null ? "" : v; },
        focus: () => ta.focus(),
        refresh: () => {},
        lines: () => ta.value.split("\n").length,
        pos: () => { const u = ta.value.slice(0, ta.selectionStart).split("\n"); return { line: u.length, col: u[u.length - 1].length + 1 }; },
        goTo: (line) => {
          const ls = ta.value.split("\n"); let idx = 0;
          const stop = Math.min(ls.length, (line || 1) - 1);
          for (let i = 0; i < stop; i++) idx += ls[i].length + 1;
          ta.focus(); try { ta.setSelectionRange(idx, idx); } catch (e) {}
        },
        insert: (text) => {
          const s = ta.selectionStart || 0, e = ta.selectionEnd || 0, str = text == null ? "" : String(text);
          ta.value = ta.value.slice(0, s) + str + ta.value.slice(e);
          const p = s + str.length; try { ta.setSelectionRange(p, p); } catch (er) {}
          ta.focus(); onChange(); onCursor();
        },
        onFocus: (fn) => ta.addEventListener("focus", fn)
      };
    }
    return api;
  }

  const ed = {};
  function makeFor(key, host, mode) {
    ed[key] = makeEditor(host, mode,
      () => { updateMeta(key); scheduleRun(); scheduleDraftSave(); },
      () => { if (state.active === key) updatePos(); }
    );
    ed[key].onFocus(() => setActive(key));
  }
  makeFor("html", $("ed-html"), "htmlmixed");
  makeFor("css", $("ed-css"), "css");
  makeFor("js", $("ed-js"), "javascript");

  function updateMeta(key) {
    const el = $("meta-" + key);
    if (el) el.textContent = ed[key].lines() + (ed[key].lines() === 1 ? " line" : " lines");
  }
  function updateAllMeta() { updateMeta("html"); updateMeta("css"); updateMeta("js"); }

  function setActive(key) {
    state.active = key;
    app.setAttribute("data-active", key);
    updatePos();
    persistPrefs();
  }
  function updatePos() {
    const p = ed[state.active].pos();
    stPos.textContent = state.active.toUpperCase() + " · Ln " + p.line + ", Col " + p.col;
  }

  /* ---------------- Preview build + run ---------------- */
  // The capture hook is authored as a REAL function (for maintainability), then
  // stringified and injected into the iframe BEFORE user JS. It mirrors console.*
  // with STRUCTURED, expandable values, plus console.table, %c/%s/%d/%o
  // formatting, runtime errors (with an editor-relative line), and promise
  // rejections. Every message is stamped with the run id so a stale preview can't
  // post into a newer run's console. Keep this free of any literal closing
  // script tag; buildDoc also runs it through escTag as belt-and-suspenders.
  function hookBody(__rid, __jsLine) {
    var MAXD = 4, MAXKEYS = 100, MAXSTR = 20000;
    var OKCSS = /^(color|background|background-color|font-weight|font-style|font-size|text-decoration|text-transform|letter-spacing|padding|margin|border|border-radius)$/i;
    function S(v) { try { return String(v); } catch (e) { return "[unstringifiable]"; } }
    function sanitizeCss(css) {
      var out = [];
      S(css).split(";").forEach(function (decl) {
        var i = decl.indexOf(":"); if (i < 0) return;
        var prop = decl.slice(0, i).trim(), val = decl.slice(i + 1).trim();
        if (OKCSS.test(prop) && !/url\s*\(|expression|[<>]/i.test(val)) out.push(prop + ":" + val);
      });
      return out.join(";");
    }
    function node(v, depth, seen, budget) {
      var t = typeof v;
      if (v === null) return { t: "null", v: "null" };
      if (t === "undefined") return { t: "undefined", v: "undefined" };
      if (t === "string") return { t: "string", v: v.length > MAXSTR ? v.slice(0, MAXSTR) + "…" : v };
      if (t === "number") return { t: "number", v: S(v) };
      if (t === "boolean") return { t: "boolean", v: S(v) };
      if (t === "bigint") return { t: "bigint", v: S(v) + "n" };
      if (t === "symbol") return { t: "symbol", v: S(v) };
      if (t === "function") return { t: "function", v: "ƒ " + (v.name || "anonymous") + "()" };
      if (v instanceof Error) return { t: "error", v: (v.name || "Error") + ": " + (v.message || "") };
      if (typeof Node !== "undefined" && v instanceof Node) {
        var lab;
        try {
          if (v.nodeType === 1) lab = "<" + v.nodeName.toLowerCase() +
            (v.id ? "#" + v.id : "") +
            (v.className && typeof v.className === "string" && v.className.trim() ? "." + v.className.trim().replace(/\s+/g, ".") : "") + ">";
          else if (v.nodeType === 3) lab = "#text " + JSON.stringify(S(v.textContent).slice(0, 40));
          else lab = "#" + v.nodeName;
        } catch (e) { lab = "#node"; }
        return { t: "dom", v: lab };
      }
      if (v instanceof Date) return { t: "date", v: S(v) };
      if (v instanceof RegExp) return { t: "regexp", v: S(v) };
      if (seen.indexOf(v) >= 0) return { t: "circular", v: "[Circular]" };
      if (depth >= MAXD) return { t: Array.isArray(v) ? "array" : "object", v: Array.isArray(v) ? "Array(" + v.length + ")" : "{…}" };
      seen = seen.concat([v]);
      if (Array.isArray(v)) {
        var a = { t: "array", v: "Array(" + v.length + ")", children: [] };
        var lim = Math.min(v.length, MAXKEYS);
        for (var i = 0; i < lim; i++) {
          if (budget && budget.n++ > 2000) { a.more = (a.more || 0) + (lim - i); break; }
          a.children.push({ key: S(i), node: node(v[i], depth + 1, seen, budget) });
        }
        if (v.length > lim) a.more = (a.more || 0) + (v.length - lim);
        return a;
      }
      var ctor = "Object";
      try { ctor = (v.constructor && v.constructor.name) || "Object"; } catch (e) {}
      var o = { t: "object", children: [] }, keys = [];
      try { keys = Object.keys(v); } catch (e) {}
      var klim = Math.min(keys.length, MAXKEYS);
      for (var j = 0; j < klim; j++) {
        if (budget && budget.n++ > 2000) { o.more = (o.more || 0) + (klim - j); break; }
        var k = keys[j], child;
        try { child = node(v[k], depth + 1, seen, budget); } catch (e) { child = { t: "string", v: "(throws)" }; }
        o.children.push({ key: k, node: child });
      }
      if (keys.length > klim) o.more = (o.more || 0) + (keys.length - klim);
      o.v = (ctor && ctor !== "Object" ? ctor + " " : "") + "{" +
        o.children.slice(0, 5).map(function (c) { return c.key; }).join(", ") +
        (keys.length > 5 ? ", …" : "") + "}";
      return o;
    }
    function nodes(args) {
      var out = [], budget = { n: 0 };
      for (var i = 0; i < args.length; i++) {
        try { out.push(node(args[i], 0, [], budget)); } catch (e) { out.push({ t: "string", v: "[unserializable]" }); }
      }
      return out;
    }
    function inlinePreview(v) { try { return node(v, MAXD - 1, []).v; } catch (e) { return S(v); } }
    function formatStr(args) {
      if (!args.length || typeof args[0] !== "string" || args[0].indexOf("%") < 0) return null;
      var fmt = args[0], ai = 1, segs = [{ text: "", style: "" }], cur = 0, i = 0;
      while (i < fmt.length) {
        var c = fmt.charAt(i);
        if (c === "%" && i + 1 < fmt.length) {
          var d = fmt.charAt(i + 1);
          if (d === "%") { segs[cur].text += "%"; i += 2; continue; }
          if (d === "c") { segs.push({ text: "", style: sanitizeCss(ai < args.length ? args[ai++] : "") }); cur = segs.length - 1; i += 2; continue; }
          if (d === "s") { segs[cur].text += ai < args.length ? S(args[ai++]) : "%s"; i += 2; continue; }
          if (d === "d" || d === "i") { if (ai < args.length) { var dv = args[ai++]; var n = parseInt(typeof dv === "symbol" ? NaN : dv, 10); segs[cur].text += isNaN(n) ? "NaN" : S(n); } else segs[cur].text += "%" + d; i += 2; continue; }
          if (d === "f") { if (ai < args.length) { var fv = args[ai++]; var f = parseFloat(typeof fv === "symbol" ? NaN : fv); segs[cur].text += isNaN(f) ? "NaN" : S(f); } else segs[cur].text += "%" + d; i += 2; continue; }
          if (d === "o" || d === "O" || d === "j") { if (ai < args.length) segs[cur].text += inlinePreview(args[ai++]); else segs[cur].text += "%" + d; i += 2; continue; }
        }
        segs[cur].text += c; i++;
      }
      var rest = [];
      for (var r = ai; r < args.length; r++) rest.push(args[r]);
      return { segments: segs, rest: rest };
    }
    function post(p) {
      p.__triad = true; p.runId = __rid;
      try { parent.postMessage(p, "*"); } catch (e) {}
    }
    function send(kind, args) {
      try {
        var f = formatStr(args), p = { kind: kind };
        if (f) { p.format = f.segments; p.nodes = nodes(f.rest); }
        else p.nodes = nodes(args);
        post(p);
      } catch (e) {
        try { post({ kind: kind, nodes: nodes(args) }); } catch (_) {}
      }
    }
    function buildTable(data, columns) {
      var cols = [], rows = [], hasVal = false, MAXCOLS = 60;
      function add(c) { if (cols.indexOf(c) >= 0) return; if (cols.length >= MAXCOLS) return; cols.push(c); }
      var entries = [];
      if (Array.isArray(data)) for (var i = 0; i < Math.min(data.length, 1000); i++) entries.push([S(i), data[i]]);
      else if (data && typeof data === "object") { var ks = Object.keys(data); for (var j = 0; j < Math.min(ks.length, 1000); j++) entries.push([ks[j], data[ks[j]]]); }
      else entries.push(["0", data]);
      for (var e = 0; e < entries.length; e++) {
        var key = entries[e][0], val = entries[e][1], cells = {};
        if (val && typeof val === "object" && !(val instanceof Date)) {
          var vk = Object.keys(val);
          for (var m = 0; m < vk.length && cols.length <= MAXCOLS; m++) { add(vk[m]); cells[vk[m]] = inlinePreview(val[vk[m]]); }
        } else { hasVal = true; cells.Value = inlinePreview(val); }
        rows.push({ idx: key, cells: cells });
      }
      if (hasVal) add("Value");
      if (Array.isArray(columns)) cols = cols.filter(function (c) { return columns.indexOf(c) >= 0; });
      return { cols: cols, rows: rows };
    }
    var tableOrig = console.table;
    ["log", "info", "warn", "error", "debug"].forEach(function (m) {
      var orig = console[m] || console.log;
      console[m] = function () { send(m === "debug" ? "log" : m, [].slice.call(arguments)); try { orig.apply(console, arguments); } catch (e) {} };
    });
    console.table = function (data, columns) {
      try { post({ kind: "log", table: buildTable(data, columns), nodes: nodes([data]) }); }
      catch (e) { send("log", [data]); }
      try { if (tableOrig) tableOrig.apply(console, arguments); } catch (e) {}
    };
    window.addEventListener("error", function (e) {
      if (!e.message) return;
      var p = { kind: "error", nodes: [{ t: "string", v: e.message }] };
      // Only offer a JS-editor jump when the error line is actually within the
      // user's JS region (errors from inline <script> in the HTML pane sit before it).
      if (e.lineno && e.lineno > __jsLine) p.src = { line: e.lineno - __jsLine, col: e.colno || 0 };
      post(p);
    });
    window.addEventListener("unhandledrejection", function (e) {
      var r = e.reason;
      post({ kind: "error", nodes: [{ t: "string", v: "Unhandled rejection: " + (r && (r.stack || r.message) || S(r)) }] });
    });
  }

  // Build the injectable hook source for a run, stamping in the run id and the
  // document line where the user's JS begins (for editor-relative error lines).
  function buildHook(rid, jsLine) {
    return "(" + hookBody.toString() + ")(" + JSON.stringify(rid) + "," + JSON.stringify(jsLine) + ");";
  }

  function buildDoc() {
    runId++;
    const cssSrc = ed.css.get(), htmlSrc = ed.html.get(), jsSrc = ed.js.get();
    const head = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      "<style>" + escTag(cssSrc, "style") + "<\/style>";
    // The hook's newline count doesn't depend on the jsLine value, so a probe
    // build gives the correct document-line offset for the user's JS.
    const probe = head + "<script>" + escTag(buildHook(runId, 0), "script") +
      "<\/script></head><body>" + htmlSrc + "\n<script>\n";
    const jsLine = (probe.match(/\n/g) || []).length;
    return head + "<script>" + escTag(buildHook(runId, jsLine), "script") +
      "<\/script></head><body>" + htmlSrc + "\n<script>\n" +
      escTag(jsSrc, "script") + "<\/script><!-- run " + runId + " --></body></html>";
  }
  // Full-page version (no console hook) for opening in its own tab.
  function buildCleanDoc() {
    const title = state.title && state.title !== "Untitled pen" ? state.title : "Triad preview";
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      "<title>" + escapeHtml(title) + "</title>" +
      "<style>" + escTag(ed.css.get(), "style") + "<\/style>" +
      "</head><body>" + ed.html.get() +
      "<script>" + escTag(ed.js.get(), "script") + "<\/script>" +
      "</body></html>";
  }

  function run() {
    clearConsole(true);
    frame.srcdoc = buildDoc();
    const t = nowTime();
    lastRun.textContent = "ran at " + t;
    stRun.textContent = "ran at " + t;
    output.classList.remove("is-running");
    void output.offsetWidth;
    output.classList.add("is-running");
    setTimeout(() => output.classList.remove("is-running"), 750);
  }
  function scheduleRun() {
    if (!state.autoRun) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 400);
  }
  function openFullPage() {
    try {
      const url = URL.createObjectURL(new Blob([buildCleanDoc()], { type: "text/html" }));
      const w = window.open(url, "_blank");
      if (!w) toast("Your browser blocked the pop-up. Allow pop-ups to open the preview.", "error");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { toast("Couldn't open a full-page preview here.", "error"); }
  }

  /* ---------------- Console (structured, expandable) ---------------- */
  let conErrors = 0, conTotal = 0, conLast = null;
  const GLYPHS = { log: "›", info: "i", warn: "!", error: "✕" };
  let conQueue = [], conFlushScheduled = false;

  function clearConsole() {
    conFeed.innerHTML = "";
    conTotal = 0; conErrors = 0; conLast = null; conQueue = [];
    conCount.textContent = "0";
    conCount.classList.remove("has-err");
    showEmptyConsole();
  }
  function showEmptyConsole() {
    const d = document.createElement("div");
    d.className = "con-empty";
    d.innerHTML = "<b>Console is clear.</b><br>Output from <code>console.log()</code>, <code>warn</code>, <code>error</code>, <code>table</code>, and uncaught runtime errors in your code appears here. Objects are expandable.";
    conFeed.appendChild(d);
  }

  // --- structured value rendering ---
  function nodeText(n) { return n ? (n.v != null ? n.v : "") : ""; }
  function entryText(d) {
    if (d.table) return " table" + (d.table.cols || []).join(",") + ":" + (d.table.rows || []).length;
    const parts = [];
    if (d.format) parts.push(d.format.map((s) => s.text).join(""));
    (d.nodes || []).forEach((n) => parts.push(nodeText(n)));
    return parts.join(" ");
  }
  function renderNode(n, nested) {
    const t = n.t;
    if (t === "array" || t === "object") {
      const wrap = document.createElement("span");
      wrap.className = "cnode";
      const head = document.createElement("button");
      head.type = "button"; head.className = "cnode-toggle"; head.setAttribute("aria-expanded", "false");
      const tw = document.createElement("span"); tw.className = "cnode-tw"; tw.setAttribute("aria-hidden", "true"); tw.textContent = "▶";
      const prev = document.createElement("span"); prev.className = "cnode-prev"; prev.textContent = n.v || (t === "array" ? "Array" : "Object");
      head.appendChild(tw); head.appendChild(prev);
      const kids = document.createElement("span"); kids.className = "cnode-kids"; kids.hidden = true;
      (n.children || []).forEach((c) => {
        const row = document.createElement("span"); row.className = "cnode-row";
        const key = document.createElement("span"); key.className = "cnode-key"; key.textContent = c.key + ": ";
        row.appendChild(key); row.appendChild(renderNode(c.node, true)); kids.appendChild(row);
      });
      if (n.more) { const more = document.createElement("span"); more.className = "cnode-more"; more.textContent = "… " + n.more + " more"; kids.appendChild(more); }
      const hasKids = (n.children && n.children.length) || n.more;
      if (!hasKids) head.classList.add("is-leaf");
      head.addEventListener("click", () => {
        if (!hasKids) return;
        const open = kids.hidden;
        kids.hidden = !open; head.setAttribute("aria-expanded", String(open)); tw.textContent = open ? "▼" : "▶";
      });
      wrap.appendChild(head); wrap.appendChild(kids);
      return wrap;
    }
    const span = document.createElement("span");
    span.className = "cval cval-" + t;
    span.textContent = (t === "string" && nested) ? '"' + n.v + '"' : (n.v == null ? "" : n.v);
    return span;
  }
  function renderTable(tbl) {
    const t = document.createElement("table"); t.className = "con-table";
    const thead = document.createElement("thead"), htr = document.createElement("tr");
    const ih = document.createElement("th"); ih.textContent = "(index)"; htr.appendChild(ih);
    (tbl.cols || []).forEach((c) => { const th = document.createElement("th"); th.textContent = c; htr.appendChild(th); });
    thead.appendChild(htr); t.appendChild(thead);
    const tb = document.createElement("tbody");
    (tbl.rows || []).forEach((r) => {
      const tr = document.createElement("tr");
      const idx = document.createElement("td"); idx.textContent = r.idx; tr.appendChild(idx);
      (tbl.cols || []).forEach((c) => { const td = document.createElement("td"); const v = r.cells[c]; td.textContent = v == null ? "" : v; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); return t;
  }
  // Mirror the in-iframe %c allowlist on the parent side — never apply a
  // message-supplied style string to the parent DOM without re-validating
  // (a forged postMessage could otherwise inject arbitrary parent CSS).
  const OKCSS_PARENT = /^(color|background|background-color|font-weight|font-style|font-size|text-decoration|text-transform|letter-spacing|padding|margin|border|border-radius)$/i;
  function sanitizeCssParent(css) {
    const out = [];
    String(css).split(";").forEach((decl) => {
      const i = decl.indexOf(":"); if (i < 0) return;
      const prop = decl.slice(0, i).trim(), val = decl.slice(i + 1).trim();
      if (OKCSS_PARENT.test(prop) && !/url\s*\(|expression|[<>]/i.test(val)) out.push(prop + ":" + val);
    });
    return out.join(";");
  }
  function buildBody(d) {
    const body = document.createElement("span"); body.className = "txt";
    if (d.table) { body.appendChild(renderTable(d.table)); return body; }
    if (d.format) d.format.forEach((s) => { const sp = document.createElement("span"); if (s.style) { const safe = sanitizeCssParent(s.style); if (safe) sp.setAttribute("style", safe); } sp.textContent = s.text; body.appendChild(sp); });
    (d.nodes || []).forEach((n, i) => {
      if (i || d.format) body.appendChild(document.createTextNode(" "));
      body.appendChild(renderNode(n, false));
    });
    return body;
  }

  function focusJsLine(line) { setActive("js"); ed.js.goTo(line); }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove();
      }
      toast("Copied to clipboard.", "ok");
    } catch (e) { toast("Couldn't copy here.", "error"); }
  }

  function capFeed() {
    const MAX = 600;
    const rows = conFeed.querySelectorAll(".con-row");
    if (rows.length > MAX) for (let i = 0; i < rows.length - MAX; i++) if (rows[i]) rows[i].remove();
  }
  function pushNote(msg) {
    const empty = conFeed.querySelector(".con-empty"); if (empty) empty.remove();
    const note = document.createElement("div"); note.className = "con-note"; note.textContent = msg;
    conFeed.appendChild(note); conLast = null;
  }
  function pushEntry(d) {
    const empty = conFeed.querySelector(".con-empty"); if (empty) empty.remove();
    const kind = d.kind || "log";
    conTotal++; if (kind === "error") conErrors++;
    conCount.textContent = String(conTotal);
    conCount.classList.toggle("has-err", conErrors > 0);

    const text = entryText(d);
    const sig = kind + "\\u0000" + text;
    if (conLast && conLast.sig === sig && !d.table && conLast.row.parentNode) {
      conLast.n++;
      if (!conLast.repEl) {
        conLast.repEl = document.createElement("span"); conLast.repEl.className = "rep";
        conLast.row.insertBefore(conLast.repEl, conLast.row.querySelector("time"));
      }
      conLast.repEl.textContent = "×" + conLast.n;
      conLast.row.setAttribute("aria-label", text + " (repeated " + conLast.n + " times)");
      const tEl = conLast.row.querySelector("time"); if (tEl) tEl.textContent = nowTime();
      if ((conFeed.scrollHeight - conFeed.scrollTop - conFeed.clientHeight) < 64) conFeed.scrollTop = conFeed.scrollHeight;
      return;
    }

    const nearBottom = (conFeed.scrollHeight - conFeed.scrollTop - conFeed.clientHeight) < 48;
    const row = document.createElement("div");
    row.className = "con-row t-" + kind + " enter";
    const g = document.createElement("span"); g.className = "glyph"; g.setAttribute("aria-hidden", "true"); g.textContent = GLYPHS[kind] || "›";
    row.appendChild(g);
    row.appendChild(buildBody(d));
    if (d.src && d.src.line) {
      const jump = document.createElement("button");
      jump.type = "button"; jump.className = "con-jump";
      jump.textContent = "JS:" + d.src.line; jump.title = "Go to line " + d.src.line + " in the JS editor";
      jump.addEventListener("click", () => focusJsLine(d.src.line));
      row.appendChild(jump);
    }
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "con-copy"; copy.title = "Copy this line"; copy.setAttribute("aria-label", "Copy this line"); copy.textContent = "⎘";
    copy.addEventListener("click", () => copyText(text));
    row.appendChild(copy);
    const ts = document.createElement("time"); ts.textContent = nowTime(); row.appendChild(ts);
    row.setAttribute("aria-label", (kind === "error" ? "Error: " : kind === "warn" ? "Warning: " : "") + (text || "(empty)"));
    conFeed.appendChild(row);
    setTimeout(() => row.classList.remove("enter"), 200);

    conLast = { sig, row, repEl: null, n: 1 };
    if (nearBottom) conFeed.scrollTop = conFeed.scrollHeight;
  }
  function flushConsole() {
    conFlushScheduled = false;
    let batch = conQueue; conQueue = [];
    const MAXB = 800;
    if (batch.length > MAXB) {
      const dropped = batch.length - MAXB;
      let droppedErr = 0;
      for (let k = 0; k < dropped; k++) if ((batch[k].kind || "log") === "error") droppedErr++;
      batch = batch.slice(batch.length - MAXB);
      conTotal += dropped; conErrors += droppedErr;
      conCount.textContent = String(conTotal);
      conCount.classList.toggle("has-err", conErrors > 0);
      pushNote("… " + dropped + " earlier messages hidden (console flood)");
    }
    for (let i = 0; i < batch.length; i++) pushEntry(batch[i]);
    capFeed();
  }
  function enqueueEntry(d) {
    conQueue.push(d);
    // Bound memory even if rAF never fires (e.g. a backgrounded tab logging in a loop).
    if (conQueue.length > 5000) conQueue.splice(0, conQueue.length - 5000);
    if (!conFlushScheduled) { conFlushScheduled = true; requestAnimationFrame(flushConsole); }
  }
  window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || d.__triad !== true) return;
    if (d.runId !== runId) return; // fence stale runs
    enqueueEntry(d);
  });
  function setConsoleFilter(f) {
    state.conFilter = f;
    conFeed.setAttribute("data-filter", f);
    document.querySelectorAll(".cf-btn").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.getAttribute("data-filter") === f)));
    persistPrefs();
  }

  /* ---------------- Working draft (autosave) ---------------- */
  function currentDoc() {
    return { title: state.title, html: ed.html.get(), css: ed.css.get(), js: ed.js.get() };
  }
  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftNow, 600);
  }
  function saveDraftNow() {
    const ok = store.saveDraft(currentDoc());
    if (ok) flashSaved();
  }
  let savedTimer = null;
  function flashSaved() {
    if (!stSaved) return;
    stSaved.textContent = "draft saved";
    stSaved.style.opacity = "1";
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { stSaved.style.opacity = "0"; }, 1400);
  }

  function setAll(data, opts) {
    ed.html.set(data.html || "");
    ed.css.set(data.css || "");
    ed.js.set(data.js || "");
    state.title = data.title || "Untitled pen";
    updateAllMeta(); updatePos();
    if (!opts || opts.saveDraft !== false) saveDraftNow();
    run();
  }

  /* ---------------- Library (save / load / rename / duplicate / delete) ---------------- */
  function persistPens() { return store.savePens(state.pens); }

  // Unique pen id even when two pens are created within the same millisecond.
  let idSeq = 0;
  function uid(ts, seq) { return "p" + ts.toString(36) + "-" + seq.toString(36); }
  function newId() { return uid(Date.now(), idSeq++); }

  function doSave() {
    const suggested = (state.title && state.title !== "Untitled pen") ? state.title : ("Pen " + (state.pens.length + 1));
    openModal({
      title: "Save pen",
      body: "Keep a snapshot of the current HTML, CSS, and JS. It is stored in this browser.",
      label: "Pen name", value: suggested, okLabel: "Save",
      onOk(name) {
        name = (name || "").trim() || ("Pen " + (state.pens.length + 1));
        const pen = currentDoc();
        pen.title = name; pen.id = newId(); pen.savedAt = Date.now();
        state.pens.push(pen);
        state.title = name;
        const ok = persistPens();
        toast(ok ? ('Saved "' + name + '".') : ('Kept in memory, but this browser’s storage is full — use Export to save "' + name + '".'), ok ? "ok" : "error");
      }
    });
  }

  const libModal = $("libModal"), libList = $("libList"), libSearch = $("libSearch");
  let libLastFocused = null;

  function openLibrary() {
    libLastFocused = document.activeElement;
    libSearch.value = "";
    renderLibrary("");
    libModal.hidden = false;
    document.addEventListener("keydown", libKeys, true);
    setTimeout(() => libSearch.focus(), 0);
  }
  function closeLibrary() {
    libModal.hidden = true;
    document.removeEventListener("keydown", libKeys, true);
    if (libLastFocused && libLastFocused.focus) libLastFocused.focus();
  }
  // Keep Tab focus inside a dialog box (Library + Shortcuts overlays; the confirm
  // modal has its own equivalent inside modalKeys).
  function trapTab(box, e) {
    if (e.key !== "Tab" || !box) return;
    const f = [].slice.call(box.querySelectorAll("button, input, [tabindex]")).filter((n) => !n.hidden && n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function libKeys(e) {
    // Let a dialog stacked over the library (rename/delete confirm, or the palette)
    // handle its own keys, so Escape there doesn't also close the whole library.
    if (!modal.hidden || !cmdModal.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeLibrary(); return; }
    trapTab(libModal.querySelector(".modal"), e);
  }
  function renderLibrary(filter) {
    filter = (filter || "").toLowerCase().trim();
    const pens = state.pens
      .slice()
      .reverse()
      .filter((p) => !filter || (p.title || "").toLowerCase().includes(filter));

    if (!state.pens.length) {
      libList.innerHTML = '<li class="lib-empty">No saved pens yet. Use <b>Save</b> to keep the current work here. Pens are stored in this browser; use <b>Export</b> to keep one as a file.</li>';
      return;
    }
    if (!pens.length) {
      libList.innerHTML = '<li class="lib-empty">No pens match \u201c' + escapeHtml(filter) + '\u201d.</li>';
      return;
    }
    libList.innerHTML = pens.map((p) =>
      '<li class="lib-row" data-id="' + p.id + '">' +
        '<button type="button" class="lib-main" data-act="load" title="Load this pen">' +
          '<div class="lib-name">' + escapeHtml(p.title) + "</div>" +
          '<div class="lib-when">saved ' + timeAgo(p.savedAt) + "</div>" +
        "</button>" +
        '<div class="lib-acts">' +
          '<button type="button" class="mini" data-act="rename">Rename</button>' +
          '<button type="button" class="mini" data-act="dupe">Duplicate</button>' +
          '<button type="button" class="mini" data-act="del">Delete</button>' +
        "</div>" +
      "</li>"
    ).join("");
  }
  function penById(id) { return state.pens.filter((p) => p.id === id)[0]; }

  libList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const row = e.target.closest(".lib-row");
    const id = row && row.getAttribute("data-id");
    const pen = penById(id);
    if (!pen) return;
    const act = btn.getAttribute("data-act");

    if (act === "load") {
      setAll(pen);
      closeLibrary();
      toast('Loaded "' + pen.title + '".', "info");
    } else if (act === "rename") {
      openModal({
        title: "Rename pen", label: "Pen name", value: pen.title, okLabel: "Rename",
        onOk(name) {
          name = (name || "").trim();
          if (!name) return;
          const wasCurrent = state.title === pen.title; // detect BEFORE mutating pen.title
          pen.title = name;
          if (wasCurrent) state.title = name;            // keep the live title in sync
          persistPens();
          renderLibrary(libSearch.value);
          toast("Renamed.", "ok");
        }
      });
    } else if (act === "dupe") {
      const copy = { title: pen.title + " copy", html: pen.html, css: pen.css, js: pen.js, id: newId(), savedAt: Date.now() };
      state.pens.push(copy);
      const dok = persistPens();
      renderLibrary(libSearch.value);
      toast(dok ? "Duplicated." : "Duplicated in memory, but storage is full — use Export to keep it.", dok ? "ok" : "error");
    } else if (act === "del") {
      openModal({
        title: "Delete pen?",
        body: 'This permanently removes \u201c' + pen.title + '\u201d from this browser.',
        okLabel: "Delete", danger: true,
        onOk() {
          const i = state.pens.indexOf(pen);
          if (i >= 0) state.pens.splice(i, 1);
          persistPens();
          renderLibrary(libSearch.value);
          toast("Deleted.", "info");
        }
      });
    }
  });
  libSearch.addEventListener("input", () => renderLibrary(libSearch.value));

  /* ---------------- Export / Import ---------------- */
  function slug(s) {
    return (String(s || "").toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "")) || "triad-pen";
  }
  function buildExport(pen) {
    // JSON metadata for perfect round-trip; escaping "<" keeps any closing script tag inside strings inert.
    const meta = JSON.stringify(pen).replace(/</g, "\\u003c");
    return '<!doctype html>\n<html lang="en">\n<head>\n' +
      '<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      "<title>" + escapeHtml(pen.title || "Triad pen") + "</title>\n" +
      "<style>\n" + escTag(pen.css, "style") + "\n<\/style>\n" +
      "</head>\n<body>\n" +
      (pen.html || "") + "\n" +
      "<script>\n" + escTag(pen.js, "script") + "\n<\/script>\n" +
      '<script type="application/json" id="triad-pen">' + meta + "<\/script>\n" +
      "</body>\n</html>\n";
  }
  function download(filename, text) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
      return true;
    } catch (e) { return false; }
  }
  function doExport() {
    const pen = currentDoc();
    const ok = download(slug(pen.title) + ".html", buildExport(pen));
    toast(ok ? ("Exported " + slug(pen.title) + ".html") : "Couldn't start the download here.", ok ? "ok" : "error");
  }
  function importFromText(text) {
    let data = null;
    try {
      const doc = new DOMParser().parseFromString(text, "text/html");
      const metaEl = doc.getElementById("triad-pen");
      if (metaEl && metaEl.textContent) {
        try { data = JSON.parse(metaEl.textContent); } catch (e) { data = null; }
      }
      if (!data || (data.html == null && data.css == null && data.js == null)) {
        const styleEl = doc.querySelector("style");
        const scripts = [].slice.call(doc.querySelectorAll("script")).filter((s) => !/application\/json/i.test(s.getAttribute("type") || ""));
        const bodyClone = doc.body ? doc.body.cloneNode(true) : null;
        if (bodyClone) [].slice.call(bodyClone.querySelectorAll("style,script")).forEach((n) => n.remove());
        data = {
          title: doc.title || "Imported pen",
          css: styleEl ? styleEl.textContent : "",
          js: scripts.length ? scripts[scripts.length - 1].textContent : "",
          html: bodyClone ? bodyClone.innerHTML.trim() : ""
        };
        toast("Imported best-effort — this file wasn't exported from Triad.", "info");
      } else {
        toast('Imported "' + (data.title || "pen") + '".', "ok");
      }
    } catch (e) {
      toast("That file isn't a readable pen.", "error");
      return;
    }
    setAll(data);
  }
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { importFromText(String(r.result)); fileInput.value = ""; };
    r.onerror = () => { toast("Could not read that file.", "error"); fileInput.value = ""; };
    r.readAsText(f);
  });

  /* ---------------- Reset ---------------- */
  function doReset() {
    openModal({
      title: "Reset to starter?",
      body: "This replaces the current HTML, CSS, and JS with the starter template. Your saved pens are kept.",
      okLabel: "Reset", danger: true,
      onOk() {
        setAll({ title: "Untitled pen", html: STARTER.html, css: STARTER.css, js: STARTER.js });
        toast("Reset to the starter template.", "info");
      }
    });
  }

  /* ---------------- Toasts ---------------- */
  function toast(msg, kind) {
    const t = document.createElement("div");
    t.className = "toast " + (kind || "info");
    t.textContent = msg;
    toastBox.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => { if (t.parentNode) t.remove(); }, 240); }, 2600);
  }

  /* ---------------- Modal (confirm / prompt) ---------------- */
  const modal = $("modal"), modalBox = $("modalBox");
  const modalTitle = $("modalTitle"), modalBody = $("modalBody"), modalInput = $("modalInput");
  const modalOk = $("modalOk"), modalCancel = $("modalCancel");
  let modalOnOk = null, lastFocused = null;

  function openModal(cfg) {
    lastFocused = document.activeElement;
    modalTitle.textContent = cfg.title || "";
    modalBody.textContent = cfg.body || "";
    modalBody.style.display = cfg.body ? "" : "none";
    modalOk.textContent = cfg.okLabel || "OK";
    modalOk.classList.toggle("btn-danger", !!cfg.danger);
    if (cfg.label != null) {
      modalInput.hidden = false;
      modalInput.value = cfg.value || "";
      modalInput.setAttribute("aria-label", cfg.label);
      modalInput.placeholder = cfg.label;
    } else {
      modalInput.hidden = true;
    }
    modalOnOk = cfg.onOk || null;
    modal.hidden = false;
    document.addEventListener("keydown", modalKeys, true);
    setTimeout(() => { if (!modalInput.hidden) { modalInput.focus(); modalInput.select(); } else modalOk.focus(); }, 0);
  }
  function closeModal() {
    modal.hidden = true;
    document.removeEventListener("keydown", modalKeys, true);
    modalOnOk = null;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }
  function confirmModal() {
    const fn = modalOnOk;
    const val = modalInput.hidden ? undefined : modalInput.value;
    closeModal();
    if (fn) fn(val);
  }
  function modalKeys(e) {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
    if (e.key === "Enter" && !modalInput.hidden) { e.preventDefault(); confirmModal(); return; }
    if (e.key === "Tab") {
      let f = [].slice.call(modalBox.querySelectorAll("button, input")).filter((n) => !n.hidden && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  modalOk.addEventListener("click", confirmModal);
  modalCancel.addEventListener("click", closeModal);
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeModal(); });
  libModal.addEventListener("mousedown", (e) => { if (e.target === libModal) closeLibrary(); });
  $("libClose").addEventListener("click", closeLibrary);

  /* ---------------- Shortcuts overlay ---------------- */
  const kbdModal = $("kbdModal");
  function openShortcuts() { kbdModal.hidden = false; document.addEventListener("keydown", kbdKeys, true); setTimeout(() => $("kbdClose").focus(), 0); }
  function closeShortcuts() { kbdModal.hidden = true; document.removeEventListener("keydown", kbdKeys, true); }
  function kbdKeys(e) {
    if (e.key === "Escape") { e.preventDefault(); closeShortcuts(); return; }
    trapTab(kbdModal.querySelector(".modal"), e);
  }
  $("kbdClose").addEventListener("click", closeShortcuts);
  kbdModal.addEventListener("mousedown", (e) => { if (e.target === kbdModal) closeShortcuts(); });
  $("help").addEventListener("click", openShortcuts);

  /* ---------------- Command palette ---------------- */
  const cmdModal = $("cmdModal"), cmdInput = $("cmdInput"), cmdList = $("cmdList");
  let cmdItems = [], cmdSel = 0, cmdLastFocused = null;
  function commandList() {
    const C = (label, hint, where, fn) => ({ label, hint, where, run: fn });
    return [
      C("Run preview", "Ctrl/⌘ Enter", "Preview", run),
      C("Tidy current editor", "", "Edit", tidyActive),
      C("Insert image…", "", "Edit", openImagePicker),
      C("Focus HTML editor", "", "Edit", () => { setActive("html"); ed.html.focus(); }),
      C("Focus CSS editor", "", "Edit", () => { setActive("css"); ed.css.focus(); }),
      C("Focus JS editor", "", "Edit", () => { setActive("js"); ed.js.focus(); }),
      C("Save pen", "Ctrl/⌘ S", "Pen", doSave),
      C("Open library", "Ctrl/⌘ O", "Pen", openLibrary),
      C("Export pen as .html", "", "Pen", doExport),
      C("Import pen…", "", "Pen", () => fileInput.click()),
      C("Reset to starter", "", "Pen", doReset),
      C("Full-page preview", "", "Preview", openFullPage),
      C("Clear console", "Ctrl/⌘ K", "Console", () => clearConsole()),
      C("Toggle theme (light / dark)", "", "View", toggleTheme),
      C(state.autoRun ? "Turn auto-run off" : "Turn auto-run on", "", "View", () => setAutoRun(!state.autoRun)),
      C("Layout: Split", "", "View", () => setLayout("split")),
      C("Layout: Stacked", "", "View", () => setLayout("stack")),
      C("Preview width: Full", "", "View", () => setPreviewWidth("full")),
      C("Preview width: 768", "", "View", () => setPreviewWidth("768")),
      C("Preview width: 375", "", "View", () => setPreviewWidth("375")),
      C("Bigger editor text", "", "View", () => bumpFont(1)),
      C("Smaller editor text", "", "View", () => bumpFont(-1)),
      C("Keyboard shortcuts", "?", "Help", openShortcuts)
    ];
  }
  function openCommandPalette() {
    if (moreMenu && !moreMenu.hidden) closeMore(); // don't leave the More menu open behind the palette
    cmdLastFocused = document.activeElement;
    cmdInput.value = "";
    renderCommands("");
    cmdModal.hidden = false;
    document.addEventListener("keydown", cmdKeys, true);
    setTimeout(() => cmdInput.focus(), 0);
  }
  function closeCommandPalette() {
    cmdModal.hidden = true;
    cmdInput.removeAttribute("aria-activedescendant");
    document.removeEventListener("keydown", cmdKeys, true);
    // Restore focus, but if the opener is now hidden (e.g. a closed menu item), anchor on More.
    const back = (cmdLastFocused && cmdLastFocused.focus && cmdLastFocused.offsetParent !== null) ? cmdLastFocused : moreBtn;
    if (back && back.focus) back.focus();
  }
  function fuzzy(label, q) {
    label = label.toLowerCase(); q = q.toLowerCase();
    if (!q) return true;
    let i = 0;
    for (const ch of q) { i = label.indexOf(ch, i); if (i < 0) return false; i++; }
    return true;
  }
  function renderCommands(q) {
    cmdItems = commandList().filter((c) => fuzzy(c.label + " " + c.where, q));
    cmdSel = 0;
    if (!cmdItems.length) { cmdList.innerHTML = '<li class="cmd-empty">No matching commands.</li>'; cmdInput.removeAttribute("aria-activedescendant"); return; }
    cmdList.innerHTML = cmdItems.map((c, i) =>
      '<li class="cmd-item" id="cmd-opt-' + i + '" role="option" data-i="' + i + '" aria-selected="' + (i === 0) + '">' +
        '<span class="cmd-label">' + escapeHtml(c.label) + ' <span class="cmd-where">' + escapeHtml(c.where) + '</span></span>' +
        (c.hint ? '<span class="cmd-hint">' + escapeHtml(c.hint) + '</span>' : '') +
      '</li>').join("");
    cmdInput.setAttribute("aria-activedescendant", "cmd-opt-0");
  }
  function moveSel(delta) {
    if (!cmdItems.length) return;
    cmdSel = (cmdSel + delta + cmdItems.length) % cmdItems.length;
    [].slice.call(cmdList.querySelectorAll(".cmd-item")).forEach((el, i) => {
      const on = i === cmdSel; el.setAttribute("aria-selected", String(on));
      if (on && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    });
    cmdInput.setAttribute("aria-activedescendant", "cmd-opt-" + cmdSel);
  }
  function execSel() {
    const c = cmdItems[cmdSel];
    closeCommandPalette();
    if (c && c.run) setTimeout(c.run, 0);
  }
  function cmdKeys(e) {
    if (e.key === "Escape") { e.preventDefault(); closeCommandPalette(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
    else if (e.key === "Enter") { e.preventDefault(); execSel(); }
    else if (e.key === "Tab") { e.preventDefault(); cmdInput.focus(); }
  }
  cmdInput.addEventListener("input", () => renderCommands(cmdInput.value));
  cmdList.addEventListener("click", (e) => {
    const li = e.target.closest(".cmd-item"); if (!li) return;
    cmdSel = parseInt(li.getAttribute("data-i"), 10) || 0; execSel();
  });
  cmdModal.addEventListener("mousedown", (e) => { if (e.target === cmdModal) closeCommandPalette(); });

  /* ---------------- "More" overflow menu ---------------- */
  const moreWrap = $("moreWrap"), moreBtn = $("more"), moreMenu = $("moreMenu");
  function openMore() {
    moreMenu.hidden = false; moreBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", moreOutside, true);
    document.addEventListener("keydown", moreKeys, true);
  }
  function closeMore() {
    moreMenu.hidden = true; moreBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", moreOutside, true);
    document.removeEventListener("keydown", moreKeys, true);
  }
  function moreOutside(e) { if (!moreWrap.contains(e.target)) closeMore(); }
  function moreKeys(e) { if (e.key === "Escape") { e.preventDefault(); closeMore(); moreBtn.focus(); } }
  moreBtn.addEventListener("click", () => { if (moreMenu.hidden) openMore(); else closeMore(); });
  moreMenu.addEventListener("click", (e) => { if (e.target.closest(".menu-item")) closeMore(); });

  /* ---------------- Image embedding (data URL) ---------------- */
  const imgFile = $("imgFile");
  function openImagePicker() { imgFile.click(); }
  function insertImage(file, key) {
    if (!file || !/^image\//.test(file.type)) { toast("That isn't an image file.", "error"); return; }
    const MAX_EMBED = 4 * 1024 * 1024; // ~4 MB ceiling (base64 expands ~33%); blocks editor/quota hangs
    if (file.size > MAX_EMBED) { toast("That image is " + Math.round(file.size / 1024) + " KB — too large to embed (max 4 MB). Link it instead.", "error"); return; }
    if (file.size > 1.5 * 1024 * 1024) toast("That image is " + Math.round(file.size / 1024) + " KB — large images may not save or share.", "info");
    key = key || state.active; // pin the target pane synchronously (the read is async)
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      const snippet = key === "css" ? "url(" + url + ")" : key === "js" ? '"' + url + '"' : '<img src="' + url + '" alt="">';
      ed[key].insert(snippet);
      toast("Image embedded as a data URL.", "ok");
    };
    r.onerror = () => toast("Couldn't read that image.", "error");
    r.readAsDataURL(file);
  }
  imgFile.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) insertImage(f, state.active); imgFile.value = ""; });
  const editorsEl = document.querySelector(".editors");
  if (editorsEl) {
    const allowDrop = (e) => {
      if (e.dataTransfer && [].slice.call(e.dataTransfer.items || []).some((it) => it.kind === "file")) {
        e.preventDefault(); editorsEl.classList.add("drag-over");
      }
    };
    editorsEl.addEventListener("dragover", allowDrop, true);
    editorsEl.addEventListener("dragenter", allowDrop, true);
    editorsEl.addEventListener("dragleave", () => editorsEl.classList.remove("drag-over"), true);
    editorsEl.addEventListener("drop", (e) => {
      editorsEl.classList.remove("drag-over");
      const dt = e.dataTransfer;
      const f = dt && dt.files && dt.files[0];
      const hasFiles = !!(dt && ((dt.files && dt.files.length) || [].slice.call(dt.items || []).some((it) => it.kind === "file")));
      // Swallow ANY file drop so the browser can never navigate the window away (losing unsaved work).
      if (hasFiles) { e.preventDefault(); e.stopPropagation(); }
      if (f && /^image\//.test(f.type)) {
        const pane = e.target.closest && e.target.closest(".pane");
        const key = pane ? (pane.classList.contains("pane-css") ? "css" : pane.classList.contains("pane-js") ? "js" : "html") : state.active;
        if (pane) setActive(key);
        insertImage(f, key);
      } else if (hasFiles) {
        toast("Only image files can be dropped here.", "info");
      }
    }, true);
  }

  /* ---------------- Tidy (lightweight, safe reindent) ---------------- */
  function tidyEditor(key) {
    const e = ed[key];
    if (!e.cm) { toast("Tidy needs the syntax editor (it's offline here).", "info"); return false; }
    e.cm.operation(() => { const n = e.cm.lineCount(); for (let i = 0; i < n; i++) e.cm.indentLine(i, "smart"); });
    return true;
  }
  function tidyActive() { if (tidyEditor(state.active)) toast("Tidied the " + state.active.toUpperCase() + " editor.", "ok"); }

  $("m-image").addEventListener("click", openImagePicker);
  $("m-tidy").addEventListener("click", tidyActive);
  $("m-palette").addEventListener("click", openCommandPalette);

  /* ---------------- Theme ---------------- */
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const sysDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function effectiveTheme() {
    if (state.theme) return state.theme;
    return (sysDark && sysDark.matches) || !sysDark ? "dark" : "light";
  }
  function applyTheme() {
    const t = effectiveTheme();
    document.documentElement.setAttribute("data-theme", t);
    if (themeMeta) themeMeta.setAttribute("content", t === "light" ? "#f3f5f9" : "#13151b");
    const tb = $("themeToggle");
    if (tb) {
      const next = t === "light" ? "dark" : "light";
      tb.setAttribute("aria-label", "Switch to " + next + " theme");
      tb.setAttribute("title", "Switch to " + next + " theme");
      tb.setAttribute("aria-pressed", String(t === "light"));
    }
  }
  function toggleTheme() {
    state.theme = effectiveTheme() === "light" ? "dark" : "light";
    applyTheme();
    persistPrefs();
  }
  $("themeToggle").addEventListener("click", toggleTheme);
  if (sysDark && sysDark.addEventListener) {
    sysDark.addEventListener("change", () => { if (!state.theme) applyTheme(); });
  }

  /* ---------------- Font size ---------------- */
  function applyFont() {
    app.style.setProperty("--editor-fs", state.fontFs + "px");
    setTimeout(() => { ed.html.refresh(); ed.css.refresh(); ed.js.refresh(); }, 0);
  }
  function bumpFont(delta) {
    state.fontFs = clampN(state.fontFs + delta, 11, 18, 13.5);
    applyFont(); persistPrefs();
  }
  $("fontUp").addEventListener("click", () => bumpFont(1));
  $("fontDown").addEventListener("click", () => bumpFont(-1));

  /* ---------------- Preview width presets ---------------- */
  function setPreviewWidth(w) {
    state.previewW = w;
    const px = w === "375" ? "375px" : w === "768" ? "768px" : "100%";
    stage.style.setProperty("--preview-w", px);
    stage.classList.toggle("is-constrained", w !== "full");
    document.querySelectorAll(".w-btn").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.getAttribute("data-w") === w)));
    persistPrefs();
  }

  /* ---------------- Layout + splitter ---------------- */
  function applySplit() {
    app.style.setProperty("--split-x", state.split.x + "%");
    app.style.setProperty("--split-y", state.split.y + "%");
    const vertical = state.layout === "split";
    const val = vertical ? state.split.x : state.split.y;
    splitter.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
    splitter.setAttribute("aria-valuenow", String(Math.round(val)));
    splitter.setAttribute("aria-valuetext", Math.round(val) + "% editors");
  }
  function setSplit(pct) {
    pct = Math.max(18, Math.min(82, pct));
    if (state.layout === "split") state.split.x = pct; else state.split.y = pct;
    applySplit();
  }
  function setLayout(name) {
    state.layout = name;
    app.classList.toggle("layout-split", name === "split");
    app.classList.toggle("layout-stack", name === "stack");
    document.querySelectorAll(".seg-btn").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.getAttribute("data-layout") === name)));
    applySplit();
    persistPrefs();
    setTimeout(() => { ed.html.refresh(); ed.css.refresh(); ed.js.refresh(); }, 0);
  }
  document.querySelectorAll(".seg-btn").forEach((b) =>
    b.addEventListener("click", () => setLayout(b.getAttribute("data-layout"))));

  let dragRAF = null;
  function refreshEditorsSoon() {
    if (dragRAF) return;
    dragRAF = requestAnimationFrame(() => { dragRAF = null; ed.html.refresh(); ed.css.refresh(); ed.js.refresh(); });
  }
  splitter.addEventListener("pointerdown", (e) => {
    if (window.matchMedia("(max-width:880px)").matches) return;
    e.preventDefault();
    const vertical = state.layout === "split";
    try { splitter.setPointerCapture(e.pointerId); } catch (_) {}
    document.body.classList.add("is-resizing");
    document.body.classList.toggle("resize-y", !vertical);
    function move(ev) {
      // Re-read the rect each move so a mid-drag resize/scroll can't desync the split.
      const rect = document.querySelector(".workspace").getBoundingClientRect();
      const pct = vertical ? (ev.clientX - rect.left) / rect.width * 100 : (ev.clientY - rect.top) / rect.height * 100;
      setSplit(pct); refreshEditorsSoon();
    }
    function up(ev) {
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
      splitter.removeEventListener("pointercancel", up);
      try { splitter.releasePointerCapture(ev.pointerId); } catch (_) {}
      document.body.classList.remove("is-resizing", "resize-y");
      ed.html.refresh(); ed.css.refresh(); ed.js.refresh();
      persistPrefs();
    }
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
    splitter.addEventListener("pointercancel", up);
  });
  splitter.addEventListener("dblclick", () => {
    if (state.layout === "split") state.split.x = 50; else state.split.y = 46;
    applySplit(); refreshEditorsSoon(); persistPrefs();
  });
  splitter.addEventListener("keydown", (e) => {
    const vertical = state.layout === "split";
    const cur = vertical ? state.split.x : state.split.y;
    const step = e.shiftKey ? 8 : 2;
    const dec = vertical ? "ArrowLeft" : "ArrowUp";
    const inc = vertical ? "ArrowRight" : "ArrowDown";
    if (e.key === dec) { e.preventDefault(); setSplit(cur - step); }
    else if (e.key === inc) { e.preventDefault(); setSplit(cur + step); }
    else if (e.key === "Home") { e.preventDefault(); setSplit(18); }
    else if (e.key === "End") { e.preventDefault(); setSplit(82); }
    else return;
    refreshEditorsSoon(); persistPrefs();
  });

  /* ---------------- Auto-run switch ---------------- */
  function setAutoRun(on) {
    state.autoRun = on;
    if (!on) clearTimeout(debounceTimer); // cancel any run already queued by the last edit
    autorunEl.checked = on;
    liveDot.classList.toggle("is-on", on);
    liveText.textContent = on ? "Live" : "Manual";
    stLive.classList.toggle("is-off", !on);
    stState.textContent = on ? "Live" : "Manual";
    persistPrefs();
    if (on) run();
  }
  autorunEl.addEventListener("change", () => setAutoRun(autorunEl.checked));

  /* ---------------- Buttons + global shortcuts ---------------- */
  $("run").addEventListener("click", run);
  if (popout) popout.addEventListener("click", openFullPage);
  $("save").addEventListener("click", doSave);
  $("library").addEventListener("click", openLibrary);
  $("export").addEventListener("click", doExport);
  $("import").addEventListener("click", () => fileInput.click());
  $("reset").addEventListener("click", doReset);
  $("clearCon").addEventListener("click", () => clearConsole(false));
  document.querySelectorAll(".w-btn").forEach((b) =>
    b.addEventListener("click", () => setPreviewWidth(b.getAttribute("data-w"))));
  document.querySelectorAll(".cf-btn").forEach((b) =>
    b.addEventListener("click", () => setConsoleFilter(b.getAttribute("data-filter"))));

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter") { e.preventDefault(); run(); }
    else if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); doSave(); }
    else if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); clearConsole(false); }
    else if (mod && (e.key === "o" || e.key === "O")) { e.preventDefault(); openLibrary(); }
    else if (mod && (e.key === "p" || e.key === "P")) { e.preventDefault(); if (cmdModal.hidden) openCommandPalette(); }
    else if (!mod && e.key === "?" && !isTyping(e.target)) { e.preventDefault(); openShortcuts(); }
  });
  function isTyping(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable || (el.closest && el.closest(".CodeMirror"));
  }

  /* ---------------- Resize refresh ---------------- */
  let rsz;
  window.addEventListener("resize", () => {
    clearTimeout(rsz);
    rsz = setTimeout(() => { ed.html.refresh(); ed.css.refresh(); ed.js.refresh(); }, 120);
  });

  /* ---------------- Preferences persistence ---------------- */
  function persistPrefs() {
    store.savePrefs({
      autoRun: state.autoRun,
      layout: state.layout,
      active: state.active,
      splitX: state.split.x,
      splitY: state.split.y,
      fontFs: state.fontFs,
      previewW: state.previewW,
      conFilter: state.conFilter,
      theme: state.theme
    });
  }

  /* ---------------- Install (PWA) ---------------- */
  let deferredInstall = null;
  const installBtn = $("install");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (installBtn) installBtn.hidden = false;
  });
  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (_) {}
      deferredInstall = null;
      installBtn.hidden = true;
    });
  }
  window.addEventListener("appinstalled", () => { if (installBtn) installBtn.hidden = true; });

  /* ---------------- Boot ---------------- */
  applyTheme();
  applyFont();
  setPreviewWidth(state.previewW);
  setConsoleFilter(state.conFilter);

  // Seed sample pens into the library the very first time.
  if (!store.wasSeeded() && state.pens.length === 0) {
    state.pens = SAMPLE_PENS.map((p, i) => ({
      title: p.title, html: p.html, css: p.css, js: p.js,
      id: "seed" + i, savedAt: Date.now() - (SAMPLE_PENS.length - i) * 60000
    }));
    persistPens();
    store.markSeeded();
  }

  // Restore the working draft if present, else load the starter.
  const draft = store.loadDraft();
  const initial = (draft && (draft.html != null || draft.css != null || draft.js != null)) ? draft : STARTER;
  ed.html.set(initial.html || "");
  ed.css.set(initial.css || "");
  ed.js.set(initial.js || "");
  state.title = initial.title || "Untitled pen";

  updateAllMeta();
  setActive(state.active);
  setLayout(state.layout);
  showEmptyConsole();
  setAutoRun(state.autoRun); // performs first run if live
  if (!state.autoRun) run(); // ensure preview renders even in manual mode on load

  setTimeout(() => { ed.html.refresh(); ed.css.refresh(); ed.js.refresh(); }, 60);

  if (!window.CodeMirror) toast("Editor highlighting is offline — using plain text editors.", "info");
  if (!store.available) toast("This browser isn't saving data — your work won't persist between visits.", "info");

  /* ---------------- Service worker (offline / installable) ---------------- */
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
})();

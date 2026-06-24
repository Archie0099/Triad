#!/usr/bin/env node
/* Triad verification — run `node test/verify.js` from anywhere.
 * Reproduces every check used to validate the project, with no browser:
 *   1. JS syntax (node --check) for all scripts
 *   2. No ES import/export in app code (must stay classic so file:// works)
 *   3. The injected console-hook string parses as valid JS
 *   4. Every $("id") / key selector in app.js exists in index.html; no dup IDs
 *   5. CSS braces balanced
 *   6. Every file referenced by index.html and by sw.js's ASSETS exists
 *   7. Headless boot: run starter+storage+app with stubbed browser APIs
 * Exits 0 if everything passes, 1 otherwise.
 */
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.dirname(__dirname);             // project root (this file is in test/)
const p = (...a) => path.join(ROOT, ...a);
const read = (...a) => fs.readFileSync(p(...a), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const results = [];
let deferred = null;
function check(name, fn) {
  try { fn(); results.push([name, true, ""]); }
  catch (e) { results.push([name, false, (e && e.message) || String(e)]); }
}

// Extract a named function's full source via string/comment-aware brace matching.
function extractFunction(src, sig) {
  const start = src.indexOf(sig);
  if (start < 0) throw new Error("could not find " + sig);
  let i = src.indexOf("{", start);
  if (i < 0) throw new Error("no function body for " + sig);
  let depth = 0, str = null, line = false, block = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === "\n") line = false; continue; }
    if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; }
    if (str) { if (c === "\\") { i++; continue; } if (c === str) str = null; continue; }
    if (c === "/" && n === "/") { line = true; i++; continue; }
    if (c === "/" && n === "*") { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { str = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

/* 1. syntax */
for (const f of ["app.js", "src/starter.js", "src/storage.js", "sw.js"]) {
  check("syntax: " + f, () => {
    try { execFileSync(process.execPath, ["--check", p(f)], { stdio: ["ignore", "ignore", "pipe"] }); }
    catch (e) { throw new Error((e.stderr || "").toString().trim() || "syntax error"); }
  });
}

/* 2. no import/export in app code */
check("app code is classic (no import/export)", () => {
  for (const f of ["app.js", "src/starter.js", "src/storage.js"]) {
    if (/^\s*(import|export)\s/m.test(read(f))) throw new Error(f + " contains import/export");
  }
});

/* 3. injected HOOK is authored as a real function and parses standalone */
check("injected console HOOK is a function that parses as JS", () => {
  const src = read("app.js");
  const fn = extractFunction(src, "function hookBody");
  // It is injected as "(" + hookBody.toString() + ")(rid, jsLine);" — confirm that parses.
  new vm.Script("(" + fn + ")(0,0);"); // throws on syntax error
  // Guard: the hook is injected inside <script>, so it must contain no raw closing tag.
  if (/<\/script/i.test(fn)) throw new Error("HOOK contains a raw closing script tag");
});

/* 4. wiring + duplicate ids */
check("every $(\"id\") and key selector exists in index.html; no duplicate ids", () => {
  const app = read("app.js");
  const html = read("index.html");
  const ids = new Set();
  let m; const re = /\$\("([A-Za-z0-9_-]+)"\)/g;
  while ((m = re.exec(app))) ids.add(m[1]);
  // ids built by concatenation that we know exist:
  ["meta-html", "meta-css", "meta-js"].forEach((i) => ids.add(i));
  const missing = [...ids].filter((id) => !html.includes('id="' + id + '"'));
  if (missing.length) throw new Error("missing ids in index.html: " + missing.join(", "));
  for (const cls of ["seg-btn", "w-btn", "cf-btn"]) {
    if (!html.includes('class="' + cls + '"')) throw new Error("missing class in index.html: " + cls);
  }
  const all = (html.match(/id="[A-Za-z0-9_-]+"/g) || []).sort();
  const dups = all.filter((v, i) => i && v === all[i - 1]);
  if (dups.length) throw new Error("duplicate ids: " + [...new Set(dups)].join(", "));
});

/* 5. css braces balanced */
check("CSS braces balanced", () => {
  const css = read("styles.css");
  const o = (css.match(/{/g) || []).length, c = (css.match(/}/g) || []).length;
  if (o !== c) throw new Error("{ " + o + " vs } " + c);
});

/* 6. referenced files exist */
check("files referenced by index.html exist", () => {
  const html = read("index.html");
  const refs = new Set((html.match(/\.\/(?:vendor|src|app|styles|icon|manifest)[A-Za-z0-9_./-]*/g) || []));
  const missing = [...refs].filter((r) => !exists(r.replace(/^\.\//, "")));
  if (missing.length) throw new Error("missing: " + missing.join(", "));
});
check("files precached by sw.js exist", () => {
  const sw = read("sw.js");
  const refs = new Set((sw.match(/"\.\/[^"]+"/g) || []).map((s) => s.slice(1, -1)));
  const missing = [...refs].filter((r) => !exists(r.replace(/^\.\//, "")));
  if (missing.length) throw new Error("missing: " + missing.join(", "));
});

/* 7. headless boot */
check("headless boot (starter + storage + app)", () => {
  const _ls = new Map();
  const localStorage = {
    getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
    setItem: (k, v) => { _ls.set(k, String(v)); },
    removeItem: (k) => { _ls.delete(k); }, clear: () => _ls.clear()
  };
  const NUM = new Set(["scrollHeight", "scrollTop", "clientHeight", "offsetWidth", "offsetHeight", "selectionStart", "length", "clientWidth"]);
  function makeEl(tag) {
    const base = {
      tagName: (tag || "div").toUpperCase(),
      style: new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === "setProperty" || k === "removeProperty" || k === "getPropertyValue" ? () => "" : undefined)), set: (t, k, v) => { t[k] = v; return true; } }),
      classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
      value: "", checked: false, hidden: false, textContent: "", innerHTML: "", files: [], isContentEditable: false, parentNode: null, offsetParent: null
    };
    const el = new Proxy(base, {
      get(t, k) { if (k in t) return t[k]; if (k === "contentWindow") return sandbox.window; if (NUM.has(k)) return 0; return function () { return el; }; },
      set(t, k, v) { t[k] = v; return true; }
    });
    return el;
  }
  const _byId = new Map();
  const document = {
    getElementById(id) { if (!_byId.has(id)) _byId.set(id, makeEl("div")); return _byId.get(id); },
    createElement(t) { return makeEl(t); }, querySelector() { return makeEl("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    get documentElement() { return makeEl("html"); }, get body() { return makeEl("body"); }, get activeElement() { return makeEl("div"); }
  };
  function CMStub() { return { on() {}, getValue() { return ""; }, setValue() {}, focus() {}, refresh() {}, lineCount() { return 1; }, getCursor() { return { line: 0, ch: 0 }; } }; }
  var sandbox = {
    console, JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, isFinite, parseInt, parseFloat,
    setTimeout, clearTimeout, setInterval, clearInterval, document, localStorage,
    navigator: {}, location: { protocol: "file:" }, CodeMirror: CMStub, requestAnimationFrame: () => 0,
    URL: { createObjectURL: () => "blob:stub", revokeObjectURL() {} }, Blob: function () {},
    DOMParser: function () { this.parseFromString = () => ({ getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: null, title: "" }); }
  };
  sandbox.window = sandbox;
  sandbox.window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  sandbox.window.addEventListener = () => {}; sandbox.window.removeEventListener = () => {}; sandbox.window.open = () => ({});
  vm.createContext(sandbox); sandbox.window = sandbox;
  process.on("uncaughtException", (e) => { deferred = deferred || e; });
  const run = (f) => vm.runInContext(read(f), sandbox, { filename: f });
  run("src/starter.js"); run("src/storage.js");
  ["STARTER", "SAMPLE_PENS", "store"].forEach((g) => { if (typeof sandbox[g] === "undefined") throw new Error("global not exposed: " + g); });
  run("app.js");
  if (![..._ls.keys()].some((k) => k.startsWith("triad.v2."))) throw new Error("no data written to storage on boot");
});

/* 8. behavioral tests (logic-layer fixes; runs test/behavior.js) */
check("behavioral tests (test/behavior.js)", () => {
  if (!fs.existsSync(p("test/behavior.js"))) return; // optional
  try { execFileSync(process.execPath, [p("test/behavior.js")], { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (e) {
    const out = ((e.stdout || "") + (e.stderr || "")).toString().trim().split("\n").filter((l) => /FAIL|FAILED/.test(l));
    throw new Error(out.join(" | ") || "behavior tests failed — run: node test/behavior.js");
  }
});

/* summary (after a short tick so deferred timer errors can surface) */
setTimeout(() => {
  if (deferred) results.push(["headless boot: deferred timer callbacks", false, deferred.message || String(deferred)]);
  else results.push(["headless boot: deferred timer callbacks", true, ""]);

  const pad = Math.max(...results.map((r) => r[0].length));
  let ok = true;
  for (const [name, passed, msg] of results) {
    if (!passed) ok = false;
    console.log((passed ? "PASS" : "FAIL") + "  " + name.padEnd(pad) + (msg ? "   -> " + msg : ""));
  }
  console.log("\n" + (ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"));
  process.exit(ok ? 0 : 1);
}, 150);

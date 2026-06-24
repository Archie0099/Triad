#!/usr/bin/env node
/* Triad behavioral tests - node, no dependencies.  Run: node test/behavior.js
 *
 * Exercises the real logic by extracting the actual functions out of app.js
 * (the console capture hook, escTag, slug, the CSS allowlist, the pen-id helper)
 * and the storage module, then asserting their behaviour directly, so these
 * tests run the real code rather than a copy.
 *
 * Complements test/verify.js (syntax, wiring, a headless boot). Behaviour that
 * only happens through real DOM events (modal focus traps, drag and drop, the
 * splitter) is not covered here. verify.js runs this file as its check #8, so
 * `node test/verify.js` covers everything.
 */
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);
const appSrc = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  pass  " + name); }
  else { fail++; console.error("  FAIL  " + name); }
}

// Extract a named function's full source via string/comment-aware brace matching.
function extractFunction(src, sig) {
  const start = src.indexOf(sig);
  if (start < 0) throw new Error("could not find " + sig);
  let i = src.indexOf("{", start), depth = 0, str = null, line = false, block = false;
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
// Evaluate an extracted function expression (optionally with a preamble in scope).
function evalFn(sig, preamble) {
  return vm.runInNewContext((preamble || "") + "(" + extractFunction(appSrc, sig) + ")", {});
}

/* ---------------- pure helpers ---------------- */
console.log("pen id uniqueness:");
const uid = evalFn("function uid(");
ok("two pens in the same millisecond get different ids", uid(1000, 0) !== uid(1000, 1));
ok("uid is deterministic for the same inputs", uid(1000, 0) === uid(1000, 0));

console.log("escTag closing-tag neutralization:");
const escTag = evalFn("function escTag(");
ok("</script> is neutralized", escTag("a</script>b", "script") === "a<\\/script>b");
ok("</STYLE> is neutralized case-insensitively", escTag("x</STYLE>", "style") === "x<\\/STYLE>");
ok("unrelated text is untouched", escTag("p < q && q > r", "script") === "p < q && q > r");

console.log("slug (export filename):");
const slug = evalFn("function slug(");
ok("normalizes to kebab", slug("My Pen! 2") === "my-pen-2");
ok("empty falls back", slug("   ") === "triad-pen");

console.log("CSS allowlist for %c styling:");
const okcssMatch = appSrc.match(/const OKCSS_PARENT = (\/[^\n]*\/i);/);
const sanitizeCssParent = evalFn("function sanitizeCssParent(", "var OKCSS_PARENT = " + okcssMatch[1] + ";\n");
ok("keeps color, drops position and url()", sanitizeCssParent("color:red; position:fixed; background:url(x)") === "color:red");
ok("drops everything dangerous", sanitizeCssParent("position:fixed;inset:0;background:url(//evil)") === "");

/* ---------------- console capture hook ---------------- */
// Run the real hookBody in a sandbox; collect what it posts to the parent.
function runHook(rid, jsLine) {
  const posted = [];
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, table() {}, debug() {} },
    JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, parseInt, parseFloat, isNaN, isFinite,
    parent: { postMessage: (p) => posted.push(JSON.parse(JSON.stringify(p))) },
  };
  sandbox.window = { addEventListener: (t, h) => { sandbox["__on_" + t] = h; } };
  vm.createContext(sandbox);
  vm.runInContext("(" + extractFunction(appSrc, "function hookBody(") + ")(" + rid + "," + jsLine + ");", sandbox);
  return { posted, sandbox };
}

console.log("hook: a Symbol argument with %d/%i/%f does not drop the line:");
{
  const { posted, sandbox } = runHook(9, 5);
  vm.runInContext("console.log('%d', Symbol('s'))", sandbox);
  vm.runInContext("console.log('%i', Symbol('s'), 'tail')", sandbox);
  vm.runInContext("console.log('%f', Symbol('f'))", sandbox);
  vm.runInContext("console.log('%d', 5)", sandbox);
  ok("all four logs produced a message (none silently dropped)", posted.length === 4);
  ok("plain %d still formats", posted[3].format.map((s) => s.text).join("") === "5");
}

console.log("hook: runtime error line mapping:");
{
  const { posted, sandbox } = runHook(9, 5); // user JS starts after doc line 5
  sandbox.__on_error({ message: "boom", lineno: 9, colno: 2 });   // 9 > 5  -> JS line 4
  sandbox.__on_error({ message: "from html", lineno: 3, colno: 1 }); // 3 <= 5 -> no jump
  const errs = posted.filter((p) => p.kind === "error");
  ok("error inside the JS region gets a jump to the right line", errs[0].src && errs[0].src.line === 4);
  ok("error before the JS region gets NO (misleading) jump", !errs[1].src);
  ok("every error message is stamped with the run id", errs.every((p) => p.runId === 9));
}

console.log("hook: console.table column cap:");
{
  const { posted, sandbox } = runHook(1, 0);
  vm.runInContext("var rows=[]; for (var i=0;i<200;i++){ var o={}; o['k'+i]=i; rows.push(o); } console.table(rows);", sandbox);
  const t = posted.find((p) => p.table);
  ok("columns are capped (<= 61) instead of unbounded", t && t.table.cols.length <= 61);
}

console.log("hook: %o object preview and an unmatched specifier:");
{
  const { posted, sandbox } = runHook(1, 0);
  vm.runInContext("console.log('%o', {a:1, b:2})", sandbox);
  vm.runInContext("console.log('plain %d gap')", sandbox);
  ok("%o shows the object key preview, not {…}", posted[0].format.map((s) => s.text).join("").indexOf("{a, b}") >= 0);
  ok("an unmatched %d is left literal", posted[1].format.map((s) => s.text).join("").indexOf("%d") >= 0);
}

console.log("hook: in-iframe %c CSS allowlist:");
{
  const { posted, sandbox } = runHook(1, 0);
  vm.runInContext("console.log('%cx', 'color:red; position:fixed')", sandbox);
  const f = posted[0].format;
  ok("%c keeps color but strips position", f.some((s) => s.style === "color:red") && JSON.stringify(f).indexOf("position") < 0);
}

/* ---------------- storage quota path ---------------- */
console.log("storage: savePens reports failure on quota:");
{
  const map = new Map();
  const localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { if (k.indexOf("pens") >= 0) throw new Error("QuotaExceeded"); map.set(k, String(v)); },
    removeItem: (k) => map.delete(k),
  };
  const ctx = { localStorage, JSON };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "storage.js"), "utf8"), ctx);
  ok("storage is reported available (the probe key wrote fine)", ctx.store.available === true);
  ok("savePens returns false when the write throws (quota)", ctx.store.savePens([{ id: "x" }]) === false);
  ok("savePrefs still returns true when there is room", ctx.store.savePrefs({ a: 1 }) === true);
}

/* ---------------- summary ---------------- */
console.log("");
if (fail) { console.error("BEHAVIOR TESTS: " + fail + " FAILED, " + pass + " passed"); process.exit(1); }
console.log("BEHAVIOR TESTS: all " + pass + " passed");
process.exit(0);

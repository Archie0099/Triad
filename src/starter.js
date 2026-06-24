// The template loaded on a fresh start, plus a couple of sample pens
// that seed the library the very first time Triad is opened.

var STARTER = {
  title: "Untitled pen",
  html: `<main class="card">
  <span class="badge">Triad</span>
  <h1>Hello, maker.</h1>
  <p>Edit the HTML, CSS, and JS panes — the preview updates as you type.</p>
  <button id="tick" type="button">Count up</button>
  <p class="count">Clicks: <span id="n">0</span></p>
</main>`,
  css: `:root{ --html:#ec6a38; --css:#4f9cf5; --js:#efc53f; }
*{ box-sizing:border-box; }
body{
  margin:0; min-height:100vh; display:grid; place-items:center;
  font-family:ui-sans-serif, system-ui, sans-serif;
  color:#e9ebf1;
  background:radial-gradient(130% 130% at 50% 0%, #1e2330, #0f1117);
}
.card{
  text-align:center; padding:40px 36px; border-radius:16px;
  background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.08);
  box-shadow:0 30px 80px rgba(0,0,0,.4); max-width:420px;
}
.badge{
  display:inline-block; font-size:11px; letter-spacing:.22em; text-transform:uppercase;
  padding:5px 12px; border-radius:20px; color:#0f1117; font-weight:700;
  background:linear-gradient(90deg, var(--html), var(--css), var(--js));
}
h1{ margin:16px 0 6px; font-size:28px; }
p{ color:#aab2c0; line-height:1.5; }
button{
  margin-top:14px; font:inherit; cursor:pointer; color:#e9ebf1;
  background:#21252e; border:1px solid #343a46; border-radius:9px; padding:10px 18px;
  transition:border-color .15s, transform .1s;
}
button:hover{ border-color:var(--css); }
button:active{ transform:translateY(1px); }
.count{ font-variant-numeric:tabular-nums; }`,
  js: `console.log("Preview ready — logs and errors show in the Console below.");

const out = document.getElementById("n");
let clicks = 0;

document.getElementById("tick").addEventListener("click", () => {
  clicks++;
  out.textContent = clicks;
  console.log("Clicked", clicks, "time" + (clicks === 1 ? "" : "s"));
  if (clicks === 5) console.warn("Five already! Try editing the CSS.");
});`
};

// Seed pens (shown in the Library on first run; users can delete them).
var SAMPLE_PENS = [
  {
    title: "Spectrum bars",
    html: `<div class="bars">
  <span style="--c:var(--html)"></span>
  <span style="--c:var(--css)"></span>
  <span style="--c:var(--js)"></span>
  <span style="--c:var(--html)"></span>
  <span style="--c:var(--css)"></span>
</div>`,
    css: `:root{ --html:#ec6a38; --css:#4f9cf5; --js:#efc53f; }
body{ margin:0; height:100vh; display:grid; place-items:center; background:#0f1117; }
.bars{ display:flex; gap:10px; align-items:flex-end; height:160px; }
.bars span{
  width:26px; border-radius:8px; background:var(--c);
  animation:pulse 1.1s ease-in-out infinite;
}
.bars span:nth-child(2){ animation-delay:.12s }
.bars span:nth-child(3){ animation-delay:.24s }
.bars span:nth-child(4){ animation-delay:.36s }
.bars span:nth-child(5){ animation-delay:.48s }
@keyframes pulse{ 0%,100%{ height:48px } 50%{ height:150px } }
@media (prefers-reduced-motion:reduce){ .bars span{ animation:none; height:120px } }`,
    js: `console.log("Five bars, three materials.");`
  },
  {
    title: "Tiny clock",
    html: `<p id="clock">--:--:--</p>`,
    css: `body{ margin:0; height:100vh; display:grid; place-items:center;
  background:#0f1117; color:#e9ebf1;
  font-family:ui-monospace, monospace; }
#clock{ font-size:14vmin; letter-spacing:.06em;
  background:linear-gradient(90deg,#ec6a38,#4f9cf5,#efc53f);
  -webkit-background-clip:text; background-clip:text; color:transparent; }`,
    js: `const el = document.getElementById("clock");
function tick(){
  el.textContent = new Date().toLocaleTimeString();
}
tick();
setInterval(tick, 1000);
console.log("Clock started.");`
  }
];

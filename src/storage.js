// Persistence for Triad. All data stays in this browser (localStorage).
// Every call is guarded so the app still runs if storage is unavailable
// (private mode, quota, file:// quirks) — it simply won't persist.

const NS = "triad.v2.";
const K = {
  prefs: NS + "prefs",
  pens:  NS + "pens",
  draft: NS + "draft",
  seeded: NS + "seeded"
};

let available = true;
try {
  const t = NS + "__test";
  localStorage.setItem(t, "1");
  localStorage.removeItem(t);
} catch (_) {
  available = false;
}

function readJSON(key, fallback) {
  if (!available) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}
function writeJSON(key, value) {
  if (!available) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}
function remove(key) {
  if (!available) return;
  try { localStorage.removeItem(key); } catch (_) {}
}

var store = {
  available,

  loadPrefs() { return readJSON(K.prefs, {}); },
  savePrefs(obj) { return writeJSON(K.prefs, obj || {}); },

  loadPens() {
    const v = readJSON(K.pens, []);
    return Array.isArray(v) ? v : [];
  },
  savePens(arr) { return writeJSON(K.pens, Array.isArray(arr) ? arr : []); },

  loadDraft() { return readJSON(K.draft, null); },
  saveDraft(obj) { return writeJSON(K.draft, obj); },
  clearDraft() { remove(K.draft); },

  // One-time seeding flag for sample pens.
  wasSeeded() { return readJSON(K.seeded, false) === true; },
  markSeeded() { return writeJSON(K.seeded, true); }
};

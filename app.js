"use strict";

/* ============================================================================
   TREASURE HUNT SOLVER. The whole app; loaded as a classic script (not a module)
   so index.html still runs straight off the filesystem via file://.
   Depends on i18n.js, which must load first (it defines LANGS and I18N).
   See docs/ARCHITECTURE.md for the full design write-up.

   Layout of this script, top to bottom:
     1. DATA          TREASURES (sizes) and STAGES (presets).
     2. STATE         `state` = grid size + the stage's pieces + per-cell status.
     3. I18N          t() + language detect/select/persist (strings live in i18n.js).
     4. PIECE HELPERS  normalise/merge pieces by dimension; count remaining.
     5. UI: CONTROLS   presets dropdown, piece editor, quick-add.
     6. SOLVER         per-tile probability that a tile covers a treasure.
                       Exact enumeration when small; Monte-Carlo when not.
     7. ESTIMATOR      simulate greedy play to estimate picks needed to finish.
     8. RENDER         paint the heatmap + mark the best tile(s) to dig.
     9. INTERACTION    click a tile -> popover -> mark empty / place a treasure.
    10. WIRING + BOOT  event handlers, detect language, then load Stage 1.

   Core model: every cell is hidden / empty / item. A "found" treasure is fully
   located (you learn its footprint from one dig), so the solver only ever has
   to place the *remaining* pieces into the still-hidden cells with no overlap.
   ============================================================================ */

/* ---------- Known treasure sizes (for quick-add). Solver merges by dimension. ---------- */
const TREASURES = [
  ["Zobo Cola", 1, 3], ["Zobo Zine", 2, 2], ["Syringe", 1, 2],
  ["Trumpet", 1, 3], ["Outdated Console", 1, 2], ["Radio", 2, 3],
  ["Pirated Magazine", 2, 2], ["TV", 2, 3], ["Cyberlimb", 1, 4],
  ["Spaceship", 3, 3], ["Statue", 2, 4],
];

/* ---------- Stage presets (from the in-game stage table). ----------
   Grid size and pickaxes/tile only: every treasure list is empty on purpose.
   The game patch ("Added variety to levels: a set of treasures will be selected
   at random from several sets of similar difficulty for the current level") means
   a stage no longer has *the* treasure list, so the old one-per-stage presets are
   deprecated. Grid size and pickaxes/tile did not change, so those still autofill.

   This is a data change, not a code change: an empty `pieces` already meant "stage
   known, treasures not published" everywhere (empty board, "add them manually" in
   the stage info, the no-treasures notice in the status line).

   When the sets have been collected, the shape this wants is a list of sets per
   stage plus a picker for which one you got. See docs/ARCHITECTURE.md. */
const STAGES = [
  { n: 1,  grid: 5, pick: 15,  pieces: [] },
  { n: 2,  grid: 5, pick: 15,  pieces: [] },
  { n: 3,  grid: 5, pick: 15,  pieces: [] },
  { n: 4,  grid: 6, pick: 20,  pieces: [] },
  { n: 5,  grid: 6, pick: 20,  pieces: [] },
  { n: 6,  grid: 6, pick: 20,  pieces: [] },
  { n: 7,  grid: 7, pick: 25,  pieces: [] },
  { n: 8,  grid: 7, pick: 25,  pieces: [] },
  { n: 9,  grid: 7, pick: 25,  pieces: [] },
  { n: 10, grid: 7, pick: 35,  pieces: [] },
  { n: 11, grid: 7, pick: 35,  pieces: [] },
  { n: 12, grid: 7, pick: 35,  pieces: [] },
  { n: 13, grid: 7, pick: 70,  pieces: [] },
  { n: 14, grid: 7, pick: 70,  pieces: [] },
  { n: 15, grid: 7, pick: 70,  pieces: [] },
  { n: 16, grid: 7, pick: 100, pieces: [] },
  { n: 17, grid: 7, pick: 100, pieces: [] },
  { n: 18, grid: 7, pick: 100, pieces: [] },
  { n: 19, grid: 7, pick: 150, pieces: [] },
  { n: 20, grid: 7, pick: 150, pieces: [] },
  { n: 21, grid: 7, pick: 150, pieces: [] },
  { n: 22, grid: 7, pick: 200, pieces: [] },
  { n: 23, grid: 7, pick: 200, pieces: [] },
  { n: 24, grid: 7, pick: 200, pieces: [] },
];
// Stages loadable by the test suite but hidden from the dropdown. Negative n keeps
// them out of sight (loadStage() reads ALL_STAGES, populateStages() reads STAGES).
//
// -101..-124 are the pre-patch treasure lists for stages 1..24, i.e. -(100 + n).
// They are not dead data: each is one real set that the stage can still draw, and
// the tests need boards that actually have treasures to solve. They are kept out of
// the dropdown because there is no way to tell a player which set they got.
// pieces: [name, count] using TREASURES sizes; same-size pieces merge in the solver.
// Stage 12's 2×3 and 1×2 are labelled Radio / Outdated Console, but could be
// TV / Syringe (same sizes). Labels only, no effect on the probabilities.
const HIDDEN_STAGES = [
  { n: -1, grid: 5, pick: 15, pieces: [] },                  // no treasures set up. Tests only
  { n: -2, grid: 5, pick: 15, pieces: [["Syringe", 1]] },    // one 1×2, for the all-dug-out path. Tests only
  { n: -101, grid: 5, pick: 15,  pieces: [["Zobo Cola", 3]] },
  { n: -102, grid: 5, pick: 15,  pieces: [["Zobo Zine", 1], ["Syringe", 3]] },
  { n: -103, grid: 5, pick: 15,  pieces: [["Trumpet", 1], ["Zobo Zine", 1], ["Outdated Console", 2]] },
  { n: -104, grid: 6, pick: 20,  pieces: [["Zobo Cola", 1], ["Outdated Console", 2], ["Radio", 1]] },
  { n: -105, grid: 6, pick: 20,  pieces: [["Pirated Magazine", 2], ["Zobo Zine", 2]] },
  { n: -106, grid: 6, pick: 20,  pieces: [["Zobo Cola", 2], ["Zobo Zine", 1], ["TV", 1]] },
  { n: -107, grid: 7, pick: 25,  pieces: [["Zobo Zine", 1], ["Radio", 1], ["Cyberlimb", 2]] },
  { n: -108, grid: 7, pick: 25,  pieces: [["Outdated Console", 2], ["Cyberlimb", 1], ["Spaceship", 1]] },
  { n: -109, grid: 7, pick: 25,  pieces: [["Syringe", 2], ["Pirated Magazine", 2], ["Statue", 1]] },
  { n: -110, grid: 7, pick: 35,  pieces: [["Outdated Console", 2], ["Cyberlimb", 2], ["Spaceship", 1]] },
  { n: -111, grid: 7, pick: 35,  pieces: [["Zobo Cola", 2], ["Outdated Console", 2], ["Trumpet", 1], ["Statue", 1]] },
  { n: -112, grid: 7, pick: 35,  pieces: [["Cyberlimb", 2], ["Radio", 1], ["Outdated Console", 2], ["Spaceship", 1]] },
  { n: -113, grid: 7, pick: 70,  pieces: [["Outdated Console", 2], ["Statue", 2]] },
  { n: -114, grid: 7, pick: 70,  pieces: [["Radio", 1], ["Cyberlimb", 2], ["Spaceship", 1]] },
  { n: -115, grid: 7, pick: 70,  pieces: [["Zobo Cola", 2], ["Syringe", 2], ["TV", 1], ["Statue", 1]] },
  { n: -116, grid: 7, pick: 100, pieces: [["Outdated Console", 2], ["Pirated Magazine", 2], ["Statue", 1]] },
  { n: -117, grid: 7, pick: 100, pieces: [["Outdated Console", 2], ["Zobo Cola", 2], ["Radio", 1], ["Spaceship", 1]] },
  { n: -118, grid: 7, pick: 100, pieces: [["Outdated Console", 2], ["Cyberlimb", 2], ["TV", 1], ["Spaceship", 1]] },
  { n: -119, grid: 7, pick: 150, pieces: [["Outdated Console", 2], ["Zobo Zine", 2], ["Statue", 1]] },
  { n: -120, grid: 7, pick: 150, pieces: [["Outdated Console", 2], ["Zobo Cola", 2], ["Radio", 1], ["Spaceship", 1]] },
  { n: -121, grid: 7, pick: 150, pieces: [["Outdated Console", 2], ["Cyberlimb", 2], ["Radio", 1], ["Spaceship", 1]] },
  { n: -122, grid: 7, pick: 200, pieces: [["Outdated Console", 2], ["Zobo Zine", 2], ["Statue", 1]] },
  { n: -123, grid: 7, pick: 200, pieces: [["Outdated Console", 2], ["Zobo Cola", 2], ["Radio", 1], ["Spaceship", 1]] },
  { n: -124, grid: 7, pick: 200, pieces: [["Outdated Console", 2], ["Cyberlimb", 2], ["Radio", 1], ["Spaceship", 1]] },
];
const ALL_STAGES = STAGES.concat(HIDDEN_STAGES);   // dropdown shows STAGES; loadStage() accepts either
const sizeOf = name => { const t = TREASURES.find(t => t[0] === name); return [t[1], t[2]]; };

/* ---------- State ---------- */
const state = {
  N: 5,
  pieces: [],          // [{w,h,count}]  (w<=h normalised)  the full stage definition
  cells: [],           // length N*N: {status:'hidden'|'empty'|'item', type:'WxH'|null}
};

const $ = sel => document.querySelector(sel);
const gridEl = $("#grid");
const stageAreaEl = $(".stage-area");
const popEl = $("#pop");

let LANG = "en";

function interpolate(s, params) {
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m)) : s;
}
function pluralForm(obj, params) {
  let cat = "other";
  try { cat = new Intl.PluralRules(LANG).select((params && params._n != null) ? params._n : 0); } catch (_) {}
  return obj[cat] != null ? obj[cat] : (obj.other != null ? obj.other : Object.values(obj)[0]);
}
function t(key, params) {
  let v = I18N[LANG] && I18N[LANG][key];
  if (v == null) v = I18N.en[key];
  if (v == null) return key;
  if (typeof v === "object") {                 // plural entry
    v = pluralForm(v, params);
    if (v == null) { const e = I18N.en[key]; v = (e && typeof e === "object") ? pluralForm(e, params) : e; }
  }
  return interpolate(v, params);
}
const nfmt = n => { try { return n.toLocaleString(LANG); } catch (_) { return String(n); } };

function resolveLang(tag) {
  if (!tag) return null;
  if (I18N[tag]) return tag;
  const low = String(tag).toLowerCase();
  if (low === "zh" || low.startsWith("zh-hans") || low === "zh-cn" || low === "zh-sg" || low === "zh-my") return "zh-Hans";
  if (low.startsWith("zh-hant") || low === "zh-tw" || low === "zh-hk" || low === "zh-mo") return "zh-Hant";
  const base = low.split("-")[0];
  return I18N[base] ? base : null;
}
// Precedence: URL pin -> stored choice -> browser -> English.
//
// The pin is the locale of a prerendered page (/de/, /th/, ...), stamped into the markup by
// build-locales.js as <html data-pinned-lang>. It is read from the DOM rather than parsed out of
// location.pathname, which would have to cope with file:// and with the /ClashOfCritterTreasureHuntSolver/
// project sub-path. It wins outright: the page's own HTML is already in that language, so letting a
// stored preference override it would repaint a Thai URL into Italian, which is the one genuinely
// surprising outcome here. Landing on a locale URL is an explicit choice, exactly like using the
// picker, and boot() persists it for that reason.
//
// The root has no pin. It is the only page that auto-detects, which is what keeps a German visitor
// on German without hunting for the picker, and it is the page declared as hreflang="x-default".
function detectLang() {
  const pinned = document.documentElement.dataset.pinnedLang;
  if (pinned && I18N[pinned]) return pinned;
  try { const s = localStorage.getItem("th.lang"); if (s && I18N[s]) return s; } catch (_) {}
  let cands = [];
  try { cands = (navigator.languages && navigator.languages.length) ? navigator.languages : (navigator.language ? [navigator.language] : []); } catch (_) {}
  for (const c of cands) { const r = resolveLang(c); if (r) return r; }
  return "en";
}
function applyStaticI18n() {
  document.documentElement.lang = LANG;
  document.title = t("app.pageTitle");
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll("[data-i18n-title]").forEach(el => { el.title = t(el.dataset.i18nTitle); });
}
// The picker is a menu of real links to the per-locale URLs (the anchors live in the HTML, one per
// LANGS entry, so crawlers see them without running any of this). Choosing a language is therefore a
// navigation, not an in-place text swap: nothing can leave the URL and the content disagreeing.
// All this has to do is mark the current entry, keep the links usable over file://, and remember the
// click. On a prerendered page the generator has already done the marking, so this re-does it
// identically and nothing moves.
function initLangPicker() {
  const menu = $("#langMenu");
  if (!menu) return;
  const label = $("#langCurrent");
  // file:// has no directory index, so "de/" would open a folder listing instead of the page.
  const bare = location.protocol === "file:";
  menu.querySelectorAll("a[data-lang]").forEach(a => {
    const code = a.dataset.lang;
    if (bare) a.setAttribute("href", a.getAttribute("href").replace(/\/$/, "/index.html"));
    if (code === LANG) {
      a.setAttribute("aria-current", "true");
      if (label) label.textContent = a.textContent;
    }
    // Persist before the navigation lands. This is what makes the English link work from a locale
    // page: it points at the auto-detecting root, which would otherwise just re-detect German.
    a.addEventListener("click", () => { try { localStorage.setItem("th.lang", code); } catch (_) {} });
  });
}
function renderStageInfo() {
  const el = $("#stageInfo");
  if (!el) return;
  const pick = $("#pickPerTile").value;
  const list = state.pieces.length
    ? state.pieces.map(p => `${p.w}×${p.h}×${p.count}`).join(", ")
    : t("setup.treasuresVary");
  el.innerHTML = t("setup.pickInfo", { pick, _n: +pick }) + "<br>" + list;
}
// Dropdown label. There used to be a "(no data)" marker for stages whose treasures
// weren't published; now that no stage ships a treasure list it would be on all 24,
// so the stage info line and the no-treasures notice carry that on their own.
function stageLabel(s) { return t("stage.option", { n: s.n, grid: s.grid }); }
// (There is no in-place language switch. LANG is resolved once, at boot, before anything renders:
// the picker navigates, and every dynamic string is built through t() afterwards.)

/* ---------- Piece helpers ---------- */
const key = (w, h) => { const a = Math.min(w, h), b = Math.max(w, h); return a + "x" + b; };

function pieceByKey(k) { return state.pieces.find(p => key(p.w, p.h) === k); }

function addPiece(w, h, c) {
  w = +w; h = +h; c = +c;
  if (!(w >= 1 && h >= 1 && c >= 1)) return;
  const k = key(w, h);
  const existing = pieceByKey(k);
  if (existing) existing.count += c;
  else state.pieces.push({ w: Math.min(w, h), h: Math.max(w, h), count: c });
  renderPieceRows();
}

function foundCountOf(k) {
  const seen = new Set();
  let n = 0;
  state.cells.forEach((c, i) => {
    if (c.status === "item" && c.type === k && !seen.has(c.itemId)) { seen.add(c.itemId); n++; }
  });
  return n;
}

function remainingOf(p) { return p.count - foundCountOf(key(p.w, p.h)); }

/* ---------- UI: stage presets ---------- */
function populateStages() {
  const sel = $("#stageSelect");
  STAGES.forEach(s => {
    const o = document.createElement("option");
    o.value = s.n;
    o.textContent = stageLabel(s);
    sel.appendChild(o);
  });
}

function loadStage(n) {
  const s = ALL_STAGES.find(s => s.n === +n);
  if (!s) return;
  state.pieces = [];
  s.pieces.forEach(([name, count]) => { const [w, h] = sizeOf(name); addPiece(w, h, count); });
  renderPieceRows();   // refresh even when the stage has no published treasures
  $("#gridSize").value = s.grid;
  $("#gridSizeEcho").textContent = s.grid;
  $("#pickPerTile").value = s.pick;
  $("#stageSelect").value = s.n;
  renderStageInfo();   // dimensions only. Treasure names are not shown
  newGame();
}

/* ---------- UI: controls ---------- */
function renderQuickAdd() {
  const box = $("#quickAdd");
  box.innerHTML = "";
  // unique sizes
  const seen = new Set();
  TREASURES.forEach(([name, w, h]) => {
    const k = key(w, h);
    if (seen.has(k)) return; seen.add(k);
    const b = document.createElement("button");
    b.textContent = `${Math.min(w,h)}×${Math.max(w,h)}`;
    b.onclick = () => { addPiece(w, h, 1); markCustom(); saveBoard(); };
    box.appendChild(b);
  });
}

function renderPieceRows() {
  const tb = $("#pieceRows");
  tb.innerHTML = "";
  if (!state.pieces.length) {
    tb.innerHTML = `<tr><td colspan="4" style="color:var(--muted)">${t("pieces.empty")}</td></tr>`;
    return;
  }
  state.pieces.forEach((p, idx) => {
    const k = key(p.w, p.h);
    const found = foundCountOf(k);
    const tr = document.createElement("tr");
    if (found >= p.count) tr.className = "done";
    tr.innerHTML =
      `<td>${p.w}×${p.h}</td>` +
      `<td>${p.count}</td>` +
      `<td>${found}/${p.count}</td>` +
      `<td><button data-i="${idx}" class="danger del">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll(".del").forEach(b => b.onclick = () => {
    state.pieces.splice(+b.dataset.i, 1); renderPieceRows(); markCustom(); saveBoard();
  });
}

/* ---------- Board lifecycle ---------- */
function newGame() {
  state.N = Math.max(2, Math.min(12, +$("#gridSize").value || 5));
  const N = state.N;
  state.cells = Array.from({ length: N * N }, () => ({ status: "hidden", type: null, itemId: 0 }));
  buildGrid();
  recompute();
}

function clearDigs() {
  state.cells.forEach(c => { c.status = "hidden"; c.type = null; c.itemId = 0; });
  renderPieceRows();
  recompute();
}

/* ---------- Persistence: survive a page refresh ---------- */
// The board is plain JSON (grid size, the stage's pieces, every cell), so it
// round-trips through localStorage as-is. Saved on every recompute() and on the
// piece edits that don't trigger one. Bump SAVE_V whenever the shape changes.
const SAVE_KEY = "th.board", SAVE_V = 1;

function saveBoard() {
  if (!state.cells.length) return;        // board not built yet, nothing worth saving
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: SAVE_V,
      N: state.N,
      pieces: state.pieces,
      cells: state.cells,
      stage: $("#stageSelect").value,     // "" = custom
      grid: $("#gridSize").value,         // may differ from N: a slider edit pending a New game
      pick: $("#pickPerTile").value,
    }));
  } catch (_) {}                          // private mode / quota / no storage: just don't persist
}

function validBoard(b) {
  if (!b || b.v !== SAVE_V) return false;
  if (!Number.isInteger(b.N) || b.N < 2 || b.N > 12) return false;
  if (!Array.isArray(b.pieces) || !Array.isArray(b.cells)) return false;
  if (b.cells.length !== b.N * b.N) return false;
  const okPiece = p => p && [p.w, p.h, p.count].every(v => Number.isInteger(v) && v >= 1);
  const okCell = c => c && ["hidden", "empty", "item"].includes(c.status)
    && (c.status !== "item" || /^\d+x\d+$/.test(c.type || ""));
  return b.pieces.every(okPiece) && b.cells.every(okCell);
}

// Does the saved board still match what this stage's preset says *today*? A preset
// can change under a saved board (treasures get published for a stage that had
// none), so we keep the user's board but relabel it "custom" rather than claim it
// is a stage whose definition no longer matches.
function matchesStage(s, b) {
  if (+b.grid !== s.grid) return false;
  const want = new Map();
  s.pieces.forEach(([name, count]) => {
    const k = key(...sizeOf(name));
    want.set(k, (want.get(k) || 0) + count);
  });
  if (want.size !== b.pieces.length) return false;
  return b.pieces.every(p => want.get(key(p.w, p.h)) === p.count);
}

// Reload the last board. Returns false (leaving the app untouched, so the caller
// can fall back to a fresh stage) if nothing is saved or the blob doesn't check out.
function restoreBoard() {
  let b = null;
  try { b = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (_) { return false; }
  if (!validBoard(b)) return false;

  state.N = b.N;
  state.pieces = b.pieces.map(p => ({ w: p.w, h: p.h, count: p.count }));
  state.cells = b.cells.map(c => ({
    status: c.status, type: c.type ?? null, itemId: c.itemId | 0, dug: !!c.dug,
  }));
  itemCounter = Math.max(0, ...state.cells.map(c => c.itemId | 0)) + 1;

  const grid = Math.max(2, Math.min(12, +b.grid || b.N));
  $("#gridSize").value = grid;
  $("#gridSizeEcho").textContent = grid;
  $("#pickPerTile").value = Math.max(1, Math.min(999, +b.pick || 15));
  const s = ALL_STAGES.find(s => String(s.n) === String(b.stage));
  $("#stageSelect").value = (s && matchesStage(s, b)) ? s.n : "";

  renderPieceRows();
  renderStageInfo();
  buildGrid();
  recompute();
  return true;
}

// Size the board and its panel. The board keeps a sensible fixed-ish size (it
// looks odd blown up huge), centered inside a slightly wider panel so the legend
// and hint get more text width. On mobile it keeps the original cap (works well).
function sizeBoard() {
  const N = state.N;
  const mobile = window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
  if (mobile) {
    gridEl.style.width = "";
    gridEl.style.maxWidth = Math.min(560, N * 64) + "px";
    gridEl.style.margin = "0 auto";      // center the board in the card
    gridEl.style.fontSize = "13px";
    stageAreaEl.style.width = "";
    return;
  }
  const CELL = 72, BOARD_MAX = 480, TEXT_W = 560;
  // Widest the board panel can be: viewport minus the controls column
  // (320 + 24px right padding + 1px divider), the gap, wrap padding, and a buffer.
  const availOuter = Math.max(320, window.innerWidth - 345 - 20 - 40 - 24);
  const availH = Math.max(220, window.innerHeight - 280);                    // keep it un-cropped on short viewports
  const board = Math.round(Math.min(N * CELL, BOARD_MAX, availH, availOuter - 48));
  const panel = Math.round(Math.max(board + 48, Math.min(TEXT_W, availOuter)));
  gridEl.style.width = board + "px";
  gridEl.style.maxWidth = board + "px";
  gridEl.style.margin = "0 auto";                                           // board centered in the wider panel
  gridEl.style.fontSize = Math.max(13, Math.min(18, (board / N) * 0.2)).toFixed(1) + "px";
  stageAreaEl.style.width = panel + "px";
}
window.addEventListener("resize", sizeBoard);

function buildGrid() {
  const N = state.N;
  gridEl.style.gridTemplateColumns = `repeat(${N}, 1fr)`;
  sizeBoard();
  gridEl.innerHTML = "";
  for (let i = 0; i < N * N; i++) {
    const d = document.createElement("div");
    d.className = "cell";
    d.dataset.i = i;
    d.onclick = e => onCellClick(i, e);
    gridEl.appendChild(d);
  }
}

/* ============================================================
   SOLVER
   Goal: place every *remaining* piece in the still-hidden cells
   (no overlap; touching allowed; rotations allowed). For each
   hidden cell, probability = fraction of valid full layouts
   that cover it. Exact enumeration when small, else Monte-Carlo.
   ============================================================ */
const EXACT_LEAF_BUDGET = 400000;
const EXACT_NODE_BUDGET = 6000000;
const MC_SAMPLES = 40000;
const MC_TIME_MS = 300;
// Profile-DP exact engine: gives exact per-cell probabilities (no MC sampling
// error) for boards up to DP_MAX_N, in well under a second even for the densest
// real stage. Gated by a user toggle (it's heavier on low-end devices) and a
// state budget so a pathological manual board falls back to DFS/MC. See dpSolve().
const DP_MAX_N = 8;
const DP_STATE_BUDGET = 1500000;

function buildPlacements(N, blocked, w, h) {
  // returns array of Int32Array (cell indices) for both orientations, fully on free cells
  const out = [];
  const orients = (w === h) ? [[w, h]] : [[w, h], [h, w]];
  for (const [pw, ph] of orients) {
    for (let r = 0; r + ph <= N; r++) {
      for (let c = 0; c + pw <= N; c++) {
        const cells = [];
        let ok = true;
        for (let dr = 0; dr < ph && ok; dr++)
          for (let dc = 0; dc < pw; dc++) {
            const idx = (r + dr) * N + (c + dc);
            if (blocked[idx]) { ok = false; break; }
            cells.push(idx);
          }
        if (ok) out.push(Int32Array.from(cells));
      }
    }
  }
  return out;
}

function solve() {
  const N = state.N, M = N * N;
  const blocked = new Uint8Array(M);          // empty or already-found-item cells
  state.cells.forEach((c, i) => { if (c.status !== "hidden") blocked[i] = 1; });

  // remaining pieces, grouped by type (contiguous) for identical-piece dedup
  const groups = [];
  state.pieces.forEach(p => {
    const rem = remainingOf(p);
    if (rem > 0) groups.push({ w: p.w, h: p.h, rem });
  });

  // placements per group
  const placements = groups.map(g => buildPlacements(N, blocked, g.w, g.h));

  // expanded list of single pieces (grouped), each pointing at its placement array
  const expanded = [];
  groups.forEach((g, gi) => {
    if (placements[gi].length === 0 && g.rem > 0) expanded.push({ gi, impossible: true });
    for (let k = 0; k < g.rem; k++) expanded.push({ gi });
  });

  const cover = new Float64Array(M);
  const hidden = []; for (let i = 0; i < M; i++) if (!blocked[i]) hidden.push(i);

  // No remaining pieces -> everything hidden is 0%
  if (expanded.length === 0) {
    return { cover, total: 1, mode: "exact", hidden, blocked, ok: true };
  }
  if (expanded.some(e => e.impossible)) {
    return { cover, total: 0, mode: "exact", hidden, blocked, ok: false };
  }

  // ---- EXACT via profile DP (toggleable; exact + fast for N <= DP_MAX_N) ----
  if (dpEnabled() && N <= DP_MAX_N) {
    const dp = dpSolve(N, blocked, groups);   // groups are {w,h,rem}
    if (dp) {                                  // null => over state budget; fall back
      for (let i = 0; i < M; i++) cover[i] = dp.cover[i];
      return { cover, total: dp.total, mode: "dp", hidden, blocked, ok: dp.total > 0 };
    }
  }

  // ---- try EXACT ----
  const exact = tryExact(expanded, placements, M, cover);
  if (exact.ok) return { cover, total: exact.total, mode: "exact", hidden, blocked, ok: exact.total > 0 };

  // ---- fall back to MONTE-CARLO ----
  cover.fill(0);
  const mc = monteCarlo(expanded, placements, M, cover);
  return { cover, total: mc.success, mode: "mc", samples: mc.tried, hidden, blocked, ok: mc.success > 0 };
}

function tryExact(expanded, placements, M, cover) {
  const dyn = new Uint8Array(M);
  const stack = [];              // currently covered cell indices
  let total = 0, nodes = 0;
  let aborted = false;

  function dfs(i, start) {
    if (aborted) return;
    if (++nodes > EXACT_NODE_BUDGET) { aborted = true; return; }
    if (i === expanded.length) {
      total++;
      if (total > EXACT_LEAF_BUDGET) { aborted = true; return; }
      for (let s = 0; s < stack.length; s++) cover[stack[s]]++;
      return;
    }
    const gi = expanded[i].gi;
    const pls = placements[gi];
    const sameAsPrev = i > 0 && expanded[i - 1].gi === gi;
    const from = sameAsPrev ? start + 1 : 0;
    for (let j = from; j < pls.length && !aborted; j++) {
      const cells = pls[j];
      let clash = false;
      for (let t = 0; t < cells.length; t++) if (dyn[cells[t]]) { clash = true; break; }
      if (clash) continue;
      for (let t = 0; t < cells.length; t++) { dyn[cells[t]] = 1; stack.push(cells[t]); }
      dfs(i + 1, j);
      for (let t = 0; t < cells.length; t++) { dyn[cells[t]] = 0; stack.pop(); }
    }
  }

  dfs(0, -1);
  if (aborted) return { ok: false };
  return { ok: true, total };
}

function monteCarlo(expanded, placements, M, cover) {
  const dyn = new Uint8Array(M);
  const order = expanded.map((e, i) => i);
  let success = 0, tried = 0;
  const t0 = performance.now();

  while (tried < MC_SAMPLES) {
    tried++;
    // shuffle placement order of pieces to reduce sequential bias
    for (let i = order.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [order[i], order[j]] = [order[j], order[i]];
    }
    dyn.fill(0);
    const placed = [];
    let ok = true;
    for (let oi = 0; oi < order.length; oi++) {
      const gi = expanded[order[oi]].gi;
      const pls = placements[gi];
      // collect valid placements
      const valid = [];
      for (let j = 0; j < pls.length; j++) {
        const cells = pls[j];
        let clash = false;
        for (let t = 0; t < cells.length; t++) if (dyn[cells[t]]) { clash = true; break; }
        if (!clash) valid.push(cells);
      }
      if (valid.length === 0) { ok = false; break; }
      const cells = valid[(Math.random() * valid.length) | 0];
      for (let t = 0; t < cells.length; t++) { dyn[cells[t]] = 1; placed.push(cells[t]); }
    }
    if (ok) {
      success++;
      for (let s = 0; s < placed.length; s++) cover[placed[s]]++;
    }
    if ((tried & 1023) === 0 && performance.now() - t0 > MC_TIME_MS) break;
  }
  return { success, tried };
}

/* ============================================================
   EXACT SOLVER. Profile (broken-plug) DP
   Same answer as tryExact (per-cell coverage over all valid no-overlap
   layouts) but counts instead of enumerating, so it stays exact on the dense
   stages where DFS blows up and the app would otherwise fall to Monte-Carlo.

   Scan cells row-major. State = (row, P[], counts[]):
     P[c]     = # rows from the current row downward that column c is already
                occupied by a rectangle whose top is at/above this row.
     counts[] = remaining pieces per type.
   At a free top cell you leave it empty or drop a piece's top-left corner.
   Pass 1 (DProw) memoises B(s) = # completions from each row-entry state.
   Pass 2 walks rows forward tracking F(s) = # prefixes reaching s; for every way
   to fill a row (entry s -> exit s', occupying a set of cells) it adds F(s)·B(s')
   to each occupied cell. Each layout is counted once at its row-r filling, so
   this yields exact coverage in ~2x the total-count cost. Returns null if the
   state count exceeds DP_STATE_BUDGET (pathological board -> caller falls back).
   ============================================================ */
function dpEnabled() {
  const el = document.getElementById("dpToggle");
  return el ? el.checked : true;
}

// The bomb toggle (estimator only): when on, the estimate simulates the game's bombs.
function bombEnabled() {
  const el = document.getElementById("bombToggle");
  return el ? el.checked : false;   // default off; opt-in, persisted in localStorage["th.bomb"]
}
function dpSolve(N, blocked, types) {
  const M = N * N, T = types.length;
  if (T === 0) return { cover: new Float64Array(M), total: 1 };
  const oris = types.map(t => (t.w === t.h) ? [[t.w, t.h]] : [[t.w, t.h], [t.h, t.w]]);
  let Hmax = 1; for (const t of types) Hmax = Math.max(Hmax, t.w, t.h);
  const PB = Hmax, Pmax = Math.pow(PB, N);
  const countRadix = types.map(t => t.rem + 1);
  let countMax = 1; for (const r of countRadix) countMax *= r;
  const encCounts = cn => { let k = 0; for (let i = T - 1; i >= 0; i--) k = k * countRadix[i] + cn[i]; return k; };
  const encP = P => { let k = 0; for (let c = N - 1; c >= 0; c--) k = k * PB + P[c]; return k; };
  const fullKey = (r, P, counts) => (r * Pmax + encP(P)) * countMax + encCounts(counts);

  // pass 1: B(s) = completions from each row-entry state
  const memo = new Map();
  let aborted = false;
  function DProw(r, P, counts) {
    if (aborted) return 0;
    if (r === N) { for (let i = 0; i < T; i++) if (counts[i] !== 0) return 0; return 1; }
    const key = fullKey(r, P, counts);
    const c = memo.get(key); if (c !== undefined) return c;
    const v = fillCount(r, 0, P, counts, new Int32Array(N));
    memo.set(key, v);
    if (memo.size > DP_STATE_BUDGET) aborted = true;
    return v;
  }
  function fillCount(r, c, P, counts, nextP) {
    if (aborted) return 0;
    if (c === N) return DProw(r + 1, nextP, counts);
    if (P[c] > 0) { nextP[c] = P[c] - 1; return fillCount(r, c + 1, P, counts, nextP); }
    let total = 0; nextP[c] = 0; total += fillCount(r, c + 1, P, counts, nextP);
    if (!blocked[r * N + c]) for (let t = 0; t < T && !aborted; t++) { if (!counts[t]) continue;
      for (const [pw, ph] of oris[t]) {
        if (c + pw > N || r + ph > N) continue;
        let ok = true;
        for (let cc = c; cc < c + pw && ok; cc++) if (P[cc] !== 0) ok = false;
        for (let rr = r; rr < r + ph && ok; rr++) for (let cc = c; cc < c + pw; cc++) if (blocked[rr * N + cc]) { ok = false; break; }
        if (!ok) continue;
        counts[t]--; for (let cc = c; cc < c + pw; cc++) nextP[cc] = ph - 1;
        total += fillCount(r, c + pw, P, counts, nextP); counts[t]++;
      }
    }
    return total;
  }
  const full = Int32Array.from(types.map(t => t.rem));
  const total = DProw(0, new Int32Array(N), full);
  if (aborted) return null;

  // pass 2: forward F + coverage
  const cover = new Float64Array(M);
  if (total === 0) return { cover, total };
  function enumFill(r, c, P, counts, nextP, occ, cb) {
    if (c === N) { cb(nextP, counts, occ); return; }
    if (P[c] > 0) { nextP[c] = P[c] - 1; occ.push(c); enumFill(r, c + 1, P, counts, nextP, occ, cb); occ.pop(); return; }
    nextP[c] = 0; enumFill(r, c + 1, P, counts, nextP, occ, cb);
    if (!blocked[r * N + c]) for (let t = 0; t < T; t++) { if (!counts[t]) continue;
      for (const [pw, ph] of oris[t]) {
        if (c + pw > N || r + ph > N) continue;
        let ok = true;
        for (let cc = c; cc < c + pw && ok; cc++) if (P[cc] !== 0) ok = false;
        for (let rr = r; rr < r + ph && ok; rr++) for (let cc = c; cc < c + pw; cc++) if (blocked[rr * N + cc]) { ok = false; break; }
        if (!ok) continue;
        counts[t]--; const base = occ.length;
        for (let cc = c; cc < c + pw; cc++) { nextP[cc] = ph - 1; occ.push(cc); }
        enumFill(r, c + pw, P, counts, nextP, occ, cb); occ.length = base; counts[t]++;
      }
    }
  }
  let cur = new Map();   // rowKey -> { P, counts, F }
  cur.set(encP(new Int32Array(N)) * countMax + encCounts(full), { P: new Int32Array(N), counts: full.slice(), F: 1 });
  for (let r = 0; r < N; r++) {
    const nxt = new Map();
    for (const [, st] of cur) {
      const Fs = st.F;
      enumFill(r, 0, st.P, st.counts, new Int32Array(N), [], (exitP, exitCounts, occList) => {
        let B;   // terminal-row exit states aren't memoised (DProw's base case)
        if (r + 1 === N) { B = 1; for (let i = 0; i < T; i++) if (exitCounts[i]) { B = 0; break; } }
        else B = memo.get(fullKey(r + 1, exitP, exitCounts)) || 0;
        const fkey = encP(exitP) * countMax + encCounts(exitCounts);
        let e = nxt.get(fkey);
        if (!e) { e = { P: Int32Array.from(exitP), counts: Int32Array.from(exitCounts), F: 0 }; nxt.set(fkey, e); }
        e.F += Fs;
        if (B > 0) { const w = Fs * B; for (const cc of occList) cover[r * N + cc] += w; }
      });
    }
    cur = nxt;
  }
  return { cover, total };
}

/* ============================================================
   PICK-COST ESTIMATOR
   "Average picks to fully solve, from the current board."
   Finding a treasure (one hit reveals its footprint) is NOT the
   same as collecting it: every tile of every treasure must be dug
   out. So picks to finish = (empty tiles wasted while hunting for
   the unlocated treasures) + (all treasure tiles still to dig:
   unlocated areas + buried tiles of located treasures).
   Only the empty-hunt cost is stochastic, so we Monte-Carlo just
   that (greedy: dig the highest-coverage unknown tile) and add the
   fixed treasure-tile cost. Picks = tiles x pickaxes-per-tile.
   Bombs are ignored (they only make the real cost lower).
   ============================================================ */
const EST_TRIALS = 600;
const EST_TIME_MS = 1500;

// Bomb model (the game's BombWeight table, standard tablet = 45 of 48; weights sum to
// 10000). A paid dig of an EMPTY tile sets off a bomb that opens k extra tiles for free,
// k drawn from this distribution (E[k] = 0.95). A bomb-opened tile is collected free.
// Digging a treasure tile (locating one, or digging out a buried one) sets off nothing.
// Used only when the bomb toggle is on. See simulateBomb().
const BOMB_DIST = [[0, 4000], [1, 3500], [2, 1600], [3, 800], [4, 100]];
function rollBomb() { let r = (Math.random() * 10000) | 0, a = 0; for (const [k, w] of BOMB_DIST) { a += w; if (r < a) return k; } return 0; }

// Place the remaining (unfound) pieces on the currently-hidden cells, no overlap.
// Returns { owner } where owner[cell] = treasure index (>=0) or -1 for empty.
function sampleLayout(N, M, baseKnown, types, placeByType) {
  const occ = baseKnown.slice();
  const owner = new Int32Array(M).fill(-1);
  const insts = [];
  types.forEach((t, ti) => { for (let k = 0; k < t.rem; k++) insts.push(ti); });
  for (let i = insts.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [insts[i], insts[j]] = [insts[j], insts[i]]; }

  const treasures = [];
  for (const ti of insts) {
    const pls = placeByType[ti];
    const valid = [];
    for (let p = 0; p < pls.length; p++) {
      const cells = pls[p];
      let ok = true;
      for (let c = 0; c < cells.length; c++) if (occ[cells[c]]) { ok = false; break; }
      if (ok) valid.push(cells);
    }
    if (valid.length === 0) return null;            // layout doesn't fit -> reject
    const cells = valid[(Math.random() * valid.length) | 0];
    const id = treasures.length;
    for (let c = 0; c < cells.length; c++) { occ[cells[c]] = 1; owner[cells[c]] = id; }
    treasures.push({ ti, cells });
  }
  return { owner, treasures };
}

// Simulate greedy play against a known layout: dig only unknown tiles (the strategy
// the heatmap recommends) until every treasure is located, deferring the dig-out of
// located treasures. Returns the number of *empty* tiles dug along the way. The only
// stochastic cost. Treasure tiles are a fixed cost handled by the caller.
function simulateGreedy(N, M, baseKnown, types, placeByType, layout, score) {
  const known = baseKnown.slice();
  const rem = types.map(t => t.rem);
  let toFind = layout.treasures.length, empties = 0;

  while (toFind > 0) {
    score.fill(0);
    for (let ti = 0; ti < types.length; ti++) {
      if (rem[ti] === 0) continue;
      const pls = placeByType[ti], wt = rem[ti];
      for (let p = 0; p < pls.length; p++) {
        const cells = pls[p];
        let ok = true;
        for (let c = 0; c < cells.length; c++) if (known[cells[c]]) { ok = false; break; }
        if (!ok) continue;
        for (let c = 0; c < cells.length; c++) score[cells[c]] += wt;
      }
    }
    let best = -1, bestS = -1;
    for (let i = 0; i < M; i++) if (!known[i] && score[i] > bestS) { bestS = score[i]; best = i; }
    if (best < 0) break;                            // nothing left to dig (safety)
    const o = layout.owner[best];
    if (o < 0) { known[best] = 1; empties++; }      // wasted empty dig
    else {                                          // located a treasure -> reveal footprint, dig it out later
      const tr = layout.treasures[o];
      for (let c = 0; c < tr.cells.length; c++) known[tr.cells[c]] = 1;
      rem[tr.ti]--; toFind--;
    }
  }
  return empties;
}

// Bomb-aware playthrough for the estimator (used when the bomb toggle is on). Like
// simulateGreedy, but a paid dig of an EMPTY tile sets off a bomb that opens k random
// still-unopened tiles for free (k ~ BOMB_DIST); a bomb-opened treasure tile is collected
// (no pickaxe) and locates its piece. Digging a treasure tile sets off nothing, so the
// dig-out phase never triggers bombs. Targeting is uniform over all unopened cells,
// INCLUDING located-but-buried tiles (preBuried). Unlike simulateGreedy this returns the
// TOTAL paid digs (empties + every treasure tile actually paid for), so the caller adds
// no fixed cost: with free bomb collection the treasure-tile cost is no longer fixed.
function simulateBomb(N, M, baseKnown, opened0, preBuried, types, placeByType, layout, score) {
  const owner = layout.owner, treasures = layout.treasures;
  const opened = opened0.slice(), blocked = baseKnown.slice();
  const rem = types.map(t => t.rem);
  const located = new Uint8Array(treasures.length);
  let toLocate = treasures.length, unopened = 0, paid = 0;
  for (let i = 0; i < M; i++) if (!opened[i] && (preBuried[i] || owner[i] >= 0)) unopened++;

  function open(cell) {
    if (opened[cell]) return;
    opened[cell] = 1; blocked[cell] = 1;
    if (preBuried[cell]) { unopened--; return; }
    const o = owner[cell];
    if (o >= 0) {
      unopened--;
      if (!located[o]) {                       // reveal the whole footprint (locate)
        located[o] = 1; toLocate--; rem[treasures[o].ti]--;
        const cs = treasures[o].cells; for (let c = 0; c < cs.length; c++) blocked[cs[c]] = 1;
      }
    }
  }
  const bag = [];
  function bomb() {
    let k = rollBomb();
    while (k-- > 0) {
      bag.length = 0;
      for (let i = 0; i < M; i++) if (!opened[i]) bag.push(i);   // uniform over all unopened
      if (!bag.length) return;
      open(bag[(Math.random() * bag.length) | 0]);
    }
  }

  while (unopened > 0) {
    let target = -1;
    if (toLocate > 0) {                        // HUNT: greedy over the unlocated pieces
      score.fill(0);
      for (let ti = 0; ti < types.length; ti++) {
        if (rem[ti] === 0) continue;
        const pls = placeByType[ti], wt = rem[ti];
        for (let p = 0; p < pls.length; p++) {
          const cells = pls[p]; let ok = true;
          for (let c = 0; c < cells.length; c++) if (blocked[cells[c]]) { ok = false; break; }
          if (!ok) continue;
          for (let c = 0; c < cells.length; c++) score[cells[c]] += wt;
        }
      }
      let bestS = -1;
      for (let i = 0; i < M; i++) if (!blocked[i] && score[i] > bestS) { bestS = score[i]; target = i; }
    } else {                                   // DIG OUT: any still-buried treasure tile
      for (let i = 0; i < M; i++) if (!opened[i] && (preBuried[i] || owner[i] >= 0)) { target = i; break; }
    }
    if (target < 0) break;
    const wasEmpty = owner[target] < 0 && !preBuried[target];
    paid++; open(target);
    if (wasEmpty) bomb();                       // only an empty dig sets off a bomb
  }
  return paid;
}

function estimateSolve() {
  const N = state.N, M = N * N;
  const baseKnown = new Uint8Array(M);            // 1 = not an unknown tile (empty or located treasure)
  state.cells.forEach((c, i) => { if (c.status !== "hidden") baseKnown[i] = 1; });

  // Tiles of already-located treasures that still need digging out (dug:false).
  let buriedCount = 0;
  state.cells.forEach(c => { if (c.status === "item" && !c.dug) buriedCount++; });

  // For the bomb sim: opened0 = tiles already collected (dug empties + dug-out treasure
  // tiles), preBuried = located tiles still to dig out (valid free bomb targets).
  const opened0 = new Uint8Array(M), preBuried = new Uint8Array(M);
  state.cells.forEach((c, i) => {
    if (c.status === "empty" || (c.status === "item" && c.dug)) opened0[i] = 1;
    else if (c.status === "item" && !c.dug) preBuried[i] = 1;
  });

  // Unlocated treasures (positions unknown). These drive the search simulation.
  const types = [];
  state.pieces.forEach(p => { const r = remainingOf(p); if (r > 0) types.push({ w: p.w, h: p.h, rem: r }); });
  const numUnlocated = types.reduce((a, t) => a + t.rem, 0);
  const unlocatedArea = types.reduce((a, t) => a + t.rem * t.w * t.h, 0);

  if (numUnlocated === 0 && buriedCount === 0) return { done: true };
  // Everything is located: only the dig-out of buried tiles remains. Bombs never fire on
  // treasure-tile digs, so this stays deterministic even with the bomb toggle on.
  if (numUnlocated === 0) {
    return { mean: buriedCount, p10: buriedCount, p90: buriedCount, min: buriedCount, max: buriedCount, trials: 0, deterministic: true };
  }

  const placeByType = types.map(t => buildPlacements(N, baseKnown, t.w, t.h));
  if (placeByType.some(pls => pls.length === 0)) return { impossible: true };

  // Bomb toggle: simulate the game's bombs (they collect tiles for free, so the whole
  // playthrough is stochastic and there is no fixed treasure-tile term to add).
  if (bombEnabled()) {
    const score = new Float64Array(M);
    const results = [];
    let rejected = 0;
    const t0 = performance.now();
    for (let trial = 0; trial < EST_TRIALS; trial++) {
      const layout = sampleLayout(N, M, baseKnown, types, placeByType);
      if (!layout) { rejected++; if (rejected > EST_TRIALS * 4) break; trial--; continue; }
      results.push(simulateBomb(N, M, baseKnown, opened0, preBuried, types, placeByType, layout, score));
      if ((trial & 15) === 0 && performance.now() - t0 > EST_TIME_MS) break;
    }
    if (results.length === 0) return { impossible: true };
    results.sort((a, b) => a - b);
    const n = results.length;
    const mean = results.reduce((a, b) => a + b, 0) / n;
    const pct = q => results[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
    return { mean, p10: pct(0.10), p90: pct(0.90), min: results[0], max: results[n - 1], trials: n, bomb: true };
  }

  // Total picks to finish = empty digs while hunting (stochastic) + every treasure
  // tile that still has to be dug out (unlocated areas + buried located tiles).
  const fixed = unlocatedArea + buriedCount;
  const score = new Float64Array(M);
  const results = [];
  let rejected = 0;
  const t0 = performance.now();
  for (let trial = 0; trial < EST_TRIALS; trial++) {
    const layout = sampleLayout(N, M, baseKnown, types, placeByType);
    if (!layout) { rejected++; if (rejected > EST_TRIALS * 4) break; trial--; continue; }
    results.push(simulateGreedy(N, M, baseKnown, types, placeByType, layout, score) + fixed);
    if ((trial & 15) === 0 && performance.now() - t0 > EST_TIME_MS) break;
  }
  if (results.length === 0) return { impossible: true };

  results.sort((a, b) => a - b);
  const n = results.length;
  const mean = results.reduce((a, b) => a + b, 0) / n;
  const pct = q => results[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  return { mean, p10: pct(0.10), p90: pct(0.90), min: results[0], max: results[n - 1], trials: n };
}

function runEstimate() {
  const out = $("#estimateOut");
  const pick = Math.max(1, +$("#pickPerTile").value || 1);
  // No treasures entered is now the state every stage starts in, and estimateSolve()
  // would call that "done" (nothing left to find) rather than "not started".
  if (!state.pieces.length) { out.innerHTML = `<span class="warn">${t("board.noTreasures")}</span>`; return; }
  out.textContent = t("estimate.simulating");
  // let the "Simulating…" paint before the blocking compute
  setTimeout(() => {
    const r = estimateSolve();
    if (r.done) { out.innerHTML = `<span style="color:var(--accent)">${t("estimate.allDug")}</span>`; return; }
    if (r.impossible) { out.innerHTML = `<span class="warn">${t("estimate.impossible")}</span>`; return; }
    const picks = Math.round(r.mean * pick), digs = Math.round(r.mean);
    const headline = t("estimate.headline", { picks: nfmt(picks), digs: nfmt(digs), _n: picks });
    const detail = r.deterministic
      ? t("estimate.deterministic")
      : t(r.bomb ? "estimate.detailBomb" : "estimate.detail",
          { lo: nfmt(Math.round(r.p10 * pick)), hi: nfmt(Math.round(r.p90 * pick)),
            min: nfmt(Math.round(r.min * pick)), max: nfmt(Math.round(r.max * pick)) });
    out.innerHTML = headline + "<br>" + `<span style="color:var(--muted)">${detail}</span>`;
  }, 20);
}

/* ---------- Render heatmap ---------- */
let lastResult = null;

function recompute() {
  const res = solve();
  lastResult = res;
  const N = state.N;
  const cellsEl = gridEl.children;

  // Best tile(s) to dig next = highest-probability hidden tile (found treasures
  // are already revealed, so they're excluded). Ties (common, esp. by symmetry)
  // are all highlighted. BEST_EPS folds exact-fraction ties together while
  // staying tight enough that Monte-Carlo noise doesn't over-highlight.
  const BEST_EPS = 1e-6;
  let maxP = 0;
  if (res.total > 0) {
    for (let i = 0; i < N * N; i++) {
      if (state.cells[i].status !== "hidden") continue;
      const p = res.cover[i] / res.total;
      if (isFinite(p) && p > maxP) maxP = p;
    }
  }

  for (let i = 0; i < N * N; i++) {
    const el = cellsEl[i];
    const c = state.cells[i];
    el.classList.remove("hl", "dim", "best");
    // Dug tiles hand both background and ink back to the stylesheet. Clearing the
    // inline colour matters: it is set below while the tile is hidden, and leaving
    // it behind would override .cell.empty / .cell.item and follow the tile for the
    // rest of the game (light ⛏ on gold, 2.1:1). A restored board builds fresh
    // elements with no inline colour, so the leak also made a refresh change the
    // board's appearance.
    if (c.status === "empty") {
      el.className = "cell empty"; el.innerHTML = "✕";
      el.style.background = ""; el.style.color = "";
      continue;
    }
    if (c.status === "item") {
      // located treasure: ⛏ buried (hatched, still to dig) vs ✓ dug-out (solid)
      el.className = "cell item" + (c.dug ? "" : " buried");
      el.innerHTML = `${c.dug ? "✓" : "⛏"}<span class="sub">${c.type}</span>`;
      el.style.background = ""; el.style.color = "";
      continue;
    }
    // hidden
    el.className = "cell";
    let p = (res.total > 0) ? res.cover[i] / res.total : NaN;
    if (!isFinite(p)) {
      el.style.background = "#3a3030"; el.style.color = INK_LIGHT; el.innerHTML = "?";
    } else {
      p = Math.max(0, Math.min(1, p));
      el.style.background = heat(p);
      el.style.color = inkFor(p);
      el.innerHTML = (p * 100).toFixed(p >= 0.995 ? 0 : (p < 0.1 ? 1 : 0)) + "%";
      if (maxP > 0 && p >= maxP - BEST_EPS) {
        el.classList.add("best");
        el.insertAdjacentHTML("beforeend", '<span class="star">★</span>');
      }
    }
  }

  // Status line. With no treasures entered there is nothing to solve, and the normal
  // line would read "Remaining to find: none. Exact over 1 layout", i.e. "you're
  // done" on an untouched board. So it becomes the prompt to enter them, pointing at
  // the setup panel: left of the board on desktop, below it on mobile. Which arrow
  // shows is CSS (the same 720px breakpoint that reorders the columns), so the copy
  // is one string and nothing here has to ask matchMedia.
  let msg;
  if (!state.pieces.length) {
    msg = '<span class="warn"><span class="point-left" aria-hidden="true">← </span>'
        + '<span class="point-down" aria-hidden="true">↓ </span>'
        + t("board.noTreasures") + "</span>";
  } else {
    const remList = state.pieces
      .filter(p => remainingOf(p) > 0)
      .map(p => t("status.remItem", { w: p.w, h: p.h, n: remainingOf(p) })).join(", ") || t("status.none");
    msg = t("status.remaining", { list: remList });
    if (!res.ok && res.total === 0) {
      msg += `<span class="warn">${t("status.noLayout")}</span>`;
    } else if (res.mode === "exact" || res.mode === "dp") {
      msg += t("status.exact", { _n: res.total, total: nfmt(res.total), dp: res.mode === "dp" ? t("status.dpSuffix") : "" });
    } else {
      const rej = res.samples ? (100 * (1 - res.total / res.samples)).toFixed(0) : 0;
      msg += t("status.estimated", { _n: res.total, total: nfmt(res.total), rej });
    }
  }
  $("#status").innerHTML = msg;
  $("#estimateOut").textContent = "";   // board changed -> previous estimate is stale
  saveBoard();                          // every board mutation lands here
}

/* ---------- Heatmap colour and glyph ink ----------
   The ramp runs blue (cold) to red (hot), unchanged.

   Ink cannot be picked from p. Hue drives perceived brightness far more than p
   does, so the green midrange (p ~ 0.4) is the *brightest* part of the ramp, and
   the old `p > 0.55 ? dark : light` rule put light ink on it at 2.1:1. inkFor()
   measures the tile's actual relative luminance instead and flips at the crossover.

   The inks are pure white and black on purpose. At the crossover luminance both
   inks necessarily give the *same* contrast, and that value is the ceiling for the
   pair: softer inks (#eef on #20160a) cap out at 3.94:1, which cannot clear AA no
   matter how the ramp or the threshold is tuned, because a ramp climbing from dark
   blue to bright green has to pass through that luminance. Pure #fff/#000 lifts the
   ceiling to 4.58:1, so every tile on every stage clears AA (measured worst: 4.59:1). */
const HEAT_HUE = p => 240 * (1 - p);
const HEAT_LIGHT = p => 38 + 14 * p;

function heat(p) {
  return `hsl(${HEAT_HUE(p)} 70% ${HEAT_LIGHT(p)}%)`;
}

// WCAG relative luminance of the heat colour at p (hsl -> rgb -> linearise -> luma).
function heatLuminance(p) {
  const h = HEAT_HUE(p), s = 0.70, l = HEAT_LIGHT(p) / 100;
  const a = s * Math.min(l, 1 - l);
  const chan = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const lin = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(chan(0)) + 0.7152 * lin(chan(8)) + 0.0722 * lin(chan(4));
}

const INK_LIGHT = "#fff", INK_DARK = "#000";
const INK_FLIP = 0.179;   // where white and black contrast equally: sqrt(1.05 * 0.05) - 0.05
const inkFor = p => (heatLuminance(p) > INK_FLIP ? INK_DARK : INK_LIGHT);

/* ---------- Interaction: clicking cells ---------- */
function hidePop() { popEl.style.display = "none"; popEl.onmouseleave = null; clearHighlights(); }
function clearHighlights() {
  gridEl.querySelectorAll(".cell.hl,.cell.dim").forEach(el => el.classList.remove("hl", "dim"));
}

function onCellClick(i, ev) {
  ev.stopPropagation();
  const c = state.cells[i];
  if (c.status === "empty" || c.status === "item") {
    openClearMenu(i, ev);
  } else {
    openDigMenu(i, ev);
  }
}

function placePop(ev) {
  popEl.style.display = "block";
  // On phones: render as a bottom sheet (CSS-positioned). matchMedia is guarded
  // because jsdom (tests) doesn't implement it. There we fall through to anchored.
  const mobile = window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
  if (mobile) {
    popEl.classList.add("sheet");
    popEl.style.left = ""; popEl.style.top = "";
    return;
  }
  popEl.classList.remove("sheet");
  const pad = 8, w = popEl.offsetWidth, h = popEl.offsetHeight;
  // Anchor near the cursor, then keep the whole popover on-screen. Clamp on BOTH
  // ends: pinning the far edge alone (innerHeight - h - pad) goes negative when a
  // long candidate list is taller than the viewport, shoving the title and top
  // rows off the top. Math.max(pad, ...) pins it at the top instead; the #pop
  // max-height/overflow then lets the list scroll rather than run off the page.
  const x = Math.max(pad, Math.min(ev.clientX + 6, innerWidth - w - pad));
  const y = Math.max(pad, Math.min(ev.clientY + 6, innerHeight - h - pad));
  popEl.style.left = x + "px";
  popEl.style.top = y + "px";
}

function openDigMenu(i, ev) {
  popEl.onmouseleave = null;   // drop the placement picker's preview-clear handler
  clearHighlights();   // drop any placement preview when returning to this menu
  popEl.innerHTML = `<div class="ttl">${t("dig.title", { label: cellLabel(i) })}</div>`;
  const empty = mkBtn(t("dig.empty"), () => { setEmpty(i); hidePop(); });
  popEl.appendChild(empty);

  let any = false;
  state.pieces.forEach(p => {
    if (remainingOf(p) <= 0) return;
    any = true;
    const b = mkBtn(t("dig.option", { w: p.w, h: p.h, n: remainingOf(p) }), () => openPlacementPicker(i, p, ev));
    popEl.appendChild(b);
  });
  if (!any) {
    const n = document.createElement("div");
    // "All treasures already found" is wrong when none were ever entered, which is
    // now the state every stage starts in.
    n.className = "ttl"; n.textContent = state.pieces.length ? t("dig.allFound") : t("board.noTreasures");
    popEl.appendChild(n);
  }
  popEl.appendChild(mkBtn(t("common.cancel"), hidePop));
  placePop(ev);
}

// A tiny N×N picture of where a candidate treasure sits (so picking a placement
// never depends on seeing the main grid. Important when a bottom sheet covers it).
function miniDiagram(cells, dugIdx) {
  const N = state.N, set = new Set(cells);
  const g = document.createElement("span");
  g.className = "mini";
  g.style.gridTemplateColumns = `repeat(${N}, 1fr)`;
  for (let idx = 0; idx < N * N; idx++) {
    const s = document.createElement("span");
    if (set.has(idx)) s.className = idx === dugIdx ? "f dug" : "f";
    g.appendChild(s);
  }
  return g;
}

// One candidate row with a mini-diagram + label (used by the touch UI).
function candidateButton(cells, dugIdx) {
  const b = document.createElement("button");
  b.className = "opt place";
  b.appendChild(miniDiagram(cells, dugIdx));
  const lbl = document.createElement("span");
  lbl.textContent = placementLabel(cells);
  b.appendChild(lbl);
  return b;
}

function openPlacementPicker(i, piece, ev) {
  // placements of this piece that COVER tile i and lie entirely on hidden cells
  const N = state.N;
  const blocked = new Uint8Array(N * N);
  state.cells.forEach((c, idx) => { if (c.status !== "hidden") blocked[idx] = 1; });
  const cands = buildPlacements(N, blocked, piece.w, piece.h).filter(cells => cells.includes(i));

  // Touch devices can't hover to preview, so they get a different picker.
  const touch = !!(window.matchMedia && window.matchMedia("(hover: none)").matches);
  const hint = touch ? t("place.hintTouch") : t("place.hintHover");
  popEl.innerHTML = `<div class="ttl">${t("place.prompt", { w: piece.w, h: piece.h })} <span style="opacity:.6">(${hint})</span></div>`;

  if (cands.length === 0) {
    const n = document.createElement("div"); n.className = "ttl";
    n.textContent = t("place.none");
    popEl.appendChild(n);
    popEl.appendChild(mkBtn(t("common.back"), () => openDigMenu(i, ev)));
    placePop(ev);
    return;
  }

  if (touch) {
    // Mobile: select-then-place. Tap a row to preview it (grid + mini-diagram),
    // then tap the confirm button. No hover, and no selection drift on the way down.
    let selected = 0;
    const rows = [];
    const select = idx => {
      selected = idx;
      previewCells(cands[idx]);
      rows.forEach((b, k) => b.classList.toggle("sel", k === idx));
    };
    cands.forEach((cells, ci) => {
      const b = candidateButton(cells, i);
      b.onclick = e => { e.stopPropagation(); select(ci); };
      rows.push(b);
      popEl.appendChild(b);
    });
    popEl.appendChild(mkBtn(t("place.placeIt"), () => { commitItem(piece, cands[selected], i); hidePop(); }, "primary"));
    popEl.appendChild(mkBtn(t("common.back"), () => openDigMenu(i, ev)));
    placePop(ev);
    select(0);   // auto-preview the first candidate
  } else {
    // Desktop (mouse): same mini-diagram rows, faster interaction. Hover previews,
    // a single click places it (no travel to a confirm button).
    cands.forEach(cells => {
      const b = candidateButton(cells, i);
      b.onmouseenter = () => previewCells(cells);
      b.onclick = e => { e.stopPropagation(); commitItem(piece, cells, i); hidePop(); };
      popEl.appendChild(b);
    });
    // Clear the preview when the cursor lands on a non-candidate (the Back button)
    // or leaves the popover entirely, NOT per candidate row: a per-row mouseleave
    // fires in the small gap between rows and blinks the board bright->dim. popEl's
    // mouseleave (unlike mouseout) ignores row-to-row moves inside the popover.
    const back = mkBtn(t("common.back"), () => openDigMenu(i, ev));
    back.onmouseenter = clearHighlights;
    popEl.appendChild(back);
    popEl.onmouseleave = clearHighlights;
    placePop(ev);
  }
}

function openClearMenu(i, ev) {
  popEl.onmouseleave = null;
  clearHighlights();
  const c = state.cells[i];
  if (c.status === "item") {
    const st = c.dug ? t("clear.stateDug") : t("clear.stateBuried");
    popEl.innerHTML = `<div class="ttl">${t("clear.itemTitle", { label: cellLabel(i), dim: c.type, state: st })}</div>`;
    if (c.dug) popEl.appendChild(mkBtn(t("clear.markBuried"), () => { setDug(i, false); hidePop(); }));
    else       popEl.appendChild(mkBtn(t("clear.markDug"), () => { setDug(i, true); hidePop(); }));
    popEl.appendChild(mkBtn(t("clear.clearTreasure"), () => { clearItem(c.itemId); hidePop(); }));
  } else {
    popEl.innerHTML = `<div class="ttl">${t("clear.emptyTitle", { label: cellLabel(i) })}</div>`;
    popEl.appendChild(mkBtn(t("clear.backToHidden"), () => { state.cells[i] = { status: "hidden", type: null, itemId: 0 }; recompute(); hidePop(); }));
  }
  popEl.appendChild(mkBtn(t("common.cancel"), hidePop));
  placePop(ev);
}

function mkBtn(txt, fn, cls) {
  const b = document.createElement("button");
  b.className = "opt" + (cls ? " " + cls : ""); b.textContent = txt;
  // Stop the click bubbling to the document "close on outside click" handler.
  // Submenu buttons rebuild popEl.innerHTML, which detaches the clicked button;
  // without this, popEl.contains(target) becomes false and the popover self-closes.
  b.onclick = e => { e.stopPropagation(); fn(); };
  return b;
}

function cellLabel(i) { const N = state.N; return t("cell.label", { r: (i / N | 0) + 1, c: (i % N) + 1 }); }

function placementLabel(cells) {
  const N = state.N;
  const rs = cells.map(x => x / N | 0), cs = cells.map(x => x % N);
  const r0 = Math.min(...rs) + 1, r1 = Math.max(...rs) + 1;
  const c0 = Math.min(...cs) + 1, c1 = Math.max(...cs) + 1;
  const coords = t("place.coords", { r0, c0, r1, c1 });
  // Orientation from the footprint's proportions, not "is it one row?" (which is
  // only ever true for a thin 1xk piece; a 2x4 spans rows either way, so the old
  // r0===r1 test labeled every thick placement "vertical"). A square footprint
  // (2x2, 3x3) has no direction, so it shows coords alone.
  const rowspan = r1 - r0, colspan = c1 - c0;
  if (rowspan === colspan) return coords;
  return `${colspan > rowspan ? t("place.horizontal") : t("place.vertical")}  ${coords}`;
}

function previewCells(cells) {
  clearHighlights();
  const kids = gridEl.children;
  for (let i = 0; i < kids.length; i++) kids[i].classList.add("dim");
  cells.forEach(idx => { kids[idx].classList.remove("dim"); kids[idx].classList.add("hl"); });
}

/* ---------- State mutations ---------- */
function setEmpty(i) { state.cells[i] = { status: "empty", type: null, itemId: 0 }; recompute(); }

let itemCounter = 1;
function commitItem(piece, cells, dugIdx) {
  const id = itemCounter++;
  const k = key(piece.w, piece.h);
  // The tile you clicked is the one you actually dug to locate it; the rest are
  // known-but-buried (you still have to dig them out to collect the treasure).
  cells.forEach(idx => { state.cells[idx] = { status: "item", type: k, itemId: id, dug: idx === dugIdx }; });
  renderPieceRows();
  recompute();
}
function clearItem(id) {
  state.cells.forEach((c, i) => { if (c.status === "item" && c.itemId === id) state.cells[i] = { status: "hidden", type: null, itemId: 0 }; });
  renderPieceRows();
  recompute();
}
function setDug(i, val) { state.cells[i].dug = val; recompute(); }

/* ---------- Wiring ---------- */
const markCustom = () => { $("#stageSelect").value = ""; };
$("#stageSelect").onchange = e => { if (e.target.value) loadStage(e.target.value); };
$("#gridSize").addEventListener("input", e => { $("#gridSizeEcho").textContent = e.target.value; markCustom(); saveBoard(); });
$("#pickPerTile").addEventListener("input", saveBoard);
$("#addPiece").onclick = () => { addPiece($("#newW").value, $("#newH").value, $("#newC").value); markCustom(); saveBoard(); };
$("#newGame").onclick = newGame;
$("#clearDigs").onclick = clearDigs;
$("#estimate").onclick = runEstimate;
$("#dpToggle").onchange = e => { try { localStorage.setItem("th.dp", e.target.checked ? "1" : "0"); } catch (_) {} recompute(); };
$("#bombToggle").onchange = e => {
  try { localStorage.setItem("th.bomb", e.target.checked ? "1" : "0"); } catch (_) {}
  if ($("#estimateOut").textContent.trim()) runEstimate();   // refresh a shown estimate
};

/* ---------- Translator credits ---------- */
// Add contributors here as { lang: "<native language name>", name: "<credit>", url: "<optional profile link>" }.
const TRANSLATORS = [
  { lang: "Français", name: "Kuraïbushi" },
];
function renderCredits() {
  const ul = $("#creditsList");
  if (!ul) return;
  ul.innerHTML = TRANSLATORS.map(c => {
    const who = c.url
      ? `<a href="${c.url}" target="_blank" rel="noopener" style="color:var(--accent)">${c.name}</a>`
      : c.name;
    return `<li><span style="color:var(--muted)">${c.lang}</span> &mdash; ${who}</li>`;
  }).join("");
}
const creditsDialog = $("#creditsDialog");
if (creditsDialog) {
  // showModal/close where supported; fall back to the open attribute on older engines.
  const openCredits = () => { renderCredits(); if (creditsDialog.showModal) creditsDialog.showModal(); else creditsDialog.setAttribute("open", ""); };
  const closeCredits = () => { if (creditsDialog.close) creditsDialog.close(); else creditsDialog.removeAttribute("open"); };
  $("#creditsLink").onclick = openCredits;
  $("#creditsClose").onclick = closeCredits;
  creditsDialog.addEventListener("click", e => { if (e.target === creditsDialog) closeCredits(); });
}
/* ---------- Patch notice ---------- */
// The game now picks each stage's treasures from one of several sets, so the per-stage
// presets were emptied (see STAGES). This says so once per browser and asks for the
// screenshots needed to rebuild them.
//
// The stored value is a version string rather than a flag: a later notice only has to
// change NOTICE_V to re-fire for everyone, which is exactly what bringing the presets
// back will want. Storage that throws (private mode, opaque origin, and jsdom's
// about:blank) counts as already seen. The no-treasures line in the status area carries
// the part you must not miss, and a modal on every single load would be worse.
const NOTICE_V = "presets-paused-2026-07";
const noticeSeen = () => { try { return localStorage.getItem("th.seenNotice") === NOTICE_V; } catch (_) { return true; } };
const markNoticeSeen = () => { try { localStorage.setItem("th.seenNotice", NOTICE_V); } catch (_) {} };
const noticeDialog = $("#noticeDialog");
function openNotice() {
  if (!noticeDialog) return;
  // showModal where supported; fall back to the open attribute on older engines (and jsdom).
  if (noticeDialog.showModal) { try { noticeDialog.showModal(); return; } catch (_) {} }
  noticeDialog.setAttribute("open", "");
}
function closeNotice() {
  if (!noticeDialog) return;
  markNoticeSeen();
  if (noticeDialog.close) noticeDialog.close(); else noticeDialog.removeAttribute("open");
}
if (noticeDialog) {
  $("#presetsLink").onclick = openNotice;
  $("#noticeClose").onclick = closeNotice;
  noticeDialog.addEventListener("click", e => { if (e.target === noticeDialog) closeNotice(); });
  noticeDialog.addEventListener("close", markNoticeSeen);   // Esc closes a <dialog> natively
}

const langPickerEl = $("#langPicker");
document.addEventListener("click", e => {
  if (!popEl.contains(e.target)) hidePop();
  if (langPickerEl && !langPickerEl.contains(e.target)) langPickerEl.open = false;
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  hidePop();
  if (langPickerEl) langPickerEl.open = false;
});

/* ---------- Boot ---------- */
LANG = detectLang();             // <html data-pinned-lang> -> localStorage["th.lang"] -> navigator -> "en"
// A locale URL is an explicit choice, the same as clicking the picker, so remember it. Without this
// the picker and the auto-detecting root would keep disagreeing with the page the user is reading.
if (document.documentElement.dataset.pinnedLang) {
  try { localStorage.setItem("th.lang", LANG); } catch (_) {}
}
initLangPicker();
// On a prerendered page this re-applies the language the HTML already shipped in, so there is nothing
// to repaint and no flash. On the root it is the auto-detect swap: English markup into the detected
// language, before the board is built.
applyStaticI18n();
try { $("#dpToggle").checked = (localStorage.getItem("th.dp") ?? "1") !== "0"; }
catch (_) { $("#dpToggle").checked = true; }   // default ON; persisted opt-out
try { $("#bombToggle").checked = (localStorage.getItem("th.bomb") ?? "0") !== "0"; }
catch (_) { $("#bombToggle").checked = false; }   // default OFF; persisted opt-in
renderQuickAdd();
populateStages();
if (!restoreBoard()) loadStage(1);   // last board from localStorage["th.board"], else Stage 1
if (!noticeSeen()) openNotice();     // the presets-are-paused notice, once per browser

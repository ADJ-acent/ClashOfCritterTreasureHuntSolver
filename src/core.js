"use strict"

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
    ? dimsLabel(state.pieces)
    : t("setup.noneYet");
  let out = t("setup.pickInfo", { pick, _n: +pick }) + "<br>" + list;
  // Say it on the stage itself: a board matching no option is not the player's mistake.
  const s = currentStage();
  if (s && s.partial) out += `<br><span class="warn">${t("setup.partialSets")}</span>`;
  el.innerHTML = out;
  renderSetRow(s);
}

// Switching sets afterwards is a plain dropdown next to the preset one. It only appears
// where there is more than one to switch between, so `partial` stages with a single known
// set don't get a one-option select.
function renderSetRow(s) {
  const row = $("#setRow"), sel = $("#setSelect");
  if (!row || !sel) return;
  sel.innerHTML = "";
  if (!s || s.sets.length < 2) { row.hidden = true; return; }
  row.hidden = false;
  s.sets.forEach((set, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = dimsLabel(setDims(set));
    sel.appendChild(o);
  });
  sel.value = String(Math.max(0, currentSet));
}
// Dropdown label. There used to be a "(no data)" marker for stages whose treasures
// weren't published; every stage ships at least one set now, and the ones with a gap
// in their set list say so through setup.partialSets instead.
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
// The stage the dropdown is on, or null when it says "(custom)".
const currentStage = () => ALL_STAGES.find(s => String(s.n) === $("#stageSelect").value) || null;
// Which of that stage's sets is loaded. -1 once the pieces have been edited by hand.
let currentSet = 0;

// A set as {w,h,count} in the same shape as state.pieces, merging same-size treasures
// the way the solver does. Everything a set is *shown* as goes through this: names are
// never displayed, so a set is its rectangles and nothing else.
function setDims(set) {
  const out = [];
  set.forEach(([name, count]) => {
    const [a, b] = sizeOf(name), w = Math.min(a, b), h = Math.max(a, b), k = key(w, h);
    const hit = out.find(p => key(p.w, p.h) === k);
    if (hit) hit.count += count; else out.push({ w, h, count });
  });
  return out;
}
// "1×2 (×2)". The count is bracketed off because 1×2×2 gives no way to tell which × is the
// shape and which is the tally. One formatter, so the chooser's per-shape labels and the
// stage info line can never drift apart.
const dimLabel = p => (p.count > 1 ? `${p.w}×${p.h} (×${p.count})` : `${p.w}×${p.h}`);
const dimsLabel = dims => dims.map(dimLabel).join(", ");

function populateStages() {
  const sel = $("#stageSelect");
  STAGES.forEach(s => {
    const o = document.createElement("option");
    o.value = s.n;
    o.textContent = stageLabel(s);
    sel.appendChild(o);
  });
}

// Ask rather than guess where there is a choice: silently loading set 0 would be wrong
// about half the time, and every probability on the board depends on it.
const needsSetDialog = s => !!s && (s.sets.length > 1 || !!s.partial);
// What the dropdown should read for the board actually loaded. Opening the chooser moves
// the dropdown before anything loads, so cancelling needs this to put it back.
let loadedStageValue = "";

function loadStage(n, setIdx) {
  const s = ALL_STAGES.find(s => s.n === +n);
  if (!s) return;
  currentSet = Math.min(Math.max(0, +setIdx || 0), s.sets.length - 1);
  state.pieces = [];
  s.sets[currentSet].forEach(([name, count]) => { const [w, h] = sizeOf(name); addPiece(w, h, count); });
  renderPieceRows();
  $("#gridSize").value = s.grid;
  $("#gridSizeEcho").textContent = s.grid;
  $("#pickPerTile").value = s.pick;
  $("#stageSelect").value = s.n;
  loadedStageValue = $("#stageSelect").value;   // "" for the hidden test-only stages
  renderStageInfo();   // dimensions only. Treasure names are not shown
  newGame();
}

// "None of these": the stage's grid and pickaxe cost, treasures left to the player. The
// escape hatch for an unrecorded set, and why the chooser opens on `partial` stages.
function loadStageCustom(s) {
  currentSet = -1;
  state.pieces = [];
  renderPieceRows();
  $("#gridSize").value = s.grid;
  $("#gridSizeEcho").textContent = s.grid;
  $("#pickPerTile").value = s.pick;
  $("#stageSelect").value = "";
  loadedStageValue = "";
  renderStageInfo();
  newGame();
}

/* ---------- Set chooser ---------- */
// One block per distinct size, each sitting directly above its own label, rather than N
// copies of a block over one combined dimension string: four 1×2 drawn four times is a wall
// of gold, and a single string underneath leaves you matching text to shapes by counting.
function setShapes(dims) {
  const box = document.createElement("span");
  box.className = "set-shapes";
  dims.forEach(p => {
    const piece = document.createElement("span");
    piece.className = "piece";
    const sh = document.createElement("span");
    sh.className = "shape";
    sh.style.gridTemplateColumns = `repeat(${p.w}, 1fr)`;
    for (let c = 0; c < p.w * p.h; c++) sh.appendChild(document.createElement("span"));
    const lbl = document.createElement("span");
    lbl.className = "plabel";
    lbl.textContent = dimLabel(p);
    piece.append(sh, lbl);
    box.appendChild(piece);
  });
  return box;
}

const setDialog = $("#setDialog");
// dialog.close() *queues* the close event, so a "put the dropdown back" handler can land
// after the chosen stage has loaded and undo it. This says the dialog was answered.
let setChoiceMade = false;
function closeSetDialog(chose) {
  setChoiceMade = !!chose;
  if (!setDialog) return;
  if (setDialog.close) setDialog.close(); else setDialog.removeAttribute("open");
}
function openSetDialog(s) {
  if (!setDialog || !s)   // no dialog in the DOM: fall back rather than load nothing
     { if (s) loadStage(s.n, 0); return; }
  const list = $("#setOptions");
  list.innerHTML = "";
  s.sets.forEach((set, i) => {
    const dims = setDims(set);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "set-opt" + (i === currentSet && String(s.n) === loadedStageValue ? " sel" : "");
    b.dataset.set = String(i);
    b.appendChild(setShapes(dims));
    b.onclick = () => { closeSetDialog(true); loadStage(s.n, i); };
    list.appendChild(b);
  });
  const custom = document.createElement("button");
  custom.type = "button";
  custom.className = "set-opt custom";
  custom.textContent = t("setDialog.custom");
  custom.onclick = () => { closeSetDialog(true); loadStageCustom(s); };
  list.appendChild(custom);

  setChoiceMade = false;
  const partial = $("#setPartial"), discord = $("#setDiscord");
  if (partial) partial.hidden = !s.partial;
  if (discord) discord.hidden = !s.partial;

  if (setDialog.showModal) { try { setDialog.showModal(); return; } catch (_) {} }
  setDialog.setAttribute("open", "");
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

// Which of this stage's sets does the saved board hold? Index, or -1 for none. Derived
// rather than saved, so it cannot drift from the pieces it describes; -1 makes the caller
// keep the board and relabel it "custom".
function stageSetOf(s, b) {
  if (+b.grid !== s.grid) return -1;
  return s.sets.findIndex(set => {
    const want = new Map();
    set.forEach(([name, count]) => {
      const k = key(...sizeOf(name));
      want.set(k, (want.get(k) || 0) + count);
    });
    if (want.size !== b.pieces.length) return false;
    return b.pieces.every(p => want.get(key(p.w, p.h)) === p.count);
  });
}

// Reload the last board. Returns false (leaving the app untouched, so the caller
// can fall back to a fresh stage) if nothing is saved or the blob doesn't check out.
function restoreBoard() {
  let b = null;
  try { b = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (_) { return false; }
  if (!validBoard(b)) return false;

  // No treasures and no digs: the save holds nothing. Browsers that used the app while the
  // presets were empty all have one of these, and the format is unchanged so it still
  // loads; restoring it would withhold the presets behind a blank "custom" board.
  if (!b.pieces.length && !b.cells.some(c => c.status !== "hidden")) return false;

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
  const idx = s ? stageSetOf(s, b) : -1;
  $("#stageSelect").value = idx >= 0 ? s.n : "";
  loadedStageValue = $("#stageSelect").value;
  currentSet = idx;

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


// Public compatibility surface for integrations and the test harness.
window.loadStage = loadStage;


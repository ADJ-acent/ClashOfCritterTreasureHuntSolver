"use strict"

let lastResult = null;

function recompute() {
  const res = solve();
  lastResult = res;
  const N = state.N;
  const cellsEl = gridEl.children;

  // Best tile(s) to dig next = highest-probability hidden tile (found treasures
  // are already revealed, so they're excluded). Ties (common, esp. by symmetry)
  // use the bounded one-step lookahead tie-breaker, which favors the tile with
  // the largest expected uncertainty reduction elsewhere. BEST_EPS folds
  // exact-fraction ties together while staying tight enough that Monte-Carlo
  // noise doesn't over-highlight.
  const BEST_EPS = 1e-6;
  let maxP = 0;
  if (res.total > 0) {
    for (let i = 0; i < N * N; i++) {
      if (state.cells[i].status !== "hidden") continue;
      const p = res.cover[i] / res.total;
      if (isFinite(p) && p > maxP) maxP = p;
    }
  }
  let bestTiles = new Set();
  if (maxP > 0) {
    for (let i = 0; i < N * N; i++) {
      if (state.cells[i].status !== "hidden") continue;
      const p = res.cover[i] / res.total;
      if (isFinite(p) && p >= maxP - BEST_EPS) bestTiles.add(i);
    }
    const lookedAhead = rankLookahead(res, [...bestTiles]);
    if (lookedAhead) bestTiles = lookedAhead;
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
      if (bestTiles.has(i)) {
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
  if (ev.shiftKey && c.status === "hidden") {
    setEmpty(i);
    hidePop();
    return;
  }
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
// Hand-edited pieces are no stage's set, so the label and the chooser go together.
const markCustom = () => { $("#stageSelect").value = ""; loadedStageValue = ""; currentSet = -1; renderStageInfo(); };
$("#stageSelect").onchange = e => {
  const v = e.target.value;
  if (!v) { markCustom(); return; }                  // "(custom)" chosen explicitly: keep the board
  const s = ALL_STAGES.find(x => String(x.n) === v);
  if (!s) return;
  // On mobile, opening the set dialog from inside this handler can leave the native
  // <select>'s own picker UI stuck open underneath it until the page is tapped elsewhere.
  // Blurring first dismisses that native picker before the dialog takes over.
  if (needsSetDialog(s)) { e.target.blur(); openSetDialog(s); } else loadStage(s.n, 0);
};
$("#setSelect").onchange = e => { const s = currentStage(); if (s) loadStage(s.n, +e.target.value); };
if (setDialog) {
  const cancel = () => { closeSetDialog(false); $("#stageSelect").value = loadedStageValue; };
  $("#setCancel").onclick = cancel;
  setDialog.addEventListener("click", e => { if (e.target === setDialog) cancel(); });
  // Esc closes a <dialog> natively; the dropdown must not keep pointing at a stage that
  // never loaded.
  setDialog.addEventListener("close", () => { if (!setChoiceMade) $("#stageSelect").value = loadedStageValue; });
}
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
// The game picks each stage's treasures from one of several sets, so a preset is a list
// of sets (see STAGES) and the stages with more than one get a picker. This dialog explains
// that; it no longer opens itself (all known sets are now collected), only from the setup
// panel's "Why can a stage have several sets?" link.
const noticeDialog = $("#noticeDialog");
function openNotice() {
  if (!noticeDialog) return;
  // showModal where supported; fall back to the open attribute on older engines (and jsdom).
  if (noticeDialog.showModal) { try { noticeDialog.showModal(); return; } catch (_) {} }
  noticeDialog.setAttribute("open", "");
}
function closeNotice() {
  if (!noticeDialog) return;
  if (noticeDialog.close) noticeDialog.close(); else noticeDialog.removeAttribute("open");
}
if (noticeDialog) {
  $("#presetsLink").onclick = openNotice;
  $("#noticeClose").onclick = closeNotice;
  noticeDialog.addEventListener("click", e => { if (e.target === noticeDialog) closeNotice(); });
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

// Public compatibility surface for integrations and the test harness.
window.inkFor = inkFor;

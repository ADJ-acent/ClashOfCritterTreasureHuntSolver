// Tests for the Treasure Hunt solver. Loads index.html in jsdom, drives the real
// DOM wiring, and asserts behaviour. Run with: npm test  (node --test)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// Boot a fresh page; collect any uncaught JS errors so tests can assert none.
function boot() {
  const errors = [];
  const { window } = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {
      if (!win.performance) win.performance = { now: () => Date.now() };
      win.addEventListener("error", e => errors.push(e.error ? e.error.stack : e.message));
    },
  });
  return { window, doc: window.document, errors };
}

const click = (win, el) =>
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));

function loadStage(win, doc, n) {
  const sel = doc.querySelector("#stageSelect");
  sel.value = String(n);
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
}

// Hidden stages aren't in the dropdown, so load them via the global loader directly.
const loadHidden = (win, n) => win.loadStage(n);

// jsdom has no matchMedia (=> desktop/hover flow by default). Call this to simulate
// a touch device: matchMedia matches both the no-hover and phone-width queries.
const setMobile = win => {
  win.matchMedia = q => ({ matches: /hover:\s*none/.test(q) || /max-width:\s*720px/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
};

const popButtons = doc => [...doc.querySelectorAll("#pop button")];
const cells = doc => [...doc.querySelector("#grid").children];

test("boots Stage 1 with a 5x5 grid and computed probabilities", () => {
  const { doc, errors } = boot();
  assert.strictEqual(errors.length, 0, errors.join("\n"));
  assert.strictEqual(cells(doc).length, 25);
  assert.match(cells(doc)[0].textContent, /%/);
  assert.match(doc.querySelector("#status").textContent, /Remaining to find/);
});

test("digging an empty tile marks it and recomputes", () => {
  const { window, doc, errors } = boot();
  click(window, cells(doc)[0]);
  const empty = popButtons(doc).find(b => /Empty/.test(b.textContent));
  assert.ok(empty, "Empty option should be offered");
  click(window, empty);
  assert.match(cells(doc)[0].className, /empty/);
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

// Regression: opening the placement submenu used to self-close the popover
// (the clicked button was detached by innerHTML rebuild, so the outside-click
// handler hid it). On desktop a single click on a placement commits it.
test("desktop: placement submenu stays open and a click places the treasure", () => {
  const { window, doc, errors } = boot();   // jsdom has no matchMedia -> desktop (hover) flow
  click(window, cells(doc)[0]);
  const sizeBtn = popButtons(doc).find(b => /1×3/.test(b.textContent));
  assert.ok(sizeBtn, "1×3 option should be offered");
  click(window, sizeBtn);

  const pop = doc.querySelector("#pop");
  assert.strictEqual(pop.style.display, "block", "popover must stay open after opening submenu");
  assert.ok(!popButtons(doc).some(b => /Place it/i.test(b.textContent)), "desktop has no separate Place-it button");

  const opt = popButtons(doc).find(b => /horizontal|vertical/.test(b.textContent));
  assert.ok(opt, "at least one placement option should be offered");
  click(window, opt); // desktop: a single click commits
  assert.strictEqual(cells(doc).filter(c => /\bitem\b/.test(c.className)).length, 3, "a 1×3 should mark 3 tiles");
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

test("mobile: placement is select-then-place (tap previews, Place it commits)", () => {
  const { window, doc } = boot();
  setMobile(window);
  click(window, cells(doc)[0]);
  click(window, popButtons(doc).find(b => /1×3/.test(b.textContent)));
  const opt = popButtons(doc).find(b => /horizontal|vertical/.test(b.textContent));
  assert.ok(opt, "a candidate should be offered");
  click(window, opt); // selects/previews only
  assert.strictEqual(cells(doc).filter(c => /\bitem\b/.test(c.className)).length, 0, "tapping a row must not commit");
  const place = popButtons(doc).find(b => /Place it/i.test(b.textContent));
  assert.ok(place, "a 'Place it' button should appear on touch");
  click(window, place);
  assert.strictEqual(cells(doc).filter(c => /\bitem\b/.test(c.className)).length, 3, "Place it commits the 3 tiles");
});

test("stage presets load grid size, treasures, and pickaxes-per-tile", () => {
  const { window, doc } = boot();
  assert.strictEqual(doc.querySelectorAll("#stageSelect option").length, 17, "custom + 16 stages (test stage is hidden)");

  loadStage(window, doc, 9);
  assert.strictEqual(doc.querySelector("#gridSize").value, "7");
  assert.strictEqual(doc.querySelector("#pickPerTile").value, "25");
  const rows9 = [...doc.querySelectorAll("#pieceRows tr")].map(r => r.textContent);
  assert.ok(rows9.some(t => /2×4/.test(t)), "Stage 9 includes a 2×4 Statue");

  loadStage(window, doc, 12);
  const rows12 = [...doc.querySelectorAll("#pieceRows tr")].map(r => r.textContent);
  assert.ok(rows12.some(t => /3×3/.test(t)), "Stage 12 includes a 3×3 Spaceship");
  assert.ok(rows12.some(t => /1×4/.test(t)), "Stage 12 includes a 1×4 Cyberlimb");
});

test("editing pieces switches the preset dropdown to custom", () => {
  const { window, doc } = boot();
  loadStage(window, doc, 7);
  assert.strictEqual(doc.querySelector("#stageSelect").value, "7");
  click(window, doc.querySelector("#quickAdd button")); // quick-add a piece
  assert.strictEqual(doc.querySelector("#stageSelect").value, "", "manual edit -> custom");
});

// Regression: finding a treasure isn't collecting it — every treasure tile must be
// dug out. Stage 1 = three 1×3 = 9 treasure tiles, so the estimate must be >= 9.
// (The old model counted ~1 dig per treasure and reported well under 9.)
test("pick-cost estimator counts every treasure tile, not one hit per treasure", async () => {
  const { window, doc, errors } = boot();
  loadStage(window, doc, 1); // three 1×3 = 9 treasure tiles
  click(window, doc.querySelector("#estimate"));
  await new Promise(r => setTimeout(r, 80)); // runEstimate defers compute via setTimeout

  const txt = doc.querySelector("#estimateOut").textContent;
  const tiles = parseFloat((txt.match(/([\d.]+) tiles/) || [])[1]);
  assert.ok(tiles >= 9, `mean tiles (${tiles}) must be >= 9 (all treasure tiles dug out)`);
  assert.match(txt, /pickaxes/);
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

test("estimator reports 'already found' when nothing remains", async () => {
  const { window, doc } = boot();
  loadHidden(window, -1); // hidden empty test stage (not shown in the dropdown)
  click(window, doc.querySelector("#estimate"));
  await new Promise(r => setTimeout(r, 80));
  assert.match(doc.querySelector("#estimateOut").textContent, /already found|0 picks/i);
});

test("highlights the best hidden tile(s) but never empties or found treasures", () => {
  const { window, doc } = boot(); // Stage 1: three 1×3 on a 5×5
  // At least one best tile is marked on a fresh board.
  assert.ok(cells(doc).some(c => /best/.test(c.className)), "a best tile should be highlighted");

  // Best tiles are the maximum-probability hidden tiles.
  const pct = el => parseFloat(el.textContent);
  const best = cells(doc).filter(c => /best/.test(c.className));
  const maxPct = Math.max(...cells(doc).filter(c => !/empty|item/.test(c.className)).map(pct));
  best.forEach(c => assert.ok(Math.abs(pct(c) - maxPct) < 0.6, "best tile is at (rounded) max probability"));

  // An empty test board has no treasures left -> nothing highlighted.
  loadHidden(window, -1);
  assert.strictEqual(cells(doc).filter(c => /best/.test(c.className)).length, 0, "no best tile when nothing remains");
});

// Helper: locate a treasure of the given size at a cell (clicks tile -> size -> first placement).
function placeTreasure(win, doc, cellIndex, sizeRe) {
  click(win, cells(doc)[cellIndex]);
  click(win, popButtons(doc).find(b => sizeRe.test(b.textContent)));
  click(win, popButtons(doc).find(b => /horizontal|vertical/.test(b.textContent))); // desktop: a click places it
}

test("locating a treasure digs the clicked tile and leaves the rest buried", () => {
  const { window, doc } = boot(); // Stage 1, 1×3
  placeTreasure(window, doc, 0, /1×3/);
  const item = cells(doc).filter(c => /\bitem\b/.test(c.className));
  assert.strictEqual(item.length, 3, "a 1×3 occupies 3 tiles");
  assert.strictEqual(item.filter(c => !/buried/.test(c.className)).length, 1, "only the clicked tile is dug");
  assert.strictEqual(item.filter(c => /buried/.test(c.className)).length, 2, "the other 2 tiles are buried");
});

test("a buried treasure tile can be toggled to dug out", () => {
  const { window, doc } = boot();
  placeTreasure(window, doc, 0, /1×3/);
  const buried = cells(doc).find(c => /buried/.test(c.className));
  click(window, buried);
  const markDug = popButtons(doc).find(b => /dug out/i.test(b.textContent));
  assert.ok(markDug, "clicking a buried tile offers 'Mark as dug out'");
  click(window, markDug);
  assert.ok(/\bitem\b/.test(buried.className) && !/buried/.test(buried.className), "tile is now dug out");
});

test("mobile placement picker shows a mini-diagram for each candidate", () => {
  const { window, doc } = boot();
  setMobile(window);
  click(window, cells(doc)[0]);
  click(window, popButtons(doc).find(b => /1×3/.test(b.textContent)));
  const minis = doc.querySelectorAll("#pop .mini").length;
  const cands = popButtons(doc).filter(b => /horizontal|vertical/.test(b.textContent)).length;
  assert.ok(cands > 0 && minis === cands, "every candidate row has its own mini-diagram");
});

test("desktop placement picker also shows mini-diagrams", () => {
  const { window, doc } = boot(); // no matchMedia -> desktop flow
  click(window, cells(doc)[0]);
  click(window, popButtons(doc).find(b => /1×3/.test(b.textContent)));
  const minis = doc.querySelectorAll("#pop .mini").length;
  const cands = popButtons(doc).filter(b => /horizontal|vertical/.test(b.textContent)).length;
  assert.ok(cands > 0 && minis === cands, "desktop rows have mini-diagrams too");
});

test("popover renders as a bottom sheet on small screens", () => {
  const { window, doc } = boot();
  setMobile(window);
  click(window, cells(doc)[0]); // opens the dig menu -> placePop()
  assert.ok(doc.querySelector("#pop").classList.contains("sheet"), "popover should be a bottom sheet on mobile");
});

test("DP toggle: exact on a dense stage where DFS bails, falls back to MC when off", () => {
  const { window, doc, errors } = boot();
  loadStage(window, doc, 13); // 7x7, ~556k layouts -> DFS bails (>EXACT_LEAF_BUDGET)
  const status = () => doc.querySelector("#status").textContent;
  // default ON -> exact via the profile DP (no Monte-Carlo sampling)
  assert.match(status(), /Exact over [\d,]+ layouts \(DP\)/);
  assert.strictEqual(errors.length, 0, errors.join("\n"));
  // OFF -> graceful fallback to the Monte-Carlo estimate
  const cb = doc.querySelector("#dpToggle");
  cb.checked = false;
  cb.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.match(status(), /Estimated from/);
  // back ON -> exact again
  cb.checked = true;
  cb.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.match(status(), /\(DP\)/);
});

// ---------- Localization (i18n) ----------
const setLang = (win, doc, L) => {
  const s = doc.querySelector("#langSelect");
  s.value = L;
  s.dispatchEvent(new win.Event("change", { bubbles: true }));
};

test("language selector lists all locales and defaults to English in jsdom", () => {
  const { doc } = boot();
  const sel = doc.querySelector("#langSelect");
  assert.ok(sel, "a language selector exists");
  assert.strictEqual(sel.querySelectorAll("option").length, 10, "10 UI languages");
  assert.strictEqual(sel.value, "en", "navigator en-US -> English default");
  assert.strictEqual(doc.documentElement.lang, "en");
});

test("switching language re-renders the UI; switching back restores English exactly", () => {
  const { window, doc, errors } = boot();
  setLang(window, doc, "ja");
  assert.strictEqual(doc.documentElement.lang, "ja", "<html lang> follows the choice");
  assert.match(doc.querySelector("h1").textContent, /確率ソルバー/, "static chrome translated");
  const ja = doc.querySelector("#status").textContent;
  assert.ok(!/Remaining to find/.test(ja), "status line no longer English");
  assert.match(ja, /発見すべき宝/, "status line translated (dynamic string)");
  // back to English: byte-identical to the original strings the other tests rely on
  setLang(window, doc, "en");
  assert.strictEqual(doc.querySelector("h1").textContent, "Clash of Critters Treasure Hunt Probability Solver");
  assert.match(doc.querySelector("#status").textContent, /Remaining to find/);
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

test("auto-detects the UI language from the browser, region-aware (zh-TW -> Traditional)", () => {
  const errors = [];
  const { window } = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {
      if (!win.performance) win.performance = { now: () => Date.now() };
      Object.defineProperty(win.navigator, "language", { value: "zh-TW", configurable: true });
      Object.defineProperty(win.navigator, "languages", { value: ["zh-TW"], configurable: true });
      win.addEventListener("error", e => errors.push(e.error ? e.error.stack : e.message));
    },
  });
  const doc = window.document;
  assert.strictEqual(doc.documentElement.lang, "zh-Hant", "zh-TW resolves to Traditional Chinese");
  assert.strictEqual(doc.querySelector("#langSelect").value, "zh-Hant");
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

test("treasure names are never shown — dimensions only", () => {
  const { window, doc } = boot();
  loadStage(window, doc, 1); // Stage 1 is a 1×3 treasure (formerly labelled "Zobo Cola")
  const info = doc.querySelector("#stageInfo").textContent;
  assert.match(info, /1×3/, "stage info lists the dimension");
  assert.ok(!/Zobo|Cola|Syringe|Radio|Statue|Spaceship|Cyberlimb/.test(info), "no treasure names leak into the UI");
  // the dig menu offers the size by dimension, with no name tooltip
  click(window, cells(doc)[0]);
  const opt = popButtons(doc).find(b => /1×3/.test(b.textContent));
  assert.ok(opt, "dig menu offers the 1×3 size");
  assert.strictEqual(opt.title, "", "size button carries no treasure-name tooltip");
});

test("language switch localizes the popover while keeping dimensions intact", () => {
  const { window, doc } = boot();
  setLang(window, doc, "ja");
  click(window, cells(doc)[0]);
  const labels = popButtons(doc).map(b => b.textContent);
  assert.ok(labels.some(t => /1×3/.test(t)), "the dimension survives translation");
  assert.ok(labels.some(t => /キャンセル/.test(t)), "popover chrome is translated");
});

test("footer has a localized feedback link to the Discord post", () => {
  const { window, doc } = boot();
  const feedback = () => [...doc.querySelectorAll("footer a")].find(a => /discord\.com/.test(a.href));
  const a = feedback();
  assert.ok(a, "a feedback link exists in the footer");
  assert.match(a.href, /discord\.com\/channels\/1343763804349267989\/1517044316177039502/);
  assert.match(a.getAttribute("rel") || "", /noopener/, "opens externally without leaking the opener");
  assert.strictEqual(a.target, "_blank");
  assert.match(a.textContent, /Feedback/, "English label by default");
  // localizes along with the rest of the UI (text + tooltip)
  setLang(window, doc, "ja");
  assert.match(feedback().textContent, /フィードバック/, "label translated");
  assert.ok(feedback().title.length > 0, "tooltip is set");
});

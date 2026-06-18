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
// handler hid it). It must stay open and let you mark the treasure.
test("marking a treasure via the placement submenu keeps the popover open and marks tiles", () => {
  const { window, doc, errors } = boot();
  click(window, cells(doc)[0]);
  const sizeBtn = popButtons(doc).find(b => /1×3/.test(b.textContent));
  assert.ok(sizeBtn, "1×3 option should be offered");
  click(window, sizeBtn);

  const pop = doc.querySelector("#pop");
  assert.strictEqual(pop.style.display, "block", "popover must stay open after opening submenu");

  const opt = popButtons(doc).find(b => /horizontal|vertical/.test(b.textContent));
  assert.ok(opt, "at least one placement option should be offered");
  click(window, opt);

  assert.strictEqual(cells(doc).filter(c => /item/.test(c.className)).length, 3, "a 1×3 should mark 3 tiles");
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

test("stage presets load grid size, treasures, and pickaxes-per-tile", () => {
  const { window, doc } = boot();
  assert.strictEqual(doc.querySelectorAll("#stageSelect option").length, 18, "custom + 17 stages");

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

test("pick-cost estimator returns at least one dig per treasure", async () => {
  const { window, doc, errors } = boot();
  loadStage(window, doc, 1); // three 1×3 treasures
  click(window, doc.querySelector("#estimate"));
  await new Promise(r => setTimeout(r, 80)); // runEstimate defers compute via setTimeout

  const txt = doc.querySelector("#estimateOut").textContent;
  const tiles = parseFloat((txt.match(/([\d.]+) tiles/) || [])[1]);
  assert.ok(tiles >= 3, `mean tiles (${tiles}) must be >= 3 treasures`);
  assert.match(txt, /pickaxes/);
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

test("estimator reports 'already found' when nothing remains", async () => {
  const { window, doc } = boot();
  // Custom empty stage: clear pieces, no treasures to find.
  loadStage(window, doc, 0); // Stage 0 has no treasures defined
  click(window, doc.querySelector("#estimate"));
  await new Promise(r => setTimeout(r, 80));
  assert.match(doc.querySelector("#estimateOut").textContent, /already found|0 picks/i);
});

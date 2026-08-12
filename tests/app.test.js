// Tests for the Treasure Hunt solver. Loads index.html in jsdom, drives the real
// DOM wiring, and asserts behaviour. Run with: npm test  (node --test)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");

// The app is index.html + three sibling assets (styles.css, i18n.js, app.js), loaded
// as classic <script src>/<link> so the page still runs over file://. jsdom's
// runScripts:"dangerously" does NOT fetch external scripts, and switching it to
// resources:"usable" would make every boot async. So we inline the scripts into the
// HTML in place instead: same order, and classic scripts have no other load semantics
// to preserve, so this is faithful and boot() stays synchronous. The stylesheet is
// dropped; jsdom never resolved the old inline <style> either, which is why the
// contrast test carries its own copy of the colours.
const inlineAssets = (html, dir) =>
  html
    .replace(/<script src="([^"]+)"><\/script>/g,
      (_, src) => "<script>" + fs.readFileSync(path.resolve(dir, src), "utf8") + "</script>")
    .replace(/<link rel="stylesheet"[^>]*>/g, "");

const HTML = inlineAssets(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), ROOT);

// Boot a fresh page; collect any uncaught JS errors so tests can assert none.
// jsdom serves index.html from about:blank, an opaque origin with no localStorage,
// so by default the app's persistence is a no-op and every boot starts clean. Pass
// a storage shim (see makeStorage) to exercise it, reusing one across two boots to
// simulate a refresh.
function boot({ storage, html = HTML } = {}) {
  const errors = [];
  const { window } = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {
      if (!win.performance) win.performance = { now: () => Date.now() };
      // Own property, to shadow the throwing/absent prototype accessor.
      if (storage) Object.defineProperty(win, "localStorage", { value: storage, configurable: true });
      win.addEventListener("error", e => errors.push(e.error ? e.error.stack : e.message));
    },
  });
  return { window, doc: window.document, errors };
}

// Minimal in-memory Storage. Survives across boot() calls, like a real refresh.
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    clear: () => map.clear(),
  };
}

const click = (win, el) =>
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));

const setDialogOpen = doc => doc.querySelector("#setDialog").hasAttribute("open");
const setOptions = doc => [...doc.querySelectorAll("#setOptions .set-opt")];
// The chooser's last option is always "none of these, I'll enter them myself".
const pickSet = (win, doc, i) => {
  const opts = setOptions(doc);
  click(win, i === "custom" ? opts[opts.length - 1] : opts[i]);
};

// Selecting a stage with a choice to make opens the chooser rather than loading anything,
// so the helper answers it. Pass `i` to take a set other than the first, or "custom".
function loadStage(win, doc, n, i = 0) {
  const sel = doc.querySelector("#stageSelect");
  sel.value = String(n);
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  if (setDialogOpen(doc)) pickSet(win, doc, i);
}

// Loads a fixture stage through the global loader, which is also how the two negative
// test-only stages (not in the dropdown) get in.
const loadFix = (win, n) => win.loadStage(n);

// Fixture boards. Most are real stages, loaded at their first set: a preset ships the
// stage's treasures again. The two negative ones are boards no stage provides, an empty
// setup and a single 1×2. FIX.s1 (three 1×3 on a 5×5) is the default, since most tests
// just need "a board with treasures on it".
const FIX = { empty: -1, one: -2, s1: 1, s5: 5, s9: 9, s12: 12, s13: 13, s15: 15, s22: 22 };
const bootPlaying = opts => { const b = boot(opts); loadFix(b.window, FIX.s1); return b; };

// jsdom has no matchMedia (=> desktop/hover flow by default). Call this to simulate
// a touch device: matchMedia matches both the no-hover and phone-width queries.
const setMobile = win => {
  win.matchMedia = q => ({ matches: /hover:\s*none/.test(q) || /max-width:\s*720px/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
};

const popButtons = doc => [...doc.querySelectorAll("#pop button")];
const cells = doc => [...doc.querySelector("#grid").children];

test("boots Stage 1 as a 5x5 board carrying the stage's first treasure set", () => {
  const { doc, errors } = boot();
  assert.strictEqual(errors.length, 0, errors.join("\n"));
  assert.strictEqual(cells(doc).length, 25);
  // A preset ships the stage's treasures, so a fresh board already has something to solve.
  const status = doc.querySelector("#status");
  assert.match(status.textContent, /Remaining to find/);
  const rows = [...doc.querySelectorAll("#pieceRows tr")].map(r => r.textContent).join(" ");
  assert.match(rows, /1×3/, "Stage 1's first set is three 1×3");
});

test("a board with treasures computes probabilities", () => {
  const { doc, errors } = bootPlaying();
  assert.strictEqual(errors.length, 0, errors.join("\n"));
  assert.match(cells(doc)[0].textContent, /%/);
  assert.match(doc.querySelector("#status").textContent, /Remaining to find/);
});

// A board with no treasures is no longer the default, but it is still reachable (delete
// every piece, or a custom board), and "Remaining to find: none" would read as "you're
// done" on an untouched board. So the status line becomes the prompt to enter them.
test("a board with no treasures asks for them, and clears as soon as one is added", () => {
  const { window, doc } = boot();
  loadFix(window, FIX.empty);
  const status = doc.querySelector("#status");
  assert.match(status.textContent, /Add this stage's treasures/);
  assert.ok(!/Remaining to find/.test(status.textContent), "nothing to solve yet");
  // Both arrows ship; the 720px breakpoint shows ← (controls are the left column) or
  // ↓ (controls sit below the board), so the copy stays one string.
  assert.ok(status.querySelector(".point-left") && status.querySelector(".point-down"),
    "the notice points at the setup panel both ways");
  click(window, doc.querySelector("#quickAdd button"));   // quick-add any size
  click(window, doc.querySelector("#newGame"));
  assert.match(status.textContent, /Remaining to find/, "back to the solver line");
});

test("digging an empty tile marks it and recomputes", () => {
  const { window, doc, errors } = bootPlaying();
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
  const { window, doc, errors } = bootPlaying();   // jsdom has no matchMedia -> desktop (hover) flow
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
  const { window, doc } = bootPlaying();
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

// The patch ("a set of treasures will be selected at random from several sets") means a
// preset is a list of sets rather than one list. It loads the first, and the stages with
// more than one offer a picker.
test("stage presets load the grid, the pickaxes, and the stage's first treasure set", () => {
  const { window, doc } = boot();
  assert.strictEqual(doc.querySelectorAll("#stageSelect option").length, 25, "custom + 24 stages (test stages are hidden)");

  loadStage(window, doc, 9);
  assert.strictEqual(doc.querySelector("#gridSize").value, "7");
  assert.strictEqual(doc.querySelector("#pickPerTile").value, "25");
  assert.strictEqual(cells(doc).length, 49, "board built at the preset's size");
  assert.match(doc.querySelector("#stageInfo").textContent, /1×2 \(×2\), 2×2 \(×2\), 2×4/);

  // The "(no data)" marker used to flag stages with unpublished treasures. Every stage
  // has at least one set now, and the ones with a gap say so on the stage info line.
  const labels = [...doc.querySelectorAll("#stageSelect option")].map(o => o.textContent).join(" ");
  assert.ok(!/no data/.test(labels), "no per-option marker when it would be universal");
});

// 37 sets, all entered by hand. A typo that made one unplaceable would
// render the whole board as "?" for whoever picked it, and a stage holding the same set
// twice would give the picker two identical labels. Nothing else here would notice either.
test("every treasure set fits its board, and no stage lists one twice", () => {
  const { window: win } = boot();
  const report = JSON.parse(win.eval(`(() => {
    const bad = [], dup = [];
    let sets = 0;
    STAGES.forEach(s => {
      const seen = new Set();
      s.sets.forEach((set, i) => {
        sets++;
        loadStage(s.n, i);
        if (!lastResult || lastResult.total <= 0) bad.push("stage " + s.n + " set " + (i + 1));
        const label = dimsLabel(setDims(set));
        if (seen.has(label)) dup.push("stage " + s.n + " set " + (i + 1));
        seen.add(label);
      });
    });
    return JSON.stringify({ bad, dup, sets });
  })()`));
  assert.deepStrictEqual(report.bad, [], "every set has at least one valid layout");
  assert.deepStrictEqual(report.dup, [], "a repeated set would be indistinguishable in the picker");
  assert.strictEqual(report.sets, 37, "24 stages, 37 distinct sets");
});

// Loading a set silently would be a guess, and every probability on the board depends on
// it, so stages with a choice ask. The 15 single-set stages just load.
test("the set chooser opens only where a stage has a choice to make", () => {
  const { window, doc } = boot();
  const sel = doc.querySelector("#stageSelect");
  const pick = n => { sel.value = String(n); sel.dispatchEvent(new window.Event("change", { bubbles: true })); };

  pick(13);                       // one set, no gap: loads straight away
  assert.ok(!setDialogOpen(doc), "no dialog on a single-set stage");
  assert.match(doc.querySelector("#stageInfo").textContent, /2×4 \(×2\)/, "loaded it directly");
  assert.ok(doc.querySelector("#setRow").hidden, "and nothing to switch between");

  pick(9);                        // two sets: asks
  assert.ok(setDialogOpen(doc), "dialog on a multi-set stage");
  const labels = o => [...o.querySelectorAll(".plabel")].map(l => l.textContent);
  assert.deepStrictEqual(
    setOptions(doc).slice(0, -1).map(o => labels(o).join(", ")),
    ["1×2 (×2), 2×2 (×2), 2×4", "1×2 (×2), 1×4 (×2), 2×4"],
    "options are dimensions, never treasure names");
  // One block per distinct size, each with its own label under it, not N copies of a block
  // over one combined string.
  const first = setOptions(doc)[0];
  assert.strictEqual(first.querySelectorAll(".set-shapes .piece").length, 3, "1×2, 2×2, 2×4");
  assert.deepStrictEqual(labels(first), ["1×2 (×2)", "2×2 (×2)", "2×4"],
    "counted per shape, and the lone 2×4 carries no ×1");
  assert.strictEqual(first.querySelectorAll(".piece")[0].querySelectorAll(".shape span").length, 2,
    "the 1×2 block is drawn once, at 2 cells");

  pickSet(window, doc, 1);
  assert.ok(!setDialogOpen(doc), "closes on choosing");
  const info = doc.querySelector("#stageInfo").textContent;
  assert.match(info, /1×4 \(×2\)/, "the second set's 1×4 pair is loaded");
  assert.ok(!/2×2 \(×2\)/.test(info), "and the first set's 2×2 pair is gone");
  assert.strictEqual(sel.value, "9", "still on Stage 9");
  // A dropdown next to the preset one switches sets afterwards, without the dialog.
  const setSel = doc.querySelector("#setSelect");
  assert.ok(!doc.querySelector("#setRow").hidden, "the set dropdown is up");
  assert.strictEqual(setSel.value, "1", "showing the set actually loaded");
  setSel.value = "0";
  setSel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.ok(!setDialogOpen(doc), "switching does not reopen the dialog");
  assert.match(doc.querySelector("#stageInfo").textContent, /2×2 \(×2\)/, "back on the first set");
});

// Nothing loads until the choice is answered, so backing out must not leave the dropdown
// advertising a stage that never arrived.
test("cancelling the chooser puts the dropdown back and keeps the board", () => {
  const { window, doc } = boot();     // boots Stage 1 at its first set
  loadStage(window, doc, 13);         // a single-set stage, loaded for real
  const sel = doc.querySelector("#stageSelect");

  sel.value = "9";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.ok(setDialogOpen(doc), "asking");
  click(window, doc.querySelector("#setCancel"));

  assert.ok(!setDialogOpen(doc), "closed");
  assert.strictEqual(sel.value, "13", "dropdown back on the stage actually loaded");
  assert.match(doc.querySelector("#stageInfo").textContent, /2×4 \(×2\)/, "Stage 13's board is untouched");
});

// The escape hatch for a set nobody has recorded: take the grid and the pickaxe cost,
// leave the treasures to the player.
test("'none of these' keeps the stage's grid and pickaxes but no treasures", () => {
  const { window, doc } = boot();
  loadStage(window, doc, 9, "custom");

  assert.strictEqual(doc.querySelector("#stageSelect").value, "", "no set means no stage label");
  assert.strictEqual(doc.querySelector("#gridSize").value, "7", "grid came from the stage");
  assert.strictEqual(doc.querySelector("#pickPerTile").value, "25", "so did the pickaxe cost");
  assert.strictEqual(cells(doc).length, 49);
  assert.match(doc.querySelector("#status").textContent, /Add this stage's treasures/);
});

// The picker hides itself with the `hidden` attribute, and that is not self-evidently
// enough: the UA stylesheet's [hidden] { display: none } loses to *any* author `display`,
// and #setRow is a .row, which is display:flex. It shipped rendering as an empty box on
// all 16 single-set stages. Nothing driving the DOM here can see it, because boot() drops
// the stylesheet, so the file itself is what has to be asserted on.
test("hidden elements really are hidden, whatever else styles them", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    "styles.css must force display:none on [hidden]; .row's display:flex outranks the UA rule");
});

// One set is still missing (stage 9), so that stage says so rather than implying its list
// is exhaustive. Stage 8 was the other one until a player screenshot filled it in, so the
// other half of this is that a stage stops warning once its gap is closed.
test("a stage with an unrecorded set says so, and a filled-in one stops", () => {
  const { window, doc } = boot();
  loadStage(window, doc, 9);
  assert.match(doc.querySelector("#stageInfo").textContent, /isn't recorded yet/);
  loadStage(window, doc, 13);
  assert.ok(!/isn't recorded yet/.test(doc.querySelector("#stageInfo").textContent),
    "only on the stages with a known gap");

  // The chooser says it too, since "none of these" is the way out of a set nobody recorded.
  const sel = doc.querySelector("#stageSelect");
  const pick = n => { sel.value = String(n); sel.dispatchEvent(new window.Event("change", { bubbles: true })); };
  pick(9);
  assert.ok(setDialogOpen(doc), "asking");
  assert.strictEqual(setOptions(doc).length, 3, "its two known sets, plus 'none of these'");
  assert.ok(!doc.querySelector("#setPartial").hidden, "and says a set is missing");
  assert.ok(!doc.querySelector("#setDiscord").hidden, "with the screenshot ask");
  click(window, doc.querySelector("#setCancel"));

  // Stage 8's second set (1×3 ×3 + 3×3) is recorded now: two real options, no warning.
  pick(8);
  assert.strictEqual(setOptions(doc).length, 3, "both sets, plus 'none of these'");
  assert.ok(doc.querySelector("#setPartial").hidden, "nothing left to record on stage 8");
  assert.ok(doc.querySelector("#setDiscord").hidden, "so no screenshot ask either");
  pickSet(window, doc, 1);
  assert.match(doc.querySelector("#stageInfo").textContent, /1×3 \(×3\), 3×3/, "the new set loads");
  assert.ok(!/isn't recorded yet/.test(doc.querySelector("#stageInfo").textContent), "and says nothing is missing");
  assert.ok(!doc.querySelector("#setRow").hidden, "with two sets to switch between");
});

// The notice explains that a stage draws from several sets and how the picker works,
// asks for screenshots of the set still missing, and the setup panel can reopen it.
test("the patch notice opens once per browser, and the setup link reopens it", () => {
  const storage = makeStorage();
  const dlg = doc => doc.querySelector("#noticeDialog");

  // First visit: it opens by itself. (jsdom has no showModal, so this is the
  // open-attribute fallback path, same as an old engine.)
  const first = boot({ storage });
  assert.ok(dlg(first.doc).hasAttribute("open"), "shown on a first visit");
  assert.match(dlg(first.doc).textContent, /set of treasures will be selected at random/, "quotes the patch notes");
  assert.match(dlg(first.doc).textContent, /screenshot/i, "asks for screenshots");
  const discord = dlg(first.doc).querySelector("a[href*='discord.com']");
  assert.ok(discord, "links to the Discord channel");
  assert.match(discord.href, /discord\.com\/channels\/1343763804349267989\/1517044316177039502/);
  assert.match(discord.getAttribute("rel") || "", /noopener/);

  click(first.window, first.doc.querySelector("#noticeClose"));
  assert.ok(!dlg(first.doc).hasAttribute("open"), "dismissed");
  assert.strictEqual(storage.getItem("th.seenNotice"), "presets-back-2026-08", "remembered by version");

  // Second visit: not shown again, but still one click away.
  const second = boot({ storage });
  assert.ok(!dlg(second.doc).hasAttribute("open"), "not shown twice");
  click(second.window, second.doc.querySelector("#presetsLink"));
  assert.ok(dlg(second.doc).hasAttribute("open"), "the setup-panel link reopens it");
  assert.strictEqual(second.errors.length, 0, second.errors.join("\n"));
});

// Storage that throws (private mode, opaque origin) must not mean a modal on every load.
test("the patch notice stays shut when localStorage is unavailable", () => {
  const { doc, errors } = boot();   // jsdom's about:blank has no localStorage
  assert.ok(!doc.querySelector("#noticeDialog").hasAttribute("open"), "no storage -> treated as seen");
  assert.strictEqual(errors.length, 0, errors.join("\n"));
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
  loadFix(window, FIX.s1); // three 1×3 = 9 treasure tiles
  click(window, doc.querySelector("#estimate"));
  await new Promise(r => setTimeout(r, 80)); // runEstimate defers compute via setTimeout

  const txt = doc.querySelector("#estimateOut").textContent;
  const digs = parseFloat((txt.match(/(\d+) digs/) || [])[1]);
  assert.ok(digs >= 9, `mean digs (${digs}) must be >= 9 (all treasure tiles dug out)`);
  assert.match(txt, /pickaxes/);
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

test("estimator reports nothing left when every treasure is dug out", async () => {
  const { window, doc } = boot();
  loadFix(window, FIX.one);   // a single 1×2, so the board can be finished in two clicks
  placeTreasure(window, doc, 0, /1×2/);
  click(window, cells(doc).find(c => /buried/.test(c.className)));
  click(window, popButtons(doc).find(b => /dug out/i.test(b.textContent)));

  click(window, doc.querySelector("#estimate"));
  await new Promise(r => setTimeout(r, 80));
  assert.match(doc.querySelector("#estimateOut").textContent, /already found|0 picks/i);
});

// An empty setup is not a finished board. estimateSolve() would call it "done"
// (nothing left to find), which is wrong for someone who has cleared the pieces out
// to enter their own.
test("the estimator asks for treasures instead of calling an empty board finished", async () => {
  const { window, doc } = boot();
  loadFix(window, FIX.empty);
  click(window, doc.querySelector("#estimate"));
  await new Promise(r => setTimeout(r, 80));
  const out = doc.querySelector("#estimateOut").textContent;
  assert.match(out, /Add this stage's treasures/);
  assert.ok(!/0 picks/.test(out), "an untouched board is not 'finished'");
});

test("highlights the best hidden tile(s) but never empties or found treasures", () => {
  const { window, doc } = bootPlaying(); // three 1×3 on a 5×5
  // At least one best tile is marked on a fresh board.
  assert.ok(cells(doc).some(c => /best/.test(c.className)), "a best tile should be highlighted");

  // Best tiles are the maximum-probability hidden tiles.
  const pct = el => parseFloat(el.textContent);
  const best = cells(doc).filter(c => /best/.test(c.className));
  const maxPct = Math.max(...cells(doc).filter(c => !/empty|item/.test(c.className)).map(pct));
  best.forEach(c => assert.ok(Math.abs(pct(c) - maxPct) < 0.6, "best tile is at (rounded) max probability"));

  // An empty test board has no treasures left -> nothing highlighted.
  loadFix(window, FIX.empty);
  assert.strictEqual(cells(doc).filter(c => /best/.test(c.className)).length, 0, "no best tile when nothing remains");
});

// Helper: locate a treasure of the given size at a cell (clicks tile -> size -> first placement).
function placeTreasure(win, doc, cellIndex, sizeRe) {
  click(win, cells(doc)[cellIndex]);
  click(win, popButtons(doc).find(b => sizeRe.test(b.textContent)));
  click(win, popButtons(doc).find(b => /horizontal|vertical/.test(b.textContent))); // desktop: a click places it
}

test("locating a treasure digs the clicked tile and leaves the rest buried", () => {
  const { window, doc } = bootPlaying(); // 1×3
  placeTreasure(window, doc, 0, /1×3/);
  const item = cells(doc).filter(c => /\bitem\b/.test(c.className));
  assert.strictEqual(item.length, 3, "a 1×3 occupies 3 tiles");
  assert.strictEqual(item.filter(c => !/buried/.test(c.className)).length, 1, "only the clicked tile is dug");
  assert.strictEqual(item.filter(c => /buried/.test(c.className)).length, 2, "the other 2 tiles are buried");
});

test("a buried treasure tile can be toggled to dug out", () => {
  const { window, doc } = bootPlaying();
  placeTreasure(window, doc, 0, /1×3/);
  const buried = cells(doc).find(c => /buried/.test(c.className));
  click(window, buried);
  const markDug = popButtons(doc).find(b => /dug out/i.test(b.textContent));
  assert.ok(markDug, "clicking a buried tile offers 'Mark as dug out'");
  click(window, markDug);
  assert.ok(/\bitem\b/.test(buried.className) && !/buried/.test(buried.className), "tile is now dug out");
});

test("mobile placement picker shows a mini-diagram for each candidate", () => {
  const { window, doc } = bootPlaying();
  setMobile(window);
  click(window, cells(doc)[0]);
  click(window, popButtons(doc).find(b => /1×3/.test(b.textContent)));
  const minis = doc.querySelectorAll("#pop .mini").length;
  const cands = popButtons(doc).filter(b => /horizontal|vertical/.test(b.textContent)).length;
  assert.ok(cands > 0 && minis === cands, "every candidate row has its own mini-diagram");
});

test("desktop placement picker also shows mini-diagrams", () => {
  const { window, doc } = bootPlaying(); // no matchMedia -> desktop flow
  click(window, cells(doc)[0]);
  click(window, popButtons(doc).find(b => /1×3/.test(b.textContent)));
  const minis = doc.querySelectorAll("#pop .mini").length;
  const cands = popButtons(doc).filter(b => /horizontal|vertical/.test(b.textContent)).length;
  assert.ok(cands > 0 && minis === cands, "desktop rows have mini-diagrams too");
});

test("popover renders as a bottom sheet on small screens", () => {
  const { window, doc } = bootPlaying();
  setMobile(window);
  click(window, cells(doc)[0]); // opens the dig menu -> placePop()
  assert.ok(doc.querySelector("#pop").classList.contains("sheet"), "popover should be a bottom sheet on mobile");
});

test("DP toggle: exact on a dense stage where DFS bails, falls back to MC when off", () => {
  const { window, doc, errors } = boot();
  loadFix(window, FIX.s13); // 7x7, ~556k layouts -> DFS bails (>EXACT_LEAF_BUDGET)
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

// Three of the game's 48 bomb-weight tables deviate from the standard one, and which a
// board draws on is invisible in the UI, so a wrong mapping would quietly bias the bomb
// estimate with nothing on screen to contradict it. The total matters as much as the
// weight: it used to be hardcoded to 10000, which would turn every roll past the end of
// an 8000-weight table into a 0, i.e. fewer bombs exactly where the deviation grants more.
test("the deviating bomb weights are picked up by stage and set", () => {
  const { window, doc } = boot();
  const table = (n, i) => {
    window.loadStage(n, i);
    return window.eval("useBombTable(); bombDist[0][1] + '/' + bombTotal");
  };
  assert.strictEqual(table(6, 1), "2000/8000", "stage 6's second set deviates");
  assert.strictEqual(table(7, 1), "2000/8000", "stage 7's second set deviates");
  assert.strictEqual(table(6, 0), "4000/10000", "stage 6's first set is standard");
  assert.strictEqual(table(7, 2), "4000/10000", "stage 7's third set is standard");
  assert.strictEqual(table(9, 1), "4000/10000", "a second set elsewhere is standard");

  // A hand-edited board is no stage's set, so it cannot inherit a deviation.
  click(window, doc.querySelector("#quickAdd button"));
  assert.strictEqual(window.eval("useBombTable(); bombDist[0][1] + '/' + bombTotal"),
    "4000/10000", "custom board falls back to the standard table");
});

// Bombs collect tiles for free, so the bomb-aware estimate is below the conservative
// one, and the detail line flips from "ignores bombs" to "assumes bombs".
test("bomb toggle lowers the estimate and relabels it", async () => {
  const { window, doc, errors } = boot();
  loadFix(window, FIX.s1); // three 1×3 = 9 treasure tiles on 5×5

  // default OFF: the conservative estimate that ignores bombs
  click(window, doc.querySelector("#estimate"));
  await new Promise(r => setTimeout(r, 80));
  const offTxt = doc.querySelector("#estimateOut").textContent;
  const picksOff = parseInt((offTxt.match(/([\d,]+) pickaxes/) || [])[1].replace(/,/g, ""), 10);
  assert.match(offTxt, /excludes bombs/);

  // ON: fewer picks (free bomb collection), and the label flips
  const cb = doc.querySelector("#bombToggle");
  cb.checked = true;
  cb.dispatchEvent(new window.Event("change", { bubbles: true }));
  click(window, doc.querySelector("#estimate"));
  await new Promise(r => setTimeout(r, 80));
  const onTxt = doc.querySelector("#estimateOut").textContent;
  const picksOn = parseInt((onTxt.match(/([\d,]+) pickaxes/) || [])[1].replace(/,/g, ""), 10);
  assert.match(onTxt, /includes bombs/);

  assert.ok(picksOn < picksOff, `bomb estimate (${picksOn}) should be below the no-bomb one (${picksOff})`);
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

// ---------- Localization (i18n) ----------
// Choosing a language is a navigation to that locale's URL, not an in-place swap, so a
// "switch to Japanese" in a test means booting the prerendered ja/index.html. Its assets
// sit one level up, which path.resolve against the locale dir handles.
const localeHtml = code =>
  inlineAssets(fs.readFileSync(path.join(ROOT, code, "index.html"), "utf8"), path.join(ROOT, code));
const bootLocale = (code, opts) => boot({ ...opts, html: localeHtml(code) });

test("language picker offers every locale as a real link to its own URL", () => {
  const { window, doc } = boot();
  const langs = window.eval("JSON.stringify(LANGS)");
  const LANGS = JSON.parse(langs);
  assert.strictEqual(LANGS.length, 16, "16 UI languages");
  assert.strictEqual(window.eval("Object.keys(I18N).length"), 16);

  const links = [...doc.querySelectorAll("#langMenu a[data-lang]")];
  assert.strictEqual(links.length, LANGS.length, "every locale is offered in the picker");
  // Real anchors, not a <select>: this is how the locale pages get crawled at all.
  LANGS.forEach(([code, autonym], i) => {
    assert.strictEqual(links[i].dataset.lang, code, "picker follows LANGS order");
    assert.strictEqual(links[i].textContent, autonym, `${code} is listed under its own name`);
    // jsdom has no location.protocol === "file:", so the hrefs stay in their clean form.
    assert.strictEqual(links[i].getAttribute("href"), code === "en" ? "./" : code + "/");
  });

  assert.strictEqual(doc.documentElement.lang, "en", "navigator en-US -> English default");
  assert.strictEqual(doc.querySelector("#langCurrent").textContent, "English");
  assert.strictEqual(doc.querySelector('#langMenu a[data-lang="en"]').getAttribute("aria-current"), "true");
});

test("every locale defines the full English key set, plurals included", () => {
  const { window } = boot();
  const gaps = window.eval(`(() => {
    const out = [];
    for (const [loc, table] of Object.entries(I18N)) {
      for (const [k, en] of Object.entries(I18N.en)) {
        const v = table[k];
        if (v == null) { out.push(loc + " missing " + k); continue; }
        // A plural entry in English must stay a plural entry, and every locale
        // needs at least "other" — pluralForm() falls back to it.
        if (typeof en === "object" && (typeof v !== "object" || v.other == null)) out.push(loc + " bad plural " + k);
      }
    }
    return out.join(", ");
  })()`);
  assert.strictEqual(gaps, "", "no locale is missing a key");
});

test("a prerendered locale page boots in its language, static chrome and dynamic strings alike", () => {
  const { window, doc, errors } = bootLocale("ja");
  assert.strictEqual(doc.documentElement.lang, "ja");
  assert.match(doc.querySelector("h1").textContent, /確率ソルバー/, "static chrome");
  // A preset ships no treasures, so a fresh board's status line is the notice.
  assert.ok(!/Add this stage's treasures/.test(doc.querySelector("#status").textContent),
    "the no-treasures notice is translated too");
  loadFix(window, FIX.s1);   // a board with something to solve -> the solver line
  const ja = doc.querySelector("#status").textContent;
  assert.ok(!/Remaining to find/.test(ja), "status line is not English");
  assert.match(ja, /発見すべき宝/, "status line translated (built by t() at runtime)");
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

test("the English root keeps its strings byte-identical (the other tests assert on them)", () => {
  const { window, doc } = boot();
  assert.strictEqual(doc.querySelector("h1").textContent, "Clash of Critters Treasure Hunt Probability Solver");
  assert.match(doc.querySelector("#status").textContent, /Remaining to find: 1×3 \(3 left\)\./);
  loadFix(window, FIX.empty);
  assert.match(doc.querySelector("#status").textContent, /Add this stage's treasures in the setup panel\./);
});

// The case that would feel broken if nobody thought about it: someone who picked Italian
// last week clicks a Thai search result. The URL is an explicit choice and wins, so the page
// they land on is the page they clicked. It must not paint Thai and then flip to Italian.
test("a locale URL outranks a stored preference, and adopts it", () => {
  const storage = makeStorage({ "th.lang": "it" });
  const { doc, errors } = bootLocale("th", { storage });
  assert.strictEqual(doc.documentElement.lang, "th", "the URL wins over localStorage");
  assert.match(doc.querySelector("h1").textContent, /ล่าขุมทรัพย์/, "renders Thai, not Italian");
  assert.strictEqual(storage.getItem("th.lang"), "th", "and the choice sticks for the root later");
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

// The flip side, and the requirement that drove the whole design: the root still auto-detects.
test("the root still auto-detects, so a German visitor lands on German", () => {
  const { window } = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(win) {
      if (!win.performance) win.performance = { now: () => Date.now() };
      Object.defineProperty(win.navigator, "languages", { value: ["de-AT", "de"], configurable: true });
    },
  });
  const doc = window.document;
  assert.strictEqual(doc.documentElement.lang, "de", "no pin, no stored choice -> browser language");
  assert.match(doc.querySelector("h1").textContent, /Wahrscheinlichkeits/, "chrome swapped in place, no redirect");
  assert.strictEqual(doc.querySelector("#langCurrent").textContent, "Deutsch", "picker agrees");
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
  assert.strictEqual(doc.querySelector("#langCurrent").textContent, "繁體中文");
  assert.strictEqual(errors.length, 0, errors.join("\n"));
});

test("treasure names are never shown — dimensions only", () => {
  const { window, doc } = boot();
  loadFix(window, FIX.s1); // three 1×3 treasures (formerly labelled "Zobo Cola")
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
  const { window, doc } = bootLocale("ja");
  loadFix(window, FIX.s1);
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
  const ja = bootLocale("ja").doc;
  const jaLink = [...ja.querySelectorAll("footer a")].find(x => /discord\.com/.test(x.href));
  assert.match(jaLink.textContent, /フィードバック/, "label translated");
  assert.ok(jaLink.title.length > 0, "tooltip is set");
});

/* ---------- Persistence (localStorage["th.board"]) ---------- */

test("the board survives a refresh: treasures, digs and located treasures all come back", () => {
  const storage = makeStorage();

  // First visit: a board with treasures, dig an empty tile, locate a 1×3.
  {
    const { window, doc, errors } = bootPlaying({ storage });
    click(window, cells(doc)[0]);
    click(window, popButtons(doc).find(b => /Empty/.test(b.textContent)));
    placeTreasure(window, doc, 5, /1×3/);
    assert.strictEqual(errors.length, 0, errors.join("\n"));
  }

  // Refresh: same storage, brand-new page.
  const { doc, errors } = boot({ storage });
  assert.strictEqual(errors.length, 0, errors.join("\n"));
  assert.match(cells(doc)[0].className, /empty/, "the dug-empty tile came back");
  // The treasures are the player's own work now that no preset supplies them, so
  // losing them on a refresh would cost more than it used to.
  assert.ok([...doc.querySelectorAll("#pieceRows tr")].some(r => /1×3/.test(r.textContent)), "the entered treasures came back");

  const item = cells(doc).filter(c => /\bitem\b/.test(c.className));
  assert.strictEqual(item.length, 3, "the located 1×3 came back");
  assert.strictEqual(item.filter(c => !/buried/.test(c.className)).length, 1, "dug/buried split preserved");
  assert.match(doc.querySelector("#status").textContent, /Remaining to find/, "heatmap recomputed from the restored board");
});

// Which preset you picked has to survive: stageSetOf() compares the saved board against
// the stage's sets as they are defined today, and the dropdown follows the answer.
test("the selected preset survives a refresh", () => {
  const storage = makeStorage();
  {
    const { window, doc } = boot({ storage });
    loadStage(window, doc, 4);   // 6×6, 20 pickaxes/tile
    click(window, cells(doc)[0]);
    click(window, popButtons(doc).find(b => /Empty/.test(b.textContent)));
  }

  const { doc, errors } = boot({ storage });
  assert.strictEqual(errors.length, 0, errors.join("\n"));
  assert.strictEqual(doc.querySelector("#stageSelect").value, "4", "still on Stage 4");
  assert.strictEqual(doc.querySelector("#gridSize").value, "6");
  assert.strictEqual(doc.querySelector("#pickPerTile").value, "20");
  assert.match(cells(doc)[0].className, /empty/, "the dug tile came back");
});

test("a restored treasure keeps its identity: clearing it frees exactly its own tiles", () => {
  const storage = makeStorage();
  { const { window, doc } = bootPlaying({ storage }); placeTreasure(window, doc, 0, /1×3/); }

  // itemId/itemCounter must survive, or clearing would miss tiles (or collide with a new find).
  const { window, doc } = boot({ storage });
  click(window, cells(doc)[0]);
  click(window, popButtons(doc).find(b => /Clear this treasure/i.test(b.textContent)));
  assert.strictEqual(cells(doc).filter(c => /\bitem\b/.test(c.className)).length, 0, "all 3 tiles released");
});

// The set a board is on is derived from its saved pieces, never stored, so it cannot
// drift from them. It also has to survive a refresh when it is not the first set.
test("a board saved on a stage's second set restores onto that set", () => {
  const storage = makeStorage();
  {
    const { window, doc } = boot({ storage });
    loadStage(window, doc, 9, 1);          // take the second set
    click(window, cells(doc)[0]);
    click(window, popButtons(doc).find(b => /Empty/.test(b.textContent)));
  }

  const { doc, errors } = boot({ storage });
  assert.strictEqual(errors.length, 0, errors.join("\n"));
  assert.strictEqual(doc.querySelector("#stageSelect").value, "9", "still on Stage 9");
  assert.match(doc.querySelector("#stageInfo").textContent, /1×4 \(×2\)/,
    "restored onto the set that was in play, derived from the saved pieces");
  assert.match(cells(doc)[0].className, /empty/, "the dug tile came back");
});

// Everyone who opened the app while the presets were empty has a saved board that is a
// stage number, no treasures and no digs: that build wrote exactly this on every boot,
// and the save format did not change, so it is still loadable. It holds nothing, and
// restoring it would hand back a blank "custom" board instead of the presets.
test("an empty leftover save is ignored, so the restored presets are what you see", () => {
  const storage = makeStorage({
    "th.board": JSON.stringify({
      v: 1, N: 7, stage: "9", grid: "7", pick: "25", pieces: [],
      cells: Array.from({ length: 49 }, () => ({ status: "hidden", type: null, itemId: 0, dug: false })),
    }),
  });

  const { doc, errors } = boot({ storage });
  assert.strictEqual(errors.length, 0, errors.join("\n"));
  assert.strictEqual(doc.querySelector("#stageSelect").value, "1", "booted the default stage");
  assert.match(doc.querySelector("#stageInfo").textContent, /1×3 \(×3\)/, "with its treasures");
});

// The flip side: one dig makes it a board someone was playing, and it is theirs to keep.
test("a treasure-less save with a dig on it is still restored", () => {
  const storage = makeStorage({
    "th.board": JSON.stringify({
      v: 1, N: 5, stage: "1", grid: "5", pick: "15", pieces: [],
      cells: Array.from({ length: 25 }, (_, i) =>
        i === 0 ? { status: "empty", type: null, itemId: 0, dug: false }
                : { status: "hidden", type: null, itemId: 0, dug: false }),
    }),
  });

  const { doc } = boot({ storage });
  assert.strictEqual(doc.querySelector("#stageSelect").value, "", "no stage has no treasures, so: custom");
  assert.match(cells(doc)[0].className, /empty/, "and the dig is kept");
});

test("a preset that changed under a saved board relabels it custom but keeps the board", () => {
  // Stage 1's sets are three 1×3 and four 1×2. This save claims Stage 1 with a single
  // 2×2, which is neither: the same shape as a save written while the presets were empty.
  const storage = makeStorage({
    "th.board": JSON.stringify({
      v: 1, N: 5, stage: "1", grid: "5", pick: "15",
      pieces: [{ w: 2, h: 2, count: 1 }],
      cells: Array.from({ length: 25 }, (_, i) =>
        i === 0 ? { status: "empty", type: null, itemId: 0, dug: false }
                : { status: "hidden", type: null, itemId: 0, dug: false }),
    }),
  });

  const { doc, errors } = boot({ storage });
  assert.strictEqual(errors.length, 0, errors.join("\n"));
  assert.strictEqual(doc.querySelector("#stageSelect").value, "", "stale preset -> custom");
  assert.match(cells(doc)[0].className, /empty/, "the user's board is kept");
  assert.ok([...doc.querySelectorAll("#pieceRows tr")].some(r => /2×2/.test(r.textContent)), "saved pieces kept");
});

test("a corrupt save is ignored and the app boots Stage 1 as usual", () => {
  for (const bad of ["not json", JSON.stringify({ v: 99 }), JSON.stringify({ v: 1, N: 5, pieces: [], cells: [] })]) {
    const { doc, errors } = boot({ storage: makeStorage({ "th.board": bad }) });
    assert.strictEqual(errors.length, 0, `corrupt save must not throw: ${bad}`);
    assert.strictEqual(cells(doc).length, 25, "fell back to Stage 1");
    assert.strictEqual(doc.querySelector("#stageSelect").value, "1");
    assert.match(cells(doc)[0].textContent, /%/, "heatmap computed");
  }
});

test("New game clears the persisted board rather than resurrecting it", () => {
  const storage = makeStorage();
  { const { window, doc } = bootPlaying({ storage }); placeTreasure(window, doc, 0, /1×3/); click(window, doc.querySelector("#newGame")); }

  const { doc } = boot({ storage });
  assert.strictEqual(cells(doc).filter(c => /\bitem\b/.test(c.className)).length, 0, "board stays reset after a refresh");
});

/* ---------- Glyph contrast ---------- */

// Regression: recompute() sets an inline colour on *hidden* tiles for heatmap
// contrast. Digging one used to leave that colour behind, so it overrode
// .cell.item / .cell.empty and followed the tile for the rest of the game (light
// ⛏ on gold at 2.1:1). It only showed up once boards could be restored: fresh
// elements have no inline colour, so a refresh visibly changed the board.
test("digging a tile hands its ink back to the stylesheet, live and after a refresh", () => {
  const storage = makeStorage();
  const { window, doc } = bootPlaying({ storage });

  const hidden = cells(doc)[0];
  assert.notStrictEqual(hidden.style.color, "", "a hidden tile does carry an inline heatmap ink");

  click(window, hidden);
  click(window, popButtons(doc).find(b => /Empty/.test(b.textContent)));
  assert.strictEqual(cells(doc)[0].style.color, "", "dug-empty tile drops the inline ink");

  placeTreasure(window, doc, 5, /1×3/);
  const live = cells(doc).filter(c => /\bitem\b/.test(c.className));
  assert.strictEqual(live.length, 3);
  assert.ok(live.every(c => c.style.color === ""), "treasure tiles drop the inline ink");

  // The whole point: a restored board must look identical, not just be correct.
  const { doc: doc2 } = boot({ storage });
  const after = cells(doc2).filter(c => /\bitem\b/.test(c.className));
  assert.strictEqual(after.length, 3, "same board came back");
  assert.ok(after.every(c => c.style.color === ""), "restored treasure tiles match the live ones");
  assert.strictEqual(cells(doc2)[0].style.color, "", "restored empty tile matches too");
});

// Ink is chosen from the tile's measured luminance, not from p: the green midrange
// is the brightest part of the ramp even though p is only ~0.4, and the old
// `p > 0.55` rule put light ink on it at 2.1:1.
test("heatmap ink is chosen by luminance, so the bright midrange gets dark ink", () => {
  const { window, doc } = bootPlaying();
  const inkFor = p => window.eval(`inkFor(${p})`);
  const DARK = "#000", LIGHT = "#fff";

  assert.strictEqual(inkFor(0.0), LIGHT, "cold blue is dark, so light ink");
  assert.strictEqual(inkFor(0.4), DARK, "bright green midrange needs dark ink (was light, 2.1:1)");
  assert.strictEqual(inkFor(0.5), DARK, "still bright at p=0.5, below the old 0.55 flip");
  assert.strictEqual(inkFor(1.0), LIGHT, "the hottest red is dark enough for light ink again");

  // and every hidden tile on a real board actually uses one of the two inks
  const inks = new Set(cells(doc).filter(c => /%/.test(c.textContent)).map(c => c.style.color));
  const allowed = new Set(["rgb(255, 255, 255)", "rgb(0, 0, 0)"]);
  assert.ok([...inks].every(i => allowed.has(i)), `unexpected ink on the board: ${[...inks]}`);
});

// The ink pair is load-bearing, not cosmetic. At the luminance where white and black
// contrast equally, that shared value is the ceiling for the pair, and the ramp has
// to pass through it. Softer inks cap at 3.94:1 and can never clear AA.
test("every glyph clears WCAG AA against its actual background, on every stage", () => {
  const srgb = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const rgb = s => {
    let m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) return [+m[1], +m[2], +m[3]];
    m = s.match(/hsl\(([\d.]+)\s+70%\s+([\d.]+)%\)/);
    const h = +m[1], l = +m[2] / 100, a = 0.7 * Math.min(l, 1 - l);
    const ch = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [ch(0), ch(8), ch(4)].map(v => Math.round(255 * v));
  };
  // the dug states take their colours from the stylesheet, which jsdom won't resolve
  const CSS = { empty: ["#2a2d34", "#ffffff"], item: ["#caa23a", "#000000"], buried: ["#9b7b29", "#000000"] };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

  let worst = { r: Infinity };
  for (const stage of [FIX.s1, FIX.s5, FIX.s12, FIX.s15, FIX.s22]) {
    const { window, doc } = boot();
    loadFix(window, stage);
    for (const el of cells(doc)) {
      let bg, fg;
      if (/buried/.test(el.className)) [bg, fg] = CSS.buried.map(hex);
      else if (/\bitem\b/.test(el.className)) [bg, fg] = CSS.item.map(hex);
      else if (/empty/.test(el.className)) [bg, fg] = CSS.empty.map(hex);
      else if (el.style.background && el.style.color) [bg, fg] = [rgb(el.style.background), rgb(el.style.color)];
      else continue;
      const r = ratio(bg, fg);
      if (r < worst.r) worst = { r, stage, text: el.textContent };
    }
  }
  assert.ok(worst.r >= 4.5,
    `worst glyph contrast ${worst.r.toFixed(2)}:1 on stage ${worst.stage} ("${worst.text}") is below WCAG AA`);
});

/* ---------- Per-locale pages (SEO) ----------
   These assert on the files scripts/build-locales.js writes. They are checking what a crawler
   is served, so they read the raw HTML rather than booting it: the whole point is that the
   translation is in the markup before any JS runs. CI separately re-runs the generator and
   fails if the committed output moved, so "the tests pass" cannot mean "the pages are stale". */

const BASE = "https://adj-acent.github.io/ClashOfCritterTreasureHuntSolver/";
const parse = html => new JSDOM(html).window.document;   // no scripts: a crawler's first look
const rootDoc = () => parse(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"));
const localeDoc = code => parse(fs.readFileSync(path.join(ROOT, code, "index.html"), "utf8"));
const langCodes = () => JSON.parse(boot().window.eval("JSON.stringify(LANGS)")).map(([c]) => c);
const hreflangs = doc =>
  [...doc.querySelectorAll('link[rel="alternate"]')].map(l => [l.getAttribute("hreflang"), l.getAttribute("href")]);
const urlFor = code => (code === "en" ? BASE : BASE + code + "/");

test("the root declares one alternate per locale, plus x-default, and nothing else", () => {
  const expected = [["x-default", BASE]].concat(langCodes().map(c => [c, urlFor(c)]));
  // Adding a locale to LANGS without adding its <link> here would silently leave the new page
  // uncrawlable, which is exactly the bug this whole change exists to fix.
  assert.deepStrictEqual(hreflangs(rootDoc()), expected);
});

test("every locale has a page, pinned and self-canonical, with the reciprocal alternate set", () => {
  const codes = langCodes();
  const expected = [["x-default", BASE]].concat(codes.map(c => [c, urlFor(c)]));

  for (const code of codes.filter(c => c !== "en")) {
    const doc = localeDoc(code);
    const where = `${code}/index.html`;

    assert.strictEqual(doc.documentElement.getAttribute("lang"), code, `${where}: <html lang>`);
    assert.strictEqual(doc.documentElement.dataset.pinnedLang, code, `${where}: the language pin`);
    assert.strictEqual(doc.querySelector('link[rel="canonical"]').getAttribute("href"), urlFor(code),
      `${where}: canonical points at itself, not the English root`);
    // Reciprocity: Google drops a whole hreflang cluster if the links do not point back.
    assert.deepStrictEqual(hreflangs(doc), expected, `${where}: alternates`);

    // Served to a crawler in its language, before a line of JS runs. This is the entire point.
    const title = doc.querySelector("title").textContent;
    const desc = doc.querySelector('meta[name="description"]').getAttribute("content");
    const h1 = doc.querySelector("h1").textContent;
    for (const [what, s] of [["title", title], ["description", desc], ["h1", h1]]) {
      assert.ok(s && s.length > 0, `${where}: ${what} is empty`);
    }
    assert.strictEqual(doc.querySelector('meta[property="og:url"]').getAttribute("content"), urlFor(code));
    assert.ok(doc.querySelector('meta[property="og:locale"]'), `${where}: og:locale`);
    assert.strictEqual(JSON.parse(doc.querySelector('script[type="application/ld+json"]').textContent).inLanguage,
      code, `${where}: JSON-LD inLanguage`);

    // Assets live one level up; the analytics beacon is protocol-relative and must be left alone.
    assert.strictEqual(doc.querySelector('link[rel="stylesheet"]').getAttribute("href"), "../styles.css");
    assert.deepStrictEqual([...doc.querySelectorAll("script[src]")].map(s => s.getAttribute("src")),
      ["../i18n.js", "../app.js", "//gc.zgo.at/count.js"], `${where}: script srcs`);

    // The picker links back out to every sibling, so each page is one hop from all the others.
    const links = [...doc.querySelectorAll("#langMenu a[data-lang]")];
    assert.deepStrictEqual(links.map(a => a.dataset.lang), codes, `${where}: picker lists every locale`);
    assert.deepStrictEqual(links.map(a => a.getAttribute("href")),
      codes.map(c => (c === "en" ? "../" : "../" + c + "/")), `${where}: picker hrefs`);
    assert.strictEqual(doc.querySelector(`#langMenu a[data-lang="${code}"]`).getAttribute("aria-current"), "true");
  }
});

test("the English title and description are not left sitting in a translated page", () => {
  const en = rootDoc();
  const enTitle = en.querySelector("title").textContent;
  const enDesc = en.querySelector('meta[name="description"]').getAttribute("content");

  // id is the deliberate exception: its game client leaves the event name in English, so its
  // title legitimately contains "Treasure Hunt". It still must not be the *English string*.
  for (const code of langCodes().filter(c => c !== "en")) {
    const doc = localeDoc(code);
    assert.notStrictEqual(doc.querySelector("title").textContent, enTitle, `${code}: untranslated title`);
    assert.notStrictEqual(doc.querySelector('meta[name="description"]').getAttribute("content"), enDesc,
      `${code}: untranslated description`);
  }
});

test("the sitemap lists every locale URL with the full alternate cluster", () => {
  const xml = fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8");
  const codes = langCodes();

  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.deepStrictEqual(locs, codes.map(urlFor), "one <url> per locale, in LANGS order");

  // Each entry repeats the whole cluster: sitemap hreflang is the signal that does not depend
  // on a crawler reaching and parsing the page head.
  const alts = [...xml.matchAll(/hreflang="([^"]+)"/g)].map(m => m[1]);
  assert.strictEqual(alts.length, codes.length * (codes.length + 1), "16 entries x (16 locales + x-default)");
  assert.ok(xml.includes('hreflang="x-default"'), "x-default is declared");
});

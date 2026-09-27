"use strict"

const EST_TRIALS = 600;
const EST_TIME_MS = 1500;

// Bomb model (the game's BombWeight table, standard tablet = 45 of 48; weights sum to
// 10000). A paid dig of an EMPTY tile sets off a bomb that opens k extra tiles for free,
// k drawn from this distribution (E[k] = 0.95). A bomb-opened tile is collected free.
// Digging a treasure tile (locating one, or digging out a buried one) sets off nothing.
// Used only when the bomb toggle is on. See simulateBomb().
const BOMB_DIST = [[0, 4000], [1, 3500], [2, 1600], [3, 800], [4, 100]];

// A few sets deviate, and only in the zero-bomb weight, so E[k] stays 9500/total. 2000
// means a bomb fires on 75% of empty digs instead of 60%; 5000 drops it to 54.5%.
// Keyed "stage:set".
const BOMB_W0 = { "6:1": 2000, "7:1": 2000, "8:1": 5000 };

// Resolved once per estimate, not per dig: rollBomb() runs deep inside the trial loop.
let bombDist = BOMB_DIST, bombTotal = 10000;
function useBombTable() {
  const s = currentStage();
  const w0 = s ? BOMB_W0[s.n + ":" + currentSet] : undefined;
  bombDist = w0 === undefined ? BOMB_DIST : [[0, w0], ...BOMB_DIST.slice(1)];
  bombTotal = bombDist.reduce((a, wk) => a + wk[1], 0);
}
// The total is read off the table, not hardcoded to 10000: an override moves it to 8000,
// and a stale 10000 turns every roll past the end into a 0, i.e. *fewer* bombs where the
// deviation grants more.
function rollBomb() {
  let r = (Math.random() * bombTotal) | 0, a = 0;
  for (const [k, w] of bombDist) { a += w; if (r < a) return k; }
  return 0;
}

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
    useBombTable();                     // which bomb weights this stage/set draws on
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

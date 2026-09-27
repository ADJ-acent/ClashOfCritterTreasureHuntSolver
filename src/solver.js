"use strict"

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

/*
 * One-step recommendation tie-breaker.
 *
 * Coverage is the right first-order objective: a tile that is more likely to
 * contain treasure is normally the better dig.  Coverage can tie, though,
 * especially in the final 1x2 endgame.  In that case, compare the expected
 * reduction in uncertainty on the *other* hidden cells after the dig.
 *
 * This is deliberately bounded.  It is a tie-breaker for small endgames, not
 * another full expectimax search layered on top of every recompute().  Hit
 * branches are weighted uniformly over candidate footprints; that is exact
 * for the common one-piece endgame and a useful conservative approximation
 * when several piece types can cover the same tile.
 */
const LOOKAHEAD_MAX_AREA = 16;
const LOOKAHEAD_MAX_CANDIDATES = 24;
const LOOKAHEAD_MAX_BRANCHES = 96;

function boardUncertainty(result) {
  if (!result.ok || result.total <= 0) return 0;
  let total = 0;
  for (const i of result.hidden) {
    const p = result.cover[i] / result.total;
    if (isFinite(p)) total += p * (1 - p);
  }
  return total;
}

function withHypotheticalCells(mutator, fn) {
  const original = state.cells;
  state.cells = original.map(c => ({ ...c }));
  try {
    mutator(state.cells);
    return fn();
  } finally {
    state.cells = original;
  }
}

function lookaheadResult(candidate, footprint, type) {
  return withHypotheticalCells(cells => {
    if (!footprint) {
      cells[candidate] = { status: "empty", type: null, itemId: 0, dug: false };
      return;
    }
    const itemId = -candidate - 1; // unique within this hypothetical board
    for (const i of footprint) {
      cells[i] = { status: "item", type, itemId, dug: true };
    }
  }, solve);
}

function oneStepImpact(candidate, current) {
  const p = current.cover[candidate] / current.total;
  if (!isFinite(p) || current.total <= 0) return 0;

  // The clicked tile is guaranteed to become known, so measure impact on the
  // rest of the board rather than rewarding every candidate for resolving its
  // own identical p(1-p) uncertainty.
  const base = boardUncertainty(current) - p * (1 - p);
  const blocked = current.blocked;
  const N = state.N;
  const branches = [];
  const groups = state.pieces
    .map(p => ({ w: p.w, h: p.h, rem: remainingOf(p) }))
    .filter(p => p.rem > 0);

  for (const group of groups) {
    const type = key(group.w, group.h);
    for (const cells of buildPlacements(N, blocked, group.w, group.h)) {
      if (cells.includes(candidate)) branches.push({ cells, type });
    }
  }
  if (!branches.length) return 0;

  const hitBranches = branches.slice(0, LOOKAHEAD_MAX_BRANCHES);
  let expected = (1 - p) * boardUncertainty(lookaheadResult(candidate, null, null));
  const hitWeight = p / hitBranches.length;
  for (const branch of hitBranches) {
    expected += hitWeight * boardUncertainty(lookaheadResult(candidate, branch.cells, branch.type));
  }
  return base - expected;
}

function rankLookahead(current, candidates) {
  const remainingArea = state.pieces.reduce((sum, p) => sum + remainingOf(p) * p.w * p.h, 0);
  if (current.mode === "mc" || remainingArea > LOOKAHEAD_MAX_AREA || candidates.length > LOOKAHEAD_MAX_CANDIDATES) {
    return null;
  }
  const scored = candidates.map(i => ({ i, score: oneStepImpact(i, current) }));
  const best = Math.max(...scored.map(x => x.score));
  return new Set(scored.filter(x => x.score >= best - 1e-9).map(x => x.i));
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

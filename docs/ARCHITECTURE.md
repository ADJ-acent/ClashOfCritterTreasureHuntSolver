# Architecture

Developer-facing notes on how the solver works. For user instructions see the [README](../README.md).

The whole app is one static file, [`index.html`](../index.html) — HTML + CSS + vanilla JS, no build step, no dependencies at runtime. (jsdom is a dev-only dependency for the tests.) Open the file in a browser to run it.

## The model

A stage is an `N×N` grid plus a known multiset of rectangular treasures (e.g. Stage 15 = 1×3 ×2, 1×2 ×2, 2×3 ×1, 2×4 ×2). Every cell is in one of three states:

| Status   | Meaning                                  | Shown as            |
|----------|------------------------------------------|---------------------|
| `hidden` | not yet dug                              | heatmap % + color   |
| `empty`  | dug, nothing there                       | ✕ (probability 0)   |
| `item`   | part of a fully-located treasure         | 100%, treasure size |

The key simplification (a deliberate game-rule choice): when you dig one tile of a treasure you learn its **whole footprint** ("tile + direction = full spot"). So a found treasure is removed from the puzzle entirely and all its tiles become `item`. There are never "partially known" treasures. That means the solver only ever has to **place the remaining pieces into the still-hidden cells with no overlap** — no "must-cover" constraints to track.

`state` holds it all:

```js
state = {
  N,            // grid size
  pieces,       // [{ w, h, count }] normalised so w <= h; the stage definition
  cells,        // length N*N of { status, type, itemId }
}
```

Pieces are keyed by sorted dimensions (`"1x3"`), because the math only depends on size — same-size treasures (Radio/TV, Syringe/Outdated Console) merge. `remainingOf(piece)` = `count − (treasures of that size already found)`.

## Solver — per-tile probability

Goal: for each hidden tile, the probability it covers a treasure = the fraction of all valid layouts of the remaining pieces (no overlap, rotations allowed, edge-touching allowed) that cover it, consistent with everything dug so far.

`solve()` blocks every non-hidden cell, then runs one of two engines:

- **Exact enumeration** (`tryExact`): depth-first placement of every remaining piece, counting, per cell, how many complete layouts cover it. Identical pieces are placed in increasing placement-index order so each physical layout is counted once. Bounded by `EXACT_LEAF_BUDGET` / `EXACT_NODE_BUDGET`; if it would blow the budget it bails to…
- **Monte-Carlo** (`monteCarlo`): repeatedly drop the pieces into random valid spots and tally coverage over the layouts that succeed. Bounded by `MC_SAMPLES` / `MC_TIME_MS`. This is an approximation (sequential random placement isn't perfectly uniform), so the status line labels these results "estimated".

The status line reports which engine ran and over how many layouts/samples. `total === 0` with `ok === false` means the board is over-constrained (treasures can't fit) and tiles render as `?`.

## Estimator — picks to finish

Because hitting one tile of a treasure reveals all of it, "solving the stage" = digging until every treasure has been hit once. `estimateSolve()` Monte-Carlos this:

1. Take the current board (already-dug cells stay known) and the remaining pieces.
2. For each trial: `sampleLayout()` drops the remaining treasures onto the hidden cells at random (reject + resample if they don't fit) — that's the trial's ground truth.
3. `simulateGreedy()` plays the strategy the heatmap recommends: score each hidden tile by how many still-valid placements cover it, dig the highest, reveal whatever's there, repeat until all treasures are hit. Count the digs.
4. Aggregate across trials: mean, 10th/90th percentile, min/max. Picks = mean tiles × pickaxes-per-tile.

Caveats (also surfaced in prior discussion): the per-dig score sums placements per treasure independently (a fast proxy, not the exact conditional probability of the heatmap), the greedy strategy is near-optimal not provably optimal, and bombs are ignored (they only make the real cost lower). Bounded by `EST_TRIALS` / `EST_TIME_MS`.

## Render

`recompute()` runs the solver and paints each cell: ✕ for empty, the size label for found treasures, and a blue→red heatmap (`heat()`) with a % for hidden cells. It also finds the highest-probability hidden tile(s) and marks them with the `★` `best` highlight (ties — common by symmetry — are all marked; `BEST_EPS` folds exact-fraction ties together without letting Monte-Carlo noise over-highlight). Found treasures are excluded since they're already revealed.

## Interaction

Clicking a cell opens a popover (`#pop`). Hidden tile → "Empty" or pick a treasure size, then choose the placement that matches the direction it ran (the candidate placements covering the clicked tile are offered, which resolves the middle-tile ambiguity). Dug tile → clear it. All popover buttons `stopPropagation` so the document-level "close on outside click" handler doesn't fire on them — the bug that originally made treasure-marking silently self-close the popover (regression-tested).

## Presets

`STAGES` holds the 16 real stages (grid size, pickaxes/tile, treasures by name). `HIDDEN_STAGES` holds stages used only by tests (an empty board) and are **not** rendered into the dropdown; `loadStage()` looks them up via `ALL_STAGES = STAGES.concat(HIDDEN_STAGES)`. Editing pieces/grid manually switches the dropdown back to "custom".

## Tests & CI

[`tests/app.test.js`](../tests/app.test.js) loads `index.html` in jsdom and drives the real DOM (`node --test`, i.e. `npm test`). It covers boot, digging, the popover regression, preset loading, the custom-switch, the estimator, and the empty-board path. GitHub Actions runs the suite on every PR and on pushes to `main`; `main` is protected so changes go through PRs with the `test` check passing.

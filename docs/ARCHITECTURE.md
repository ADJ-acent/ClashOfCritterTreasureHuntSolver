# Architecture

Developer-facing notes on how the solver works. For user instructions see the [README](../README.md).

The whole app is one static file, [`index.html`](../index.html) — HTML + CSS + vanilla JS, no build step, no dependencies at runtime. (jsdom is a dev-only dependency for the tests.) Open the file in a browser to run it.

## The model

A stage is an `N×N` grid plus a known multiset of rectangular treasures (e.g. Stage 15 = 1×3 ×2, 1×2 ×2, 2×3 ×1, 2×4 ×2). Every cell has a `status`, and `item` cells also carry a `dug` flag:

| Status   | `dug`  | Meaning                              | Shown as                     |
|----------|--------|--------------------------------------|------------------------------|
| `hidden` | —      | not yet dug, content unknown         | heatmap % + color (★ = best) |
| `empty`  | —      | dug, nothing there                   | ✕ (probability 0)            |
| `item`   | `false`| located treasure tile, still buried  | ⛏, hatched gold (still to dig) |
| `item`   | `true` | treasure tile dug out                | ✓, solid gold                |

Two deliberate game-rule choices drive this:

1. **One dig reveals the whole footprint** ("tile + direction = full spot"). So a *located* treasure is removed from the placement puzzle entirely and all its tiles become `item`; there are never "partially known" treasures. The solver only ever has to **place the remaining (unlocated) pieces into the still-hidden cells with no overlap** — no "must-cover" constraints.
2. **Finding ≠ collecting.** Locating a treasure (one hit) is not the same as digging it up — every tile must still be dug out individually, each costing pickaxes. The tile you clicked to locate it is `dug:true`; the rest are `dug:false` (buried). This only matters for the **estimator**; the probability solver treats any `item` tile, buried or dug, as "known" and excludes it.

`state` holds it all:

```js
state = {
  N,            // grid size
  pieces,       // [{ w, h, count }] normalised so w <= h; the stage definition
  cells,        // length N*N of { status, type, itemId, dug }
}
```

Pieces are keyed by sorted dimensions (`"1x3"`), because the math only depends on size — same-size treasures (Radio/TV, Syringe/Outdated Console) merge. `remainingOf(piece)` = `count − (treasures of that size already located)`.

## Solver — per-tile probability

Goal: for each hidden tile, the probability it covers a treasure = the fraction of all valid layouts of the remaining pieces (no overlap, rotations allowed, edge-touching allowed) that cover it, consistent with everything dug so far.

`solve()` blocks every non-hidden cell, then runs one of two engines:

- **Exact enumeration** (`tryExact`): depth-first placement of every remaining piece, counting, per cell, how many complete layouts cover it. Identical pieces are placed in increasing placement-index order so each physical layout is counted once. Bounded by `EXACT_LEAF_BUDGET` / `EXACT_NODE_BUDGET`; if it would blow the budget it bails to…
- **Monte-Carlo** (`monteCarlo`): repeatedly drop the pieces into random valid spots and tally coverage over the layouts that succeed. Bounded by `MC_SAMPLES` / `MC_TIME_MS`. This is an approximation (sequential random placement isn't perfectly uniform), so the status line labels these results "estimated".

The status line reports which engine ran and over how many layouts/samples. `total === 0` with `ok === false` means the board is over-constrained (treasures can't fit) and tiles render as `?`.

## Estimator — picks to finish

Solving a stage means **digging out every treasure tile**, not merely locating each treasure. So:

```
picks to finish = empty tiles wasted while hunting unlocated treasures   (stochastic)
                + every treasure tile still to dig                        (fixed)
                  = unlocated treasure areas + buried tiles of located treasures
```

Only the empty-hunt cost is random, so `estimateSolve()` Monte-Carlos just that and adds the fixed treasure-tile cost:

1. Take the current board. `baseKnown` = every non-`hidden` tile (empties **and** located treasures), so the hunt only ever digs unknown tiles — matching the in-game advice to dig unknowns (they locate treasures and can spawn bombs) and defer digging out located treasures. Count `buriedCount` (located tiles with `dug:false`) and the `unlocatedArea` (Σ area of still-unlocated treasures).
2. For each trial: `sampleLayout()` drops the unlocated treasures onto the hidden cells at random (reject + resample if they don't fit) — the trial's ground truth.
3. `simulateGreedy()` digs the highest-coverage unknown tile until every treasure is located, returning only the count of **empty** tiles dug. Each trial's total = that + `fixed` (`unlocatedArea + buriedCount`).
4. Aggregate: mean, 10th/90th percentile, min/max. Picks = mean tiles × pickaxes-per-tile.

Special cases: nothing left → "done"; everything located but still buried → deterministic (`mean = buriedCount`, no simulation).

Caveats: the per-dig score sums placements per treasure independently (a fast proxy, not the exact conditional probability of the heatmap), the greedy strategy is near-optimal not provably optimal, and bombs are ignored (they only make the real cost lower). Bounded by `EST_TRIALS` / `EST_TIME_MS`.

## Render

`recompute()` runs the solver and paints each cell: ✕ for empty, ⛏ on hatched gold for buried treasure tiles and ✓ on solid gold for dug-out ones, and a blue→red heatmap (`heat()`) with a % for hidden cells. It also finds the highest-probability hidden tile(s) and marks them with the `★` `best` highlight (ties — common by symmetry — are all marked; `BEST_EPS` folds exact-fraction ties together without letting Monte-Carlo noise over-highlight). Located treasures are excluded from the highlight since the best *next* dig is always an unknown tile.

## Interaction

Clicking a cell opens a popover (`#pop`). Hidden tile → "Empty" or pick a treasure size, then the placement picker offers every candidate placement that covers the clicked tile (resolving the middle-tile ambiguity), in **one of two UIs** chosen by `(hover: none)`:

Both UIs show a `miniDiagram` of where the candidate sits on the board (so the choice doesn't depend on seeing the main grid, which a bottom sheet may cover); they differ only in interaction:

- **Desktop (mouse):** **previews on hover and commits on a single click**. No confirm button.
- **Touch:** **select-then-place** — tapping a row previews it and a primary "Place it" button commits the selection.

The split exists because hover-to-preview + a separate confirm button forces the mouse to travel *over the other options* to reach it, changing the selection on the way — fine on touch, annoying with a mouse. On placement, `commitItem` marks the **clicked** tile `dug:true` and the rest of the footprint `dug:false`. Clicking a located treasure tile toggles it buried ↔ dug out (so the estimate stays exact) or clears the whole treasure; an empty tile can go back to hidden. All popover buttons `stopPropagation` so the document-level "close on outside click" handler doesn't fire on them — the bug that originally made treasure-marking silently self-close the popover (regression-tested).

## Responsive / mobile

A single `@media (max-width: 720px)` breakpoint stacks the controls and board full-width (dropping the desktop `min-width` that caused horizontal scroll), **orders the board above the controls** (`order: -1`) so the bottom-sheet picker covers the setup rather than the board, bumps inputs to 16px (stops iOS zoom-on-focus), and turns the popover into a **bottom sheet** with larger tap targets. `placePop()` decides anchored-vs-sheet at open time via `matchMedia("(max-width: 720px)")`, and the placement picker switches its interaction via `matchMedia("(hover: none)")` (both guarded — jsdom doesn't implement `matchMedia`, so tests default to the desktop/anchored path and opt into mobile with a shim). `touch-action: manipulation` removes the double-tap-zoom delay on cells and buttons.

## Presets

`STAGES` holds the 16 real stages (grid size, pickaxes/tile, treasures by name). `HIDDEN_STAGES` holds stages used only by tests (an empty board) and are **not** rendered into the dropdown; `loadStage()` looks them up via `ALL_STAGES = STAGES.concat(HIDDEN_STAGES)`. Editing pieces/grid manually switches the dropdown back to "custom".

## Tests & CI

[`tests/app.test.js`](../tests/app.test.js) loads `index.html` in jsdom and drives the real DOM (`node --test`, i.e. `npm test`). It covers boot, digging, the popover regression, preset loading, the custom-switch, the best-tile highlight, the dug/buried split and toggle, the empty-board path, and the estimator (including the regression that it counts every treasure tile, not one hit per treasure). GitHub Actions runs the suite on every PR and on pushes to `main`; `main` is protected so changes go through PRs with the `test` check passing.

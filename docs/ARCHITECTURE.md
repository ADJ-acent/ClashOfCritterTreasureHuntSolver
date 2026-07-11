# Architecture

Developer-facing notes on how the solver works. For user instructions see the [README](../README.md).

The whole app is one static file, [`index.html`](../index.html) — HTML + CSS + vanilla JS, no build step, no dependencies at runtime. (jsdom is a dev-only dependency for the tests.) Open the file in a browser to run it.

## The model

A stage is an `N×N` grid plus a known multiset of rectangular treasures (e.g. Stage 15 = 1×3 ×2, 1×2 ×2, 2×3 ×1, 2×4 ×1). Every cell has a `status`, and `item` cells also carry a `dug` flag:

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

`solve()` blocks every non-hidden cell, then runs one of three engines (in this order):

- **Profile DP** (`dpSolve`) — the default, used when the toggle is on and `N ≤ DP_MAX_N` (8). A broken-profile ("plug") DP that gets the *exact* per-cell coverage by **counting** layouts instead of enumerating them, so it stays exact on the dense stages where `tryExact` blows up and the app would otherwise estimate. It scans cells row-major; the state is `(row, profile, remaining-piece-counts)` where the profile records, per column, how many more rows are already occupied by a rectangle started earlier. Pass 1 (`DProw`) memoises `B(s)` = completions from each row-entry state; pass 2 walks rows forward tracking `F(s)` = prefixes reaching `s`, and for every way to fill a row (entry `s` → exit `s'`, occupying a set of cells) adds `F(s)·B(s')` to each occupied cell — exact coverage in ~2× the total-count cost. Bounded by `DP_STATE_BUDGET`; over budget it returns `null` and `solve()` falls through. Result mode is `"dp"`. *Gotcha:* terminal-row (`r = N`) exit states aren't memoised, so their `B` is computed inline — getting this wrong silently drops the last row's coverage (the `Σ cover = total · area` invariant catches it). Despite being exact it's usually **faster** than the off path on dense boards — that path first burns up to `EXACT_NODE_BUDGET` (6M nodes) on a doomed `tryExact` *before* it even starts sampling, whereas the DP just counts. Measured: ≤100ms on most stages and faster than the DFS→MC fallback on 7 of the 10 dense stages; only the 2–3 densest (e.g. Stage 15, ~510M layouts, ~0.5s) cost more than MC's time-capped run. The reason for the toggle isn't that the DP is heavier in general — it's that MC is hard-capped (`MC_TIME_MS`) so its worst case is bounded, while the DP runs to completion and blocks the main thread, which can hitch a low-end device on the densest boards.
- **Exact enumeration** (`tryExact`): depth-first placement of every remaining piece, counting, per cell, how many complete layouts cover it. Identical pieces are placed in increasing placement-index order so each physical layout is counted once. Bounded by `EXACT_LEAF_BUDGET` / `EXACT_NODE_BUDGET`; if it would blow the budget it bails to…
- **Monte-Carlo** (`monteCarlo`): repeatedly drop the pieces into random valid spots and tally coverage over the layouts that succeed. Bounded by `MC_SAMPLES` / `MC_TIME_MS`. This is an approximation (sequential random placement isn't perfectly uniform — in practice it slightly *over*-states the top tile and can pick a different ★ than the exact engines on dense boards), so the status line labels these results "estimated".

The **Exact probabilities (DP)** checkbox (`#dpToggle`, `dpEnabled()`) gates the DP tier; it defaults on and is persisted in `localStorage["th.dp"]`. Off (or `N > 8`) restores the original `tryExact` → `monteCarlo` path. The status line reports which engine ran and over how many layouts/samples (the DP labels its count "(DP)"). `total === 0` with `ok === false` means the board is over-constrained (treasures can't fit) and tiles render as `?`.

The solver feeds a **greedy** next-dig policy (the ★ = highest-coverage hidden tile). Whether that greedy is optimal, and why it can't be efficiently beaten, is its own writeup: see [optimality.md](optimality.md) (the problem is Optimal Decision Tree, NP-hard; greedy measures as effectively optimal on every real stage).

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

## Responsive / layout

The desktop layout is a flat, borderless two-column row (`.wrap`): a fixed-width controls column (`320px`) with a right divider, and a `.stage-area` sized in JS. The cluster is centered both horizontally (`justify-content: center`) and vertically (`.wrap { margin: auto 0 }` absorbs the free space between header and footer; the footer drops its `margin-top:auto` so it does not compete). `.panel { padding: 0 }` flattens what used to be bordered cards.

`sizeBoard()` (run on load and on `resize`) sizes the board and its panel:

- The board is a fixed, moderate size, `min(N*72, 480, availH, availOuter-48)`, so it does not scale up oddly on huge monitors; it shrinks only when the window is too narrow (`availOuter`) or too short (`availH`, so dense boards never crop). It is centered in its panel via `margin: 0 auto`, with the `%` font scaled to the fixed cell size. `.cell` uses `font-size: 1em` (and `.sub`/`.star` use `em`) so the text tracks the grid font-size set in JS.
- The panel is deliberately wider than the board, `max(board+48, min(560, availOuter))`, so the legend and hint get comfortable reading width; it is set as an explicit px `width` on `.stage-area`.

The legend is two centered rows: a `.legend-scale` (0 to 100% colour bar) and `.legend-keys` (status swatches), each `flex-wrap`ping whole `nowrap` units so a label never breaks onto a second line tucked under its swatch.

A single `@media (max-width: 720px)` breakpoint restores the bordered cards (`.panel` gets back its background, border, radius, and padding), stacks everything full-width, **orders the board above the controls** (`order: -1`) so the bottom-sheet picker covers the setup rather than the board, drops the controls divider and the vertical centering, bumps inputs to 16px (stops iOS zoom-on-focus), and turns the popover into a **bottom sheet** with larger tap targets. `sizeBoard()`'s mobile branch keeps the original `min(560, N*64)` board (centered) and clears the JS panel width. `placePop()` decides anchored-vs-sheet at open time via `matchMedia("(max-width: 720px)")`, and the placement picker switches its interaction via `matchMedia("(hover: none)")` (both guarded, since jsdom does not implement `matchMedia`, so tests default to the desktop/anchored path and opt into mobile with a shim). `touch-action: manipulation` removes the double-tap-zoom delay on cells and buttons.

Eyeball layout changes with `npm run screenshots` (`scripts/visual-test.sh`), which renders `index.html` headlessly across a spread of viewport sizes into `.screenshots/` (gitignored). Headless Chromium/Edge enforces a roughly 500px minimum window width, so it cannot faithfully render true phone widths: a sub-500 request lays out at about 476px but writes the image at the requested width, cropping the right edge (a screenshot artifact, not a real overflow). Use a real browser's responsive mode for narrower widths.

## Presets

`STAGES` holds the 24 real stages (grid size, pickaxes/tile, treasures by name). If a stage ever ships with an empty `pieces` list (e.g. treasures not yet published), it loads as an empty board and `stageLabel()` tags it with a "no data" marker in the dropdown. `HIDDEN_STAGES` holds stages used only by tests (an empty board) and are **not** rendered into the dropdown; `loadStage()` looks them up via `ALL_STAGES = STAGES.concat(HIDDEN_STAGES)`. Editing pieces/grid manually switches the dropdown back to "custom".

## Internationalization (i18n)

The UI ships in 10 languages (English + `de`, `es`, `fr`, `pt`, `ru`, `zh-Hans`, `zh-Hant`, `ko`, `ja`). To preserve the "one static file, just open it via `file://`" property, translations live **inline** in the same `<script>` as a plain object — no `fetch`, no JSON side-files, no i18n library.

- **`I18N`** maps each language code to a flat `key → string` table (~73 keys). **`LANGS`** is the ordered `[code, autonym]` list that fills the header `#langSelect` (languages are listed in their own name).
- **`t(key, params)`** looks up `I18N[LANG][key]`, falls back to English, then to the raw key, and interpolates `{placeholder}` tokens. Count-sensitive entries (`status.exact`, `status.estimated`) are `{one,few,many,other}` objects resolved with `Intl.PluralRules` — pass the count as `params._n` — so e.g. Russian picks the right раскладка/раскладки/раскладок. Numbers go through `nfmt` (`toLocaleString(LANG)`).
- **Static chrome** carries `data-i18n` / `data-i18n-html` / `data-i18n-title` attributes; `applyStaticI18n()` walks them and also sets `<title>` and `document.documentElement.lang`. The English text stays in the HTML as the readable default (and as a fallback if the script fails).
- **Dynamic strings** (status line, estimator, the three popovers, dropdown labels, the stage-info line) all go through `t()`. `setLang()` persists to `localStorage["th.lang"]`, then runs `applyStaticI18n()` + `refreshDynamicUI()` (re-paints stage options, quick-add, the piece table, and the heatmap). `detectLang()` resolves `localStorage["th.lang"]` → `navigator.languages` (region-aware: `zh-CN`→`zh-Hans`, `zh-TW`/`zh-HK`→`zh-Hant`, `pt-*`→`pt`, base-tag fallback) → `en`.
- **Treasure names are never displayed** — the UI shows only dimensions (`w×h`). `TREASURES`/`STAGES` keep names purely as lookup keys for sizes, so there are no game-specific terms to translate (and no risk of mismatching the game's official localized names). English strings are kept byte-identical to the pre-i18n UI so the existing tests still assert on them.

## Tests & CI

[`tests/app.test.js`](../tests/app.test.js) loads `index.html` in jsdom and drives the real DOM (`node --test`, i.e. `npm test`). It covers boot, digging, the popover regression, preset loading, the custom-switch, the best-tile highlight, the dug/buried split and toggle, the empty-board path, the estimator (including the regression that it counts every treasure tile, not one hit per treasure), the **DP toggle** (exact `(DP)` engine on a dense stage where DFS bails, and the Monte-Carlo fallback when it's off), and **i18n** (the language selector, switching/restoring strings, region-aware auto-detection, and that treasure names never surface). GitHub Actions runs the suite on every PR and on pushes to `main`; `main` is protected so changes go through PRs with the `test` check passing.

# Architecture

Developer-facing notes on how the solver works. For user instructions see the [README](../README.md).

The app is [`index.html`](../index.html) plus three siblings it loads directly: [`app.js`](../app.js) (everything the app does), [`i18n.js`](../i18n.js) (the 16-locale string table), and [`styles.css`](../styles.css). Vanilla JS, no dependencies at runtime, and **no build step to run it**: they load as classic `<script src>`/`<link>` tags, not ES modules (which would need CORS and die on `file://`), so opening the file straight off the filesystem still works. jsdom is a dev-only dependency, used by the tests and by the locale-page generator.

It was one file until the per-locale pages arrived; each of those would otherwise have had to inline a copy of the whole app. See [Per-locale pages and SEO](#per-locale-pages-and-seo).

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

### Glyph ink

Cell text is white or black, picked per background by `inkFor(p)`, which measures the tile's WCAG relative luminance (`heatLuminance()`). It cannot be picked from `p`: hue drives perceived brightness far more than `p` does, so the *green midrange* (`p ≈ 0.4`) is the brightest part of the ramp, and the old `p > 0.55 ? dark : light` rule painted white on it at **2.1:1**. The fixed backgrounds get the same treatment in CSS (`--ink-light` on the dark empty tile, `--ink-dark` on the light gold).

**The inks are pure `#fff`/`#000` on purpose, and this is load-bearing.** At the luminance where white and black contrast *equally*, that shared value is the ceiling for the pair, and a ramp climbing from dark blue to bright green necessarily passes through it. Softer inks (`#eef` on `#20160a`) cap out at **3.94:1** and can never clear AA, no matter how the ramp or the threshold is tuned. Pure black and white lift the ceiling to 4.58:1. Measured worst case across all stages, fresh and played: **5.26:1** (the ⛏ over the darker hatch stripe). A test asserts this and will fail if the palette regresses.

`recompute()` clears the inline `color` when a tile becomes dug. It sets one on *hidden* tiles, and leaving it behind used to override `.cell.item`/`.cell.empty` for the rest of the game, which is why the stylesheet's colors for those states were dead code until boards became restorable. Cells transition `background-color` and `color` together (120ms) so the ink does not pop while the tile is still crossfading. The transition names `background-color`, not the `background` shorthand, because the buried hatch is a `background-image` and cannot interpolate; the buried tile therefore keeps its gold as `background-color` (which lerps) with the hatch as a separate non-interpolating `background-image`.

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

## Persistence

The board survives a refresh. `state` is plain JSON (no DOM refs, no Maps), so `saveBoard()` writes `{v, N, pieces, cells, stage, grid, pick}` straight to `localStorage["th.board"]` and `restoreBoard()` reads it back. `SAVE_V` is the schema version: bump it whenever the shape changes and old saves are dropped rather than misread.

- **Saving** hangs off `recompute()`, which every board mutation already funnels through (`setEmpty`, `commitItem`, `clearItem`, `setDug`, back-to-hidden, `newGame`, `clearDigs`, and `loadStage` via `newGame`). The two paths that mutate without recomputing (adding a piece, deleting a piece row) plus the `#gridSize` and `#pickPerTile` inputs call `saveBoard()` from their own handlers. Writes are a couple of KB and synchronous, so there is nothing to debounce.
- **Restoring** happens at the very end of boot: `if (!restoreBoard()) loadStage(1)`. `restoreBoard()` reassigns `state`, recovers `itemCounter` as `max(itemId) + 1` (so a restored treasure keeps its identity and clearing it releases exactly its own tiles), repopulates the three inputs, then does the same `renderPieceRows` / `renderStageInfo` / `buildGrid` / `recompute` sequence as `loadStage`, minus the cell wipe. It returns `false` and touches nothing if there is no save, so the caller falls back cleanly.
- **`validBoard()`** gates the restore: version match, `2 ≤ N ≤ 12`, `cells.length === N*N`, statuses in range, `type` shaped like `WxH`, piece counts positive integers. Anything off and the save is ignored.
- **Stale presets.** The saved `cells` only make sense against the saved `pieces`, so `pieces` are restored from storage rather than re-derived from `STAGES`. A preset can change under a saved board (treasures published for a stage that had none, as happened for stages 17 and 18), so `matchesStage()` re-checks the saved grid and pieces against the stage's current definition. If they no longer agree, the board is kept but the dropdown drops to "custom", rather than claiming to be a stage whose definition has moved on.
- **Failure is silent by design.** Every `localStorage` access is wrapped in `try/catch` (private mode, quota, and opaque origins all throw), matching how `th.lang` and `th.dp` are handled. This is also why the tests are unaffected: jsdom serves `index.html` from `about:blank`, an opaque origin with no `localStorage`, so persistence no-ops and every `boot()` starts clean. The persistence tests opt in by passing a `makeStorage()` shim into `boot()` and reusing it across two boots to simulate a refresh.

## Internationalization (i18n)

The UI ships in 16 languages (English + `de`, `es`, `fr`, `pt`, `ru`, `zh-Hans`, `zh-Hant`, `ko`, `ja`, `th`, `id`, `it`, `vi`, `pl`, `nl`). Translations live in [`i18n.js`](../i18n.js) as a plain object, loaded as a classic script: no `fetch`, no JSON side-files, no i18n library, so `file://` still works. Each language also has **its own URL** (`/de/`, `/th/`, …), prerendered from this same table; see [Per-locale pages and SEO](#per-locale-pages-and-seo).

The locale set is chosen from real traffic, not guessed: `th`, `id`, `it`, `vi`, `pl`, `nl` were added because each drew more visitors than `ko` and `ja`, which shipped from the start. Everything below `nl` in the tail is under 0.3% of sessions.

- **`I18N`** maps each language code to a flat `key → string` table (83 keys). **`LANGS`** is the ordered `[code, autonym]` list that fills the header `#langSelect` (languages are listed in their own name). A test asserts every locale defines the full English key set, so a locale can never half-silently fall back to English.
- **`t(key, params)`** looks up `I18N[LANG][key]`, falls back to English, then to the raw key, and interpolates `{placeholder}` tokens. Count-sensitive entries (`status.exact`, `status.estimated`) are `{one,few,many,other}` objects resolved with `Intl.PluralRules` — pass the count as `params._n` — so e.g. Russian picks the right раскладка/раскладки/раскладок. Numbers go through `nfmt` (`toLocaleString(LANG)`).
- **Static chrome** carries `data-i18n` / `data-i18n-html` / `data-i18n-title` attributes; `applyStaticI18n()` walks them and also sets `<title>` and `document.documentElement.lang`. The English text stays in `index.html` as the readable default (and as a fallback if the script fails). The locale-page generator applies **exactly this transform** ahead of time, off the same three attributes, which is why the prerendered pages cannot drift from what the runtime would have painted.
- **Dynamic strings** (status line, estimator, the three popovers, dropdown labels, the stage-info line) all go through `t()`. There is **no in-place language switch**: `LANG` is resolved once at boot, before anything renders, and the picker navigates to another URL instead of re-painting the current one (see below).
- **Treasure names are never displayed** — the UI shows only dimensions (`w×h`). `TREASURES`/`STAGES` keep names purely as lookup keys for sizes, so there are no game-specific terms to translate (and no risk of mismatching the game's official localized names). English strings are kept byte-identical to the pre-i18n UI so the existing tests still assert on them.

### Game terminology: copy the game, do not translate it

Three words appear in the UI that also appear **in the game**: the **event name**, the **pickaxe** item, and the **stage** label. For these, the only correct source is the game client itself. All 15 locales that have a client were read off it directly (2026-07-12); none of these are translations.

> **Do not "correct" anything in this table.** Several entries look like mistakes and are not. Indonesian genuinely leaves the game's terms in English. Chinese and Korean genuinely add a "camp" qualifier that exists in no other locale. Japanese genuinely writes the event in katakana. If one of these looks wrong, it is because the game's localizers made a choice you would not have made.

| Locale | Event name | Pickaxe | Stage |
|---|---|---|---|
| `en` | Treasure Hunt | Pickaxe | Stage {n} |
| `zh-Hans` | 营地寻宝 | 铁镐 | 第{n}关 |
| `zh-Hant` | 營地尋寶 | 鐵鎬 | 第{n}關 |
| `es` | Búsqueda del tesoro | Pico | Escenario {n} |
| `pt` | Caça ao Tesouro | Picareta | Fase {n} |
| `fr` | Chasse au trésor | Pioche | Niveau {n} |
| `de` | Schatzsuche | Spitzhacke | Stufe {n} |
| `ru` | Поиски сокровищ | Кирка | Этап {n} |
| `ja` | オタカラ探し | ツルハシ | ステージ {n} |
| `ko` | 캠프 보물찾기 | 곡괭이 | 스테이지 {n} |
| `th` | ล่าขุมทรัพย์ | อีเต้อ | ด่านที่ {n} |
| `id` | **Treasure Hunt** | **Pickaxe** | **Stage {n}** |
| `it` | Caccia al Tesoro | Piccone | Livello {n} |
| `vi` | Truy Tìm Kho Báu | Cuốc Chim | Màn {n} |
| `pl` | Poszukiwanie skarbów | Kilof | Etap {n} |
| `nl` | *(no game client)* | *(literal translation)* | *(literal translation)* |

Two related facts. The **game name** is "Clash of Critters" everywhere except `vi` (**Chiến Thú Hỗn Chiến**), `ja` (モンスターサバイバル), `ko` (뚜까펫: 서바이벌), `zh-Hans` (塔塔冒险队), `zh-Hant` (塔塔冒險隊). And **Dutch has no game client at all** (the game ships in 16 languages and Dutch is not one of them), so the `nl` locale has nothing to match and keeps ordinary translations. Turkish *does* have a client but no locale here.

To verify a new locale, switch the game's language and screenshot three things: the event banner, the pickaxe item tooltip (its description repeats the event name), and the stage chip.

## Per-locale pages and SEO

Sixteen locales used to live behind **one URL**. Language was chosen at runtime, Googlebot crawls with an English `Accept-Language` and no `localStorage`, and Google works out a page's language from **the text it is served**, not from `<html lang>` or `hreflang`. So Google saw an English page, sixteen times over, and there was no second URL to file a translation under even if it hadn't. The fifteen non-English locales were not content; they were a runtime behaviour of an English page.

Now each locale is a real page at its own URL:

| | |
|---|---|
| `/` | the English page **and** the `x-default`. The only page that auto-detects. |
| `/de/`, `/th/`, `/zh-Hans/`, … | 15 prerendered pages, each **language-pinned**. |

Every page carries the same reciprocal `hreflang` block (16 locales + `x-default` → root), and `sitemap.xml` repeats it as `xhtml:link` alternates, which is the signal that survives a crawler never parsing the head. GitHub Pages serves static files only (no server-side redirects, no `Content-Language`, and a `robots.txt` committed here would sit at the *project* path where no crawler reads it), so all of this has to be static, and it is.

### Auto-detection survives, because detecting is not redirecting

Google discourages redirecting on `Accept-Language`, because a crawler that gets bounced never reaches the other versions. It does not discourage *detecting*. So the detection is confined to the one URL that is allowed to be language-neutral, and the fifteen indexable URLs never auto-anything:

**Precedence (`detectLang()`): URL pin → `localStorage["th.lang"]` → `navigator.languages` → `en`.**

- The **pin** is `<html data-pinned-lang>`, stamped in by the generator. It is read from the DOM, not parsed out of `location.pathname`, which would have to cope with `file://` and with the `/ClashOfCritterTreasureHuntSolver/` project sub-path.
- **The pin wins outright.** Someone who picked Italian last week clicks a Thai search result: they get Thai. The page's own HTML already *is* Thai, so letting a stored preference override it would paint Thai and then flip to Italian, which is the one genuinely surprising outcome available here. Landing on a locale URL is an explicit choice, exactly like using the picker, so boot persists it (`th.lang = "th"`), and one click of the picker takes them back to `/it/`.
- **The root never redirects.** It auto-detects and renders **in place**, exactly as it always did. A German visitor still lands on German without touching anything. Googlebot, arriving as `en-US`, sees English and indexes it as English/`x-default`. Redirecting would buy nothing (the locale pages are indexed via the sitemap, the `hreflang` set, and the picker links regardless) and would cost a round trip, a flash, and an escape hatch to build.
- **No flash on a locale page.** The German is already in the markup; `applyStaticI18n()` re-applies German over German and nothing moves.

### The picker is links, not a `<select>`

`#langMenu` is 16 real `<a href>` anchors, one per `LANGS` entry, in the HTML. That is how the locale pages get crawled and how link equity reaches them, and it means choosing a language is a **navigation**: the URL and the content can never disagree. `initLangPicker()` only marks the current entry, rewrites `de/` to `de/index.html` when `location.protocol === "file:"` (no directory index over `file://`), and persists the click before the navigation lands. That last part is what makes the "English" link work *from* a locale page: it points at the auto-detecting root, which would otherwise just re-detect German.

### The generator

[`scripts/build-locales.js`](../scripts/build-locales.js) (`npm run build:locales`) treats **`index.html` as the template** and never writes it, so the root stays hand-edited and doubles as the English page. For each other locale it clones the DOM (jsdom, already a dev dependency), applies the same `data-i18n*` transform `applyStaticI18n()` applies at runtime, sets the head metadata the runtime cannot usefully set (title, `meta description` from the `meta.description` key, canonical, Open Graph, `og:locale`, JSON-LD `inLanguage`), rewrites the sibling asset paths to `../`, and points the picker links up a level. It also emits `sitemap.xml`.

Two properties are load-bearing:

- **Surgical, not a render.** No scripts run, the board stays empty, nothing is timestamped (`LASTMOD` is a constant on purpose: a live date would make every build dirty by the next day). Same input, same bytes.
- **Generated pages are committed, and CI regenerates and diffs them.** A PR that changes a string without rebuilding fails. This is the only reason it is safe to have 15 copies of the chrome in the repo at all.

The cost is honest: the "single static file" property is gone (a locale page would otherwise inline the entire app 15 times), and copy changes now need a rebuild. Running the app still needs no build step, which is the property that actually mattered.

## Tests & CI

[`tests/app.test.js`](../tests/app.test.js) loads `index.html` in jsdom and drives the real DOM (`node --test`, i.e. `npm test`). It covers boot, digging, the popover regression, preset loading, the custom-switch, the best-tile highlight, the dug/buried split and toggle, the empty-board path, the estimator (including the regression that it counts every treasure tile, not one hit per treasure), the **DP toggle** (exact `(DP)` engine on a dense stage where DFS bails, and the Monte-Carlo fallback when it's off), **persistence** (a board round-tripping through a refresh, restored treasure identity, the stale-preset fallback to custom, corrupt saves ignored, and New game not resurrecting the old board), **i18n** (the picker's per-locale links, a prerendered page booting in its language, region-aware auto-detection on the root, and that treasure names never surface), and the **per-locale pages** (reciprocal `hreflang`, self-canonicals, the pin outranking a stored preference, `../` asset paths, and the sitemap).

Two wrinkles worth knowing:

- `boot()` **inlines the external scripts** into the HTML string before handing it to jsdom. `runScripts: "dangerously"` does not fetch `<script src>`, and `resources: "usable"` would make every boot async and force all 37 tests to await a load event. Inlining in place is faithful (same order; classic scripts have no other load semantics) and keeps `boot()` synchronous. The stylesheet is dropped, which changes nothing: jsdom never resolved the old inline `<style>` either, which is why the contrast test carries its own copy of the colours.
- The locale-page tests read the **raw generated HTML** rather than booting it. They are asserting what a crawler is served, and the whole point is that the translation is in the markup before any JS runs.

GitHub Actions runs the suite on every PR and on pushes to `main`, then re-runs `npm run build:locales` and fails if the committed pages moved. `main` is protected so changes go through PRs with the `test` check passing.

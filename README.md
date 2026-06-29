# Clash of Critter — Treasure Hunt Solver

A single-page web app that helps you play the **Treasure Hunt** event efficiently. It treats each stage like a Battleship board: you know exactly which rectangular treasures are buried, and the app shows the **probability that each still-hidden tile covers a treasure** so you can dig the best tiles first.

**▶ Live app:** https://adj-acent.github.io/ClashOfCritterTreasureHuntSolver/

## What it does

- **Probability heatmap** — every hidden tile is colored blue→red by how likely it is to contain part of a treasure, given everything you've dug so far.
- **Stage presets** — pick any of the 24 stages to auto-fill the grid size, treasures, and pickaxes-per-tile. (A couple of late stages don't have published treasures yet; they load with the grid and pickaxe cost and a "no data" note so you can add treasures manually.)
- **Pick-cost estimator** — estimates the average number of tiles (and pickaxes) needed to finish the stage from the current board, with a typical range.
- **Manual setup** — set any grid size and add treasures by dimension for custom boards.
- **Exact probabilities (DP) toggle** — on by default, computes exact heatmaps for every stage with a dynamic-programming solver (usually as fast as or faster than the sampler); turn it off on low-end devices to use the time-capped Monte-Carlo sampler, which has a more predictable worst case on the densest boards.
- **10 languages** — the whole UI is localized (English, 简体中文, 繁體中文, Español, Português, Français, Deutsch, Русский, 日本語, 한국어). It auto-detects your browser language, remembers your choice, and has a language selector in the header. Treasures are shown by dimension only (`1×3`), so nothing depends on item names.

## How to use it

1. Pick a stage from the **Preset** dropdown (or set the grid size and add treasures manually).
2. Click a hidden tile and tell the app what you found:
   - **Empty** — marks the tile as dug-and-empty.
   - **A treasure** — choose its size, then pick the placement that matches the direction it ran. Each option shows a little diagram of where the treasure sits on the board. On desktop, hover to preview and click to place; on touch, tap to preview then tap **Place it**. The clicked tile is marked **dug** (✓) and the rest of the footprint is shown **located but buried** (⛏, hatched) — you still have to dig those out to collect it.
3. The heatmap recalculates after every dig. The **★** marks the best unknown tile(s) to dig next. Dig unknown tiles to locate treasures (and trigger bombs); dig out the located treasures last. Click a buried tile to mark it ✓ dug as you uncover it.
4. Click **Estimate picks to finish** any time to see the expected remaining cost.

## How the math works

- **Probabilities:** the app considers every way the remaining treasures can be placed in the hidden tiles without overlapping (rotations allowed, touching allowed) and consistent with what you've dug. Each tile's probability is the fraction of those layouts that cover it. With **Exact probabilities (DP)** on (the default), a dynamic-programming solver computes these *exactly* for every real stage — even the dense ones with hundreds of millions of layouts — in well under a second. Turn the toggle off (or on very large custom boards) and it falls back to **Monte-Carlo sampling** — approximate (and slightly biased toward over-stating the top tile), but hard-capped at a fixed time budget, so it has a lower, more predictable worst case on the very densest boards. The status line tells you which engine ran.
- **Pick-cost estimate:** finding a treasure isn't collecting it — every treasure tile has to be dug out. So picks-to-finish = the empty tiles you waste while hunting for unlocated treasures (estimated by sampling many real layouts and simulating greedy play) **plus** every treasure tile still to dig (unlocated treasure areas + buried tiles of located ones). It ignores bombs, which only make the real cost lower.

## Development

Everything lives in a single static file, [`index.html`](index.html) — no build step. Open it in a browser to run it. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the solver, estimator, and rendering are put together.

### Tests

The test suite loads `index.html` in [jsdom](https://github.com/jsdom/jsdom) and drives the real DOM:

```bash
npm install
npm test
```

### Contributing

`main` is protected — changes go through pull requests and CI must pass:

```bash
git checkout -b my-change
# edit, commit
git push -u origin my-change
gh pr create --base main --fill
# merge once the CI "test" check is green
gh pr merge --squash --delete-branch
```

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `npm test` on every PR and on pushes to `main`.

## License

© 2026 Andy Jiang. Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE) — non-commercial use, modification, and sharing are permitted (keep the copyright/`Required Notice`); **commercial use is not.**

This is a fan-made tool, not affiliated with or endorsed by the game it references or its publisher; game names and trademarks belong to their respective owners.

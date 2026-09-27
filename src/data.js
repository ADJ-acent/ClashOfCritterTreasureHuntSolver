"use strict"

/* ---------- Known treasure sizes (for quick-add). Solver merges by dimension. ---------- */
const TREASURES = [
  ["Zobo Cola", 1, 3], ["Zobo Zine", 2, 2], ["Syringe", 1, 2],
  ["Trumpet", 1, 3], ["Outdated Console", 1, 2], ["Radio", 2, 3],
  ["Pirated Magazine", 2, 2], ["TV", 2, 3], ["Cyberlimb", 1, 4],
  ["Spaceship", 3, 3], ["Statue", 2, 4],
];

/* ---------- Stage presets. ----------
   A stage draws its treasures from one of several sets, so a preset is a *list* of
   sets. `sets[0]` is what the stage shipped with before the "added variety" patch.

   Two sets that differ only in which item fills a given rectangle are one set here,
   because the solver sees dimensions and nothing else. That collapses most of the
   game's variants, which is why 24 stages need only 37 sets.

   `partial` marks a stage with a set that isn't recorded here, so the UI can say so
   rather than imply the list is exhaustive.

   Each set is [name, count] using TREASURES sizes; same-size pieces merge. Names are
   never displayed, so where a set could be either of two same-size treasures
   (Radio/TV, Syringe/Outdated Console) the label is a guess and nothing depends on it. */
const STAGES = [
  { n: 1,  grid: 5, pick: 15,  sets: [
    [["Zobo Cola", 3]],
    [["Outdated Console", 4]],
  ] },
  { n: 2,  grid: 5, pick: 15,  sets: [
    [["Zobo Zine", 1], ["Syringe", 3]],
    [["Syringe", 2], ["Outdated Console", 2]],
    [["Syringe", 2], ["Zobo Cola", 2]],   // from a player screenshot
  ] },
  { n: 3,  grid: 5, pick: 15,  sets: [
    [["Trumpet", 1], ["Zobo Zine", 1], ["Outdated Console", 2]],
    [["Pirated Magazine", 2], ["Zobo Zine", 1]],
    [["Zobo Cola", 1], ["Outdated Console", 4]],
  ] },
  { n: 4,  grid: 6, pick: 20,  sets: [
    [["Zobo Cola", 1], ["Outdated Console", 2], ["Radio", 1]],
    [["Zobo Cola", 3], ["Outdated Console", 2]],
  ] },
  { n: 5,  grid: 6, pick: 20,  sets: [
    [["Pirated Magazine", 2], ["Zobo Zine", 2]],
    [["Cyberlimb", 2], ["Zobo Zine", 2]],
    [["Zobo Cola", 2], ["Trumpet", 2], ["Zobo Zine", 1]],
  ] },
  { n: 6,  grid: 6, pick: 20,  sets: [
    [["Zobo Cola", 2], ["Zobo Zine", 1], ["TV", 1]],
    [["Outdated Console", 2], ["Radio", 1], ["TV", 1]],
  ] },
  { n: 7,  grid: 7, pick: 25,  sets: [
    [["Zobo Zine", 1], ["Radio", 1], ["Cyberlimb", 2]],
    [["Syringe", 4], ["Statue", 1]],
    [["Zobo Zine", 1], ["Radio", 1], ["Statue", 1]],
  ] },
  { n: 8,  grid: 7, pick: 25,  sets: [
    [["Outdated Console", 2], ["Cyberlimb", 1], ["Spaceship", 1]],
    [["Zobo Cola", 3], ["Spaceship", 1]],   // from a player screenshot
  ] },
  { n: 9,  grid: 7, pick: 25,  sets: [
    [["Syringe", 2], ["Pirated Magazine", 2], ["Statue", 1]],
    [["Syringe", 2], ["Cyberlimb", 2], ["Statue", 1]],
  ] },
  { n: 10, grid: 7, pick: 35,  sets: [[["Outdated Console", 2], ["Cyberlimb", 2], ["Spaceship", 1]]] },
  { n: 11, grid: 7, pick: 35,  sets: [[["Zobo Cola", 2], ["Outdated Console", 2], ["Trumpet", 1], ["Statue", 1]]] },
  { n: 12, grid: 7, pick: 35,  sets: [[["Cyberlimb", 2], ["Radio", 1], ["Outdated Console", 2], ["Spaceship", 1]]] },
  { n: 13, grid: 7, pick: 70,  sets: [[["Outdated Console", 2], ["Statue", 2]]] },
  { n: 14, grid: 7, pick: 70,  sets: [[["Radio", 1], ["Cyberlimb", 2], ["Spaceship", 1]]] },
  { n: 15, grid: 7, pick: 70,  sets: [[["Zobo Cola", 2], ["Syringe", 2], ["TV", 1], ["Statue", 1]]] },
  { n: 16, grid: 7, pick: 100, sets: [[["Outdated Console", 2], ["Pirated Magazine", 2], ["Statue", 1]]] },
  { n: 17, grid: 7, pick: 100, sets: [[["Outdated Console", 2], ["Zobo Cola", 2], ["Radio", 1], ["Spaceship", 1]]] },
  { n: 18, grid: 7, pick: 100, sets: [[["Outdated Console", 2], ["Cyberlimb", 2], ["TV", 1], ["Spaceship", 1]]] },
  { n: 19, grid: 7, pick: 150, sets: [[["Outdated Console", 2], ["Zobo Zine", 2], ["Statue", 1]]] },
  { n: 20, grid: 7, pick: 150, sets: [[["Outdated Console", 2], ["Zobo Cola", 2], ["Radio", 1], ["Spaceship", 1]]] },
  { n: 21, grid: 7, pick: 150, sets: [[["Outdated Console", 2], ["Cyberlimb", 2], ["Radio", 1], ["Spaceship", 1]]] },
  { n: 22, grid: 7, pick: 200, sets: [[["Outdated Console", 2], ["Zobo Zine", 2], ["Statue", 1]]] },
  { n: 23, grid: 7, pick: 200, sets: [[["Outdated Console", 2], ["Zobo Cola", 2], ["Radio", 1], ["Spaceship", 1]]] },
  { n: 24, grid: 7, pick: 200, sets: [[["Outdated Console", 2], ["Cyberlimb", 2], ["Radio", 1], ["Spaceship", 1]]] },
];
// Stages loadable by the test suite but hidden from the dropdown. Negative n keeps
// them out of sight (loadStage() reads ALL_STAGES, populateStages() reads STAGES).
// Both are boards no real stage provides: an empty one, and a one-treasure one that
// can be finished in two clicks. Everything else a test needs is a real stage now.
const HIDDEN_STAGES = [
  { n: -1, grid: 5, pick: 15, sets: [[]] },                    // no treasures set up. Tests only
  { n: -2, grid: 5, pick: 15, sets: [[["Syringe", 1]]] },      // one 1×2, for the all-dug-out path. Tests only
];
const ALL_STAGES = STAGES.concat(HIDDEN_STAGES);   // dropdown shows STAGES; loadStage() accepts either
const sizeOf = name => { const t = TREASURES.find(t => t[0] === name); return [t[1], t[2]]; };

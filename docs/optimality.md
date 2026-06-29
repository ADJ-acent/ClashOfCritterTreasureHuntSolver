# Is the solver's advice actually optimal?

A technical note on how good the ★ recommendation is. For user instructions see the [README](../README.md); for the solver internals see [ARCHITECTURE](ARCHITECTURE.md).

The heatmap colors every hidden tile by the probability it covers a treasure, and the ★ marks the tile with the highest probability as the best next dig. That raises a fair question: is "dig the most likely tile" really the best strategy, or could a smarter algorithm finish stages with fewer wasted digs? This page records what we explored and what we found.

## The problem, precisely

Every treasure tile has to be dug out eventually, so that cost is fixed no matter how you play. The only thing you control is how many **empty** tiles you waste while hunting for the treasures' locations. So the goal is: minimize the expected number of empty digs until every treasure is located (one hit reveals a treasure's whole footprint).

Written formally, this is the **Optimal Decision Tree** problem. The hypotheses are all the valid no-overlap layouts of the remaining pieces (the solver assumes these are equally likely). Each dig is a test whose outcome is "empty" or "this exact footprint," and you want to identify the true layout with as few costly tests as possible. The asymmetric cost (empties cost a dig, hits are free) turns out not to matter for ranking strategies, because locating a treasure always takes exactly one hit and the number of treasures is fixed. Minimizing empty digs is therefore the same as minimizing total digs to full identification.

This matters because the problem is **known to be hard**:

- Constructing the optimal decision tree is NP-complete (Hyafil and Rivest, 1976).
- It is NP-hard to approximate better than a factor of `ln m`, where `m` is the number of consistent layouts.
- A greedy policy achieves that `ln m` bound, and no efficient algorithm can do meaningfully better in the worst case (this is the theory of adaptive submodularity, Golovin and Krause).

In short, there is no practical algorithm that is provably optimal for a full stage, and there cannot be one. The honest question is not "can we be optimal" but "how far from optimal is the simple greedy we already ship."

## What we compared

Three policies, all judged on expected empty digs against the same uniform belief:

- **cost-greedy** (what the app does): dig the tile most likely to be treasure (highest coverage).
- **info-greedy** (generalized binary search): dig the tile that splits the surviving layouts most evenly. This is the variant the textbook `ln m` guarantee actually applies to.
- **optimal**: exact expectimax over the layout set. Correct, but only computable on small instances.

## What we found

**On boards small enough to solve exactly, greedy is often literally optimal.** It matched the optimum to four decimals on a 224-layout 4x4 board and on the real 42-layout endgame shown in the app's screenshot. A measurable greedy-to-optimal gap appears only on tiny, sparse boards (for example 3x3 with one 1x2), and even there it is at most about 6% of the tiles you actually dig.

**The "principled" alternative is worse here, not better.** Information-gain greedy lost to plain cost-greedy on every non-tied board. The reason is the cost structure: splitting the layouts via a treasure hit is free, splitting them via an empty costs a dig, and cost-greedy implicitly chases the free, information-rich hit. So the algorithm with the famous guarantee is the wrong tool for this particular objective.

**Across all 12 stages, an optimal endgame buys almost nothing.** We Monte-Carloed real greedy play and, the moment the surviving layouts collapsed to a solvable number, computed exactly how much an optimal continuation would save:

| Grid | Stages | Most an optimal endgame saves |
|------|--------|-------------------------------|
| 5x5  | 1 to 3 | up to 0.054 empty digs (0.44% of picks) |
| 6x6  | 4 to 6 | up to 0.075 empty digs (0.38% of picks) |
| 7x7  | 7 to 12 | up to 0.033 empty digs (0.15% of picks) |

The gap is small but, at two-piece endgames, consistently nonzero, so greedy is not *literally* optimal there. It just loses a rounding error. On the dense 7x7 stages the measured gap is zero, but that is a limitation, not a triumph: those boards are only solvable in the very last step, where any sane policy has converged. The mid-game on a 7x7, with millions of layouts in play, is beyond any exact solver, so we cannot certify greedy there. We can only say that everywhere we are able to check, optimal beats greedy by less than half a percent of the work.

## Takeaway

The solver's simple advice is effectively optimal. The remaining gap to a perfect oracle is a fraction of a single wasted dig and is provably impossible to close efficiently in general. The one assumption worth questioning is not the search algorithm but the belief it searches over: the solver treats every valid layout as equally likely, and whether the real game places treasures uniformly is the open question that could actually move the numbers.

## Further reading

- Hyafil and Rivest, "Constructing Optimal Binary Decision Trees is NP-Complete" (1976). The NP-completeness result.
- Golovin and Krause, "Adaptive Submodularity: Theory and Applications in Active Learning and Stochastic Optimization" (2011). The greedy approximation guarantee.
- Dasgupta, "Analysis of a greedy active learning strategy" (2004). Generalized binary search.
- Chen et al., "Sequential Information Maximization: When is Greedy Near-Optimal?" (2015).

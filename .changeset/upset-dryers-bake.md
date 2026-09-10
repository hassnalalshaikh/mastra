---
'@mastra/evals': patch
---

Reject trajectory budget checks with incomplete measurements and count nested model usage. Requested token budgets now require finite nonnegative input and output counts for every model generation; trajectories without model-generation evidence cannot establish a token budget. Requested duration budgets require a valid total duration or complete top-level durations. Explicit zero measurements remain valid. Invalid numeric limits reject instead of passing silently. The unified trajectory scorer reports these failures through its existing preprocessing error path without producing a score.

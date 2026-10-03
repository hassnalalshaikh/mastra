---
'@mastra/core': minor
---

Added a lifetime dispatch-attempt limit for agent schedules. Set `maxRuns: 5` in `mastra.schedules.create()` to pause after five attempts. `runCount` is reserved before execution, survives edits, and includes failed attempts. Resuming cannot reset the budget.

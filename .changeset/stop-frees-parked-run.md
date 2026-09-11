---
'@mastra/core': patch
---

Stop on a run parked on a tool suspension (a generation, a question) now frees the thread. The runtime's `abortRun` found no prepared stream for a parked run and only recorded the abort, so the parked record stayed the thread's blocking run: every later message was parked on a run that would never resume, and anything queued behind it never started. Aborting a parked run now releases it the way a finished run is released (records and thread reservation dropped, the lease handed to the next queued message or released). After Stop, the Session also waits for the aborted subscription's teardown before re-subscribing, so the next run's events reach it, and when a live subscription exists it leaves draining the queue to the run engine's teardown instead of dispatching onto the handle about to be detached.

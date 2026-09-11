---
'@mastra/core': patch
---

Stop on a run parked on a tool suspension (a generation, a question) now frees the thread, so the next message is answered and follow-ups queued behind the parked run run on their own.

- After Stop, the Session waits (within the same 30 s budget) for the aborted subscription's teardown before re-subscribing. The stream could read idle before the run engine detached the aborted subscription, so the next dispatch reused a handle about to be detached and its run's events never reached the Session. With a live subscription, Stop on a parked run leaves the queue drain to the run engine's own teardown instead of dispatching onto that handle.
- A durable run parked on a tool suspension is released in the thread runtime once its stored run has been cancelled (`releaseAbortedSuspendedRun`, internal). Its completion watcher returned when it suspended, so nothing else freed the thread: later messages were folded into a run that would never resume. A failed cancellation does not release it, so it stays observable with its stored work retained, and approval suspensions are left to their own decline path.

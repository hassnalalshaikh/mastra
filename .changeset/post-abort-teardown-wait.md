---
'@mastra/core': patch
---

A message sent right after an abort (a steer, or a follow-up typed while the run is stopping) now waits for the aborted run to finish tearing down before it is dispatched. Real teardown includes stream cancellation and the output processors that run on the partial result, which takes longer than the previous one-second cap; dispatching earlier handed the new message to the dying run, which dropped it, so a steer produced no reply. The wait is bounded (30 s) and, if the run never stops, the send now fails with a clear error instead of losing the message. A deferred abort behind a parked approval gate keeps its short wait, since nothing is streaming there.

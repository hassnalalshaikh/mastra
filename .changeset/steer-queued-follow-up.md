---
'@mastra/core': patch
---

Add `session.steerFollowUp({ id })`: steer the current run with one queued follow-up in a single step. The follow-up leaves the Agent runtime queue and becomes the steering message (files included), so a "send now" button can never run it twice or lose it between a remove and a steer. A follow-up that is no longer waiting answers `{ ok: false, reason: 'not_queued' }` and the run is left alone. `agent.cancelQueuedMessages({ queueOwnerId, waitingOnly: true })` cancels only messages still waiting, leaving one whose run is already starting.

---
'@mastra/core': patch
---

Follow-ups now run one at a time in every state a session can be in, and Steer no longer drops the queue.

- A follow-up sent while a run is starting (sent, but not yet visible as `agent_start`), tearing down after Stop, or parked on a tool suspension (a generation, a question to the user) or an armed approval now waits in the follow-up queue, visible as `queuedFollowUpItems`. Previously it was delivered into that run and folded into one model input together with every other message sent meanwhile, so several queued messages were answered as one batch.
- The queue never drains into a parked run or into a run that is still starting; it moves on when the run ends, when Stop abandons a parked run, or when the send ahead of it never becomes a run.
- `steer` puts its message at the front of the queue and stops whatever is in flight (a run that is still starting is stopped as soon as it starts). The steered message runs next and the queued follow-ups stay queued and run after it, one at a time. It no longer clears the queue. From an idle session it sends right away, as before.
- `SessionFollowUps.enqueueNext()` adds a follow-up at the front of the queue with an id.

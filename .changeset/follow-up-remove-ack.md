---
'@mastra/server': patch
'@mastra/client-js': patch
---

`DELETE /agent-controller/:controllerId/sessions/:resourceId/follow-up/:followUpId` now answers `{ ok: false, reason: 'not_queued' }` when the follow-up was already handed to a run, instead of always `{ ok: true }`. `session.removeFollowUp(id)` returns that ack and no longer retries, so a UI never steers the same text again while the run that carries it is already answering.

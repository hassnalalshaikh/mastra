---
'@mastra/server': patch
'@mastra/client-js': patch
---

Add `POST /agent-controller/:controllerId/sessions/:resourceId/follow-up/:followUpId/steer` (client: `session.steerFollowUp(followUpId)`): steer the current run with one queued follow-up in a single call. It answers `{ ok: true }` once the follow-up is taken (the reply streams over the session stream) and `{ ok: false, reason: 'not_queued' }` when the follow-up is no longer waiting, in which case nothing is aborted or sent. The client never retries it.

---
'@mastra/server': patch
'@mastra/client-js': patch
---

Keep agent controller UIs in sync with the server. A session event stream opened while work is live (a run in progress, or approvals or suspensions pending) now starts with a `display_state_changed` snapshot of the current display state, so a page that opens mid-run or a stream that reconnects shows the run as it is now. An idle session sends no extra event. `session.subscribe()` treats a stream that delivers nothing for `idleTimeoutMs` (default 60 seconds), not even the server heartbeat, as dropped and reconnects it; the same limit applies to opening a stream.

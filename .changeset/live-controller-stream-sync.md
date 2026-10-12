---
'@mastra/server': patch
'@mastra/client-js': patch
---

Keep agent controller UIs in sync with the server. Every session event stream now starts with a `display_state_changed` snapshot of the current display state, so a page that opens mid-run or a stream that reconnects shows the run as it is now. `session.subscribe()` treats a stream that delivers nothing for `idleTimeoutMs` (default 60 seconds), not even the server heartbeat, as dropped and reconnects it; the same limit applies to opening a stream.

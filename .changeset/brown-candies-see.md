---
'@mastra/client-js': patch
'@mastra/server': patch
'@mastra/core': patch
---

Fixed approval, answer, and Stop acknowledgements to distinguish native acceptance from execution. Stale commands now report rejection, and the client never automatically replays a request after its response is lost.

---
'@mastra/core': patch
---

Refuse a second answer to a tool approval the session already answered. Two tabs approving the same card a moment apart were both acknowledged: the second found no live gate and fell through to the stored-run path, whose snapshot still listed the call, and its resume then failed in the background. The session now remembers the approvals it answered, so `hasPersistedToolApproval` is false for them and the route answers `not_pending`. A fresh process starts empty, so a restored approval is still answered through its stored run.

---
'@mastra/core': patch
---

Preserve native suspension wait kind on tool invocations through resume and storage in both execution paths. Keep every user-suspended result at its original conversation position while retaining completion-time placement for external jobs and compatibility with older saved questions.

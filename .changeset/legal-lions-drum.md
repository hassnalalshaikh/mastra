---
'@mastra/core': patch
---

Fixed live scores disappearing through traced Mastra instances and pointing to hidden workflow spans. Scores now retain their owning instance and reference an exported span.

---
'@mastra/core': patch
---

Fixed durable agent recovery to refuse new recovery work once shutdown starts, while preserving recoverable snapshots and keeping storage open until admitted recovery discovery settles.

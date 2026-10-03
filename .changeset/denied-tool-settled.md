---
'@mastra/core': patch
---

The trailing-assistant guard treats a denied tool call (`output-denied`) as settled, so a conversation that ends on a declined tool no longer gets a synthetic continuation turn.

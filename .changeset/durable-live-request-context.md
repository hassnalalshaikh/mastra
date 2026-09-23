---
"@mastra/core": patch
---

Fixed durable runs losing skill-gated tools: a tool rebuild now keeps the live request context, a durable wrapper keeps its agent tool policy, and per-step processor or policy filtering no longer removes tools from later steps (backports #23889).

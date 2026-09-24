---
'@mastra/core': patch
---

Durable agents now save their running state only at real checkpoints (the LLM result, each finished tool call, the start of each iteration, and when an evaluation actually ran). The steps in between are re-derived on restart, so a tool call no longer rewrites the whole loop state about ten times before the next model call. Recovery after a crash during or right after a tool call now finishes the run instead of failing, and a nested run that had not saved its first checkpoint yet starts from its input on restart.

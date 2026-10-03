---
"@mastra/core": patch
---

Fixed cancellation of saved nested workflow runs after restart. Preserve completed results, follow only validated saved child links, and report failed storage or event delivery instead of claiming cancellation finished.

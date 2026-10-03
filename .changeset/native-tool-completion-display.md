---
"@mastra/core": patch
---

Keep tool progress tied to admitted execution, and show each completed tool result at its completion position in Session live events and history. Preserve original model memory and source-message identity. Keep preliminary background results active, report exact terminal outcomes, and index recent completion source IDs through native thread state for bounded history reads. Explicit history requests above 1,024 rows use the existing full-history read path.

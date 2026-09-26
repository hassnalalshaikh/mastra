---
'@mastra/core': patch
---

Fixed empty model replies after a short tool result when a state signal (for example the browser state) was recorded earlier in the same run. The model prompt now places the newest state signal of each state last when only tool steps followed it, so the model reads the current state right before it answers. Stored messages, recall and the transcript keep their original order.

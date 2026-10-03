---
'@mastra/core': patch
'@mastra/server': patch
---

Show each completed tool result at its completion position in AgentController Session live events and display reads, on the 1.74 id-addressed message wire. The transcript commit stamps the completion once from the part's own clock; published tool outcomes carry the committed record and source message id, so live rows and stored rows share one id and time. Question and plan responses (user wait kind, `ask_user`, `submit_plan`) stay at their question position. Provider-executed calls stay in their row. Recent completion sources are indexed in native thread state so a bounded history window still shows a completion whose call predates it. Stored model history is unchanged.

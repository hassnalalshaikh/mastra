---
"@mastra/core": minor
---

Added an owned browser replacement API for idle Sessions in the pinned Khayalek contribution. The previous browser closes before the replacement is created, while the chat thread and stream remain unchanged.

```typescript
await controller.replaceSessionBrowser(session, {
  browser: async () => new AgentBrowser({ headless: true }),
});
```

Released instances cannot reopen through stale references. Failed cleanup can be retried without overwriting the saved tab snapshot.

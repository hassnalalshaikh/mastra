---
"@mastra/browser-firecrawl": minor
---

Added awaited session lifecycle observations for hosted session admission and provider deletion receipts in the pinned Khayalek contribution.

```typescript
new FirecrawlBrowser({
  apiKey,
  sessionLifecycle: {
    deleted: async ({ sessionId, receipt }) => saveUsage(sessionId, receipt),
  },
});
```

Failed deletion or observation retains the provider identity and receipt for an explicit cleanup retry. Shared sessions use inherited viewer preferences, trusted activity and saved tabs.

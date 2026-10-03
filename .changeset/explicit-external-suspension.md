---
'@mastra/core': minor
---

Added explicit user or external suspension waits for agent tools and workflow steps. The wait type survives saved state and resume without changing approval checks or native message delivery.

```typescript
await context.agent.suspend({ requestId }, { waitingFor: 'external' });
await suspend({ requestId }, { resumeLabel: 'callback', waitingFor: 'external' });
```

Omitting `waitingFor` keeps the existing user-wait behavior. Same-agent messages sent while suspended stay queued in the existing run until it resumes.

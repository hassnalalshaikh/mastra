---
'@mastra/core': minor
---

Added file attachments to queued follow-up and steering messages. Queued messages can be steered by ID without losing their files.

```typescript
await session.followUp({ content: 'Review this', files: [{ data: 'data:text/plain;base64,aGk=', mediaType: 'text/plain', filename: 'Notes.txt' }] });
const [queued] = session.followUps.list();
if (queued) await session.steer({ content: '', followUpId: queued.id });
```

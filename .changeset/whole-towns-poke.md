---
'@mastra/client-js': minor
---

Added file attachments to client Session followUp and steer commands, and added steering of an existing queued message by ID.

```typescript
await session.followUp({ content: 'Review this', files: [{ data: 'data:text/plain;base64,aGk=', mediaType: 'text/plain', filename: 'Notes.txt' }] });
// Use the ID from the native queuedFollowUpItems display snapshot.
await session.steer({ content: '', followUpId: 'queued-message-id' });
```

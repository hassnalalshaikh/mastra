---
'@mastra/core': minor
---

Added file attachments to follow-up and steering messages.

```typescript
await session.followUp({ content: 'Review this', files: [{ data: 'data:text/plain;base64,aGk=', mediaType: 'text/plain', filename: 'Notes.txt' }] });
await session.steer({ content: 'Use this instead', files: [{ data: 'data:text/plain;base64,aGk=', mediaType: 'text/plain' }] });
```

---
'@mastra/client-js': minor
---

Added file attachments to client Session followUp and steer commands.

```typescript
await session.followUp({ content: 'Review this', files: [{ data: 'data:text/plain;base64,aGk=', mediaType: 'text/plain', filename: 'Notes.txt' }] });
await session.steer({ content: 'Use this instead', files: [{ data: 'data:text/plain;base64,aGk=', mediaType: 'text/plain' }] });
```

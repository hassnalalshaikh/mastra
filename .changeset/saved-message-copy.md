---
'@mastra/server': minor
'@mastra/client-js': minor
---

Added an authenticated edit command for saved user messages. It creates a separate conversation and submits the replacement through AgentController. The source session remains unchanged.

```ts
const newThreadId = crypto.randomUUID()
const edited = await sourceSession.editMessage({
  messageId: 'message-to-edit',
  content: 'The corrected message',
  newThreadId,
  newSessionScope: newThreadId,
})
```

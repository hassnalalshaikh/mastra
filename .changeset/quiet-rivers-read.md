---
"@mastra/core": minor
"@mastra/pg": minor
---

Added `listMessagePageByResourceIdAndRole()` to read one role within an existing resource history page. PostgreSQL skips transferring other roles' content on ordinary page reads.

```ts
const page = await memoryStore.listMessagePageByResourceIdAndRole({
  resourceId: 'example-person',
  role: 'user',
  page: 0,
  perPage: 100,
});
```

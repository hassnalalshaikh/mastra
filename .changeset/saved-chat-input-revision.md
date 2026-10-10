---
'@mastra/core': minor
'@mastra/memory': minor
'@mastra/pg': minor
---

Add Session.editMessage to correct a saved user input and replace its later replies on the same thread. Native thread ownership guards the revision and delivery; unsupported stores refuse. PostgreSQL and InMemory rewrite the saved history atomically. Memory removes affected-thread recall before saving and resets thread-derived context while retaining resource memory. A saved edit remains saved if answer startup fails, with no automatic replay.

---
'@mastra/pg': minor
---

Added atomic reservation and durable storage for agent schedule run limits. Concurrent or duplicate deliveries cannot exceed the saved limit, including after reconnecting.

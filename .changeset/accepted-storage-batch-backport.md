---
'@mastra/core': patch
---

Backported the accepted [storage batching fix](https://github.com/mastra-ai/mastra/pull/22828) so published records fetch their active versions together. This preserves active-version selection and the existing fallback when an active version is missing. PostgreSQL adapters with `getVersions` support can resolve a full skill catalog in one batch.

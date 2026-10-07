---
"@mastra/cloudflare-sandbox": patch
---

Fixed required bucket mounts so file operations stop when storage cannot be verified or reconnected. Added private R2 binding mounts without storage keys in the container.

Fixed first file use to start the native sandbox and process pending mounts, including sandboxes resolved for each chat.

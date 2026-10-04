---
'@mastra/core': patch
'@mastra/server': patch
'@mastra/client-js': patch
---

Follow one message by id from the queue into the transcript. `session.followUps.list()` (and `displayState.queuedFollowUpItems`) now lists each follow-up's `files` by type and name, and the user message a follow-up becomes carries the follow-up `id` (also when it is sent now with `steerFollowUp()`). `sendMessage()`, `steer()` and `followUp()` accept an optional `id`; the messages, steer and follow-up routes choose it on the server and return it as `messageId` in their ack, and client-js returns that ack. A queued signal message that names its own `id` keeps it.

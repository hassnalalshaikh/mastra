---
'@mastra/core': patch
---

Stop and steer now reach a durable run that the caller did not start itself, such as a run the follow-up queue started. Aborting a thread (`subscription.abort()`, `Session.abort()`, `Session.steer()`, `steerFollowUp()`) only flipped the thread runtime's prepared controller, which a durable run never has, so a queue-started durable run kept generating to the end while the session showed it as stopped. The thread runtime now stops such a run through the agent that owns it (`abortRunStream`), the same way it already handles an abort request from another process.

---
'@mastra/core': patch
---

Fixed a Stop on a durable run reopened in a new session leaving the stopped run's stored rows behind when the stopped state could not be saved: the outer row was kept as failed and the inner row stayed running. A Stop now always removes the stopped run's rows. Other failures still keep them when their failure history could not be saved.

---
'@mastra/core': patch
---

Evented (and scheduled) workflow runs orphaned by a process restart can now be recovered. Set `options.autoRestartActiveRuns: true` on the workflow and `recovery: { workflows: 'auto' }` on `Mastra` (or call `mastra.restartAllActiveWorkflowRuns({ optedInOnly: true })`); the opted-in runs restart once workers start. Because the evented engine does not record its active position while running, the restart position is recovered from the step graph and the recorded results (sequential steps, parallel branches, foreach iterations, nested workflows); positions it cannot recover are refused. `autoRestartActiveRuns: false` opts a workflow out of the generic sweep, as upstream.

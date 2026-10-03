---
'@mastra/core': patch
---

Add `recovery.dynamicWorkflows: 'auto' | 'off'` to the `Mastra` config. A dynamic (stored-definition) workflow carries no workflow `options`, so it could not opt out of the boot-time `restartAllActiveWorkflowRuns()` with `autoRestartActiveRuns: false`. With `'off'`, active runs of workflows registered through `addDynamicWorkflow()` or loaded from the `workflowDefinitions` store are left as stored at boot. The default, `'auto'`, keeps today's behavior.

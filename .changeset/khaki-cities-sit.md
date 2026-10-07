---
'@mastra/core': minor
---

Added opt-in durable context selection and validation so saved runs keep their original choices while current permissions stay fresh.

```ts
const agent = new Agent({
  id: 'assistant',
  name: 'Assistant',
  instructions: 'Help the user.',
  model: 'openai/gpt-4o',
  durable: {
    resumeRequestContextKeys: ['selection'],
    resumeRequestContextSchema: z.object({
      selection: z.object({ modelId: z.string() }),
    }),
  },
});
```

Selected values must be complete plain JSON. Initial input and prepared execution
values are saved separately. Resumes restore only those original values before
dynamic defaults and model selection; all other current values and omissions stay
current. Changed key sets or invalid saved values refuse resume. Without the
options, existing behavior is unchanged.

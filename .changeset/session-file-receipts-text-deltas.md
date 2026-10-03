---
'@mastra/core': minor
---

Added file-bearing Session commands with exact delivery receipts and run-bound assistant text events. Incremental consumers can receive new answer text before the run finishes without reading reasoning or comparing message snapshots.

```ts
const unsubscribe = session.subscribe(event => {
  if (event.type === 'text_delta') {
    console.log(event.runId, event.messageId, event.textDelta);
  }
});
const delivery = session.sendMessageWithReceipt({
  content: 'Summarize the notes.',
  files: [{ data: 'Meeting notes', mediaType: 'text/plain', filename: 'notes.txt' }],
});
const accepted = await delivery.accepted;
console.log(accepted.runId, accepted.action);
```

Subscribe before sending because text can arrive before acceptance resolves. Delivery acceptance isn't run completion. Existing `sendMessage` and display events keep their behavior.

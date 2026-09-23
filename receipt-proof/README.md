# Session command acknowledgement reproduction

This no-network test reproduces false successful acknowledgements on official Mastra commit `2a832580e3cf3efcdb4be3355eaa9a02929b3a2c`.

The test loads the exact original Session and server handler source from that commit. The controller lookup is a small fixture returning a real Session. No model, provider, database, or acceptance method is mocked.

From this repository checkout, install and build the internal test dependencies:

```sh
pnpm --filter @mastra/core... --filter @mastra/server... install --frozen-lockfile --ignore-scripts
pnpm --filter '@mastra/core^...' --workspace-concurrency=1 run --if-present build:lib
pnpm --filter '@internal/ai-*' --filter @internal/auth --filter @internal/voice --workspace-concurrency=1 run --if-present build
pnpm --filter @internal/test-utils build
pnpm --filter @mastra/schema-compat build
pnpm exec vitest run --config receipt-proof/vitest.config.ts
```

The two tests pass by asserting the faulty behavior: a stale approval leaves the real gate armed but returns `{ ok: true }`; the accepted and duplicate approval also return the same response; a missing question returns `{ ok: true }` without a pending suspension.

This proves the original native handler boundary. It does not claim a real browser, socket server, provider, or process-recovery test.

---
"@mastra/browser-firecrawl": minor
---

Added optional HTTP transport bounds for hosted browser sessions, recorded-session cleanup and HTTP browser discovery. Existing native lifecycle and omitted-option defaults stay unchanged.

```typescript
import { FirecrawlBrowser } from "@mastra/browser-firecrawl";

const browser = new FirecrawlBrowser({
  apiKey: process.env.FIRECRAWL_API_KEY,
  clientOptions: { timeoutMs: 20_000, maxRetries: 1, maxRedirects: 0 },
});
```

Use the paired SDK transport contribution that provides `maxRedirects: 0`. The SDK counts `maxRetries` as total attempts, so `1` sends one request. The contribution archive remains version0.2.3 until normal versioning is applied.

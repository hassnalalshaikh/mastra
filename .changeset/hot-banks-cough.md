---
'@mastra/core': patch
---

Preserve unknown provider usage through native stream and durable aggregation instead of reporting partial totals as complete.

Primary counts are known only when every contributing model step reports them. Missing counts remain unknown in either order, through native state serialization and late finish metadata. Measured zero and finish-only usage remain valid. Totals are derived only from complete input/output counts, without counting reasoning tokens twice. Older snapshots without completeness information cannot retroactively establish missing counts.

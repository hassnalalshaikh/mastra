# Reviewed transport artifact v9

This contribution preserves the already reviewed private runtime archive. `provenance.json` binds the exact source commit, all package source files, dist/DTS files, production manifest, archive checksum and paired source commits. The metadata commit containing this recipe follows the recorded transport source commit.

The unchanged native tsdown0.22.9 configuration produced the qualified native dist/DTS with the paired SDK declarations. V2/V3 retain exact native build/typecheck/19-test evidence and documented audit-only tool-import/type-root adaptations. The stock SDK of the same version does not supply this new contract. A fresh normal full source build and supported source dependency resolution remain separate from this byte-preserving pack recipe; do not change the monorepo lock before the distribution route review.

Run the normal pack recipe with Node24.21.0, the recorded pnpm10.11.0 CLI, the qualified build output and a new output directory outside the repository:

```bash
node artifact/transport-v9/pack-reviewed.mjs --dist /path/to/qualified/dist --out /path/to/new/pack-output --pnpm /path/to/pnpm10.11.0/bin/pnpm.cjs
```

The script normalizes checkout CRLF to canonical LF for source and runtime-manifest text. It checks source hashes, source ancestry, all dist/DTS hashes, the exact production manifest and tool identity before calling normal `pnpm pack` with scripts disabled. It checks the resulting SHA256 and SRI against the reviewed archive. It performs no install, build, lock edit, publication or provider operation.

The native runtime manifest omits development-only workspace/catalog dependencies and pins the paired SDK version4.25.1. That version alone cannot distinguish the patched SDK from stock. Source build and consumer dependency identity must bind the exact reviewed SDK archive; the canonical source manifest and monorepo lock are deliberately unchanged pending distribution review.

The SDK and native pair remain private. pnpm11.3 can refuse a HTTPS URL as an overridden child before deduplication, even when the URL is also a direct dependency. Do not disable `blockExoticSubdeps` or treat a direct declaration as distribution proof. Published asset URLs, release tag and source PR URLs stay null until their actual owned publication stages.

V9 proves the original SDK subtree and the recorded private browser slice. It does not prove the full Root peer graph, a deployed browser lifecycle or provider billing.

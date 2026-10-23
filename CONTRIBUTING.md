# Contributing

## Local checks

Use Node.js 18 or newer and run from the repository root:

```powershell
npm ci --ignore-scripts --offline
npm test
npm run test:e2e:local
node --check index.js
npm pack --dry-run --ignore-scripts --offline
```

The end-to-end runner uses loopback mocks and isolated OpenCode state. Do not
use provider credentials or real services in automated tests.

## Changes

- Preserve the V2 plugin contract `{ id, setup }`.
- Keep the plugin disabled by default and fail closed when runtime evidence is
  missing.
- Add a regression test before changing fallback, context, compaction, logger,
  installer, or packaging behavior.
- Do not commit credentials, logs, databases, caches, generated packages, or
  private provider responses.
- Update the changelog and relevant ADR when a public behavior or architectural
  decision changes.

Pull requests should include the commands run, the OpenCode version tested, and
any known compatibility limitation.

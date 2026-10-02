# Architecture and provenance

This edition reuses the maintainer's older MMM `public-app` beta.4 through an
explicit file allowlist, without private Git history. Its prior evaluation-only
license is replaced by MIT for this edition at the maintainer's request to
open-source it. No third-party runtime package is vendored.

No Antigravity adapter, research workspace, account settings, SSH keys,
deployment environments, browser profiles or user databases are imported.

```text
Browser (plain HTML/CSS/JS)
  -> authenticated, origin-checked loopback HTTP
  -> server.cjs
     -> storage.cjs / node:sqlite: projects, tasks, artifacts, review evidence
     -> vault.cjs: session credentials
     -> providers.cjs + provider-policy.cjs: restricted, consented AI requests
     -> team.cjs: sequential discussion and coordinator synthesis
     -> markdown-exchange.cjs: explicit task metadata exchange

Optional Electron shell (not bundled)
  -> sandboxed renderer / preload.cjs / validated native IPC
  -> explicit file references, OS safeStorage and manual CLI launching
```

Node 24+ supplies SQLite. The separate `MMM-Community` data/app identity avoids
opening the original application database. Manual CLI and browser opening are
not authenticated autonomous workers. There is no hidden private worker.

`scripts/package-source.cjs` enumerates every permitted source, test and document.
Symlink inputs are rejected. Runtime text is scanned for private integrations,
personal paths and credential literals; the logo is pinned by SHA-256. The
manifest records every included byte. Scripts and synthetic tests contain
blocked canary strings for regression checks, not integrations.

These checks are not a formal security audit or proof that an AI provider is
safe. Review every future allowlist change and all contributed assets.

# Local validation - 2026-10-02

Edition: 0.1.0-beta.1. Platform: macOS. No paid provider calls were made.

## Automated

- Node 26: 188 tests pass, zero failures or skips.
- Node 24: independently extracted source archive, 188 tests pass.
- Source artifact is allowlisted and its extracted bytes match the reviewed
  SHA-256 manifest. Archive owner/group metadata is normalized.
- Runtime scan excludes private integrations, credential literals and personal
  filesystem paths. Original MMM logo bytes are hash-pinned.
- Tests cover session/origin guards, provider policies, vault behavior, team
  execution, source permissions, storage, task review and release boundaries.

## Browser smoke test (Playwright / Chromium)

- 1440 x 1000: welcome page in Traditional Chinese and English.
- 390 x 844: welcome and project note workflow, no horizontal overflow.
- Create a synthetic project, save a note, and view it in the conversation.
- Apply design preset after confirmation: four expected roles; all provider
  selections remain empty. No task is started.
- Narrow-screen team view: document width remains 390 pixels.
- Browser console: zero errors and warnings during this flow.

Local screenshots are development artifacts, not packaged user data.

## Not established by these checks

The initial hosted run found non-hermetic macOS CLI tests on Linux and native
Windows incompatibilities (permissions, open-file lifecycle, migration fsync,
source paths and test fixtures). The CLI tests now explicitly model macOS and
separately assert Linux/Windows CLI rejection. Runtime platform guards are not
weakened. Native Windows is unsupported in this beta, with manual diagnostic CI
retained rather than representing failing tests as a supported release.

Physical-device testing, screen-reader audit, live
provider/model availability, desktop installer signing, native end-to-end
integration, and independent security assessment remain outstanding at the time
of this local validation. See GitHub Actions for subsequent hosted CI results.
Publication uses the separately authorized `jacbus1/mmm-community` repository;
the original private repository is unchanged.

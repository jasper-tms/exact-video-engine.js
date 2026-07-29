---
name: developing
description: Load before building, testing, committing, or releasing in the exact-video-engine.js repo, and for questions about how to do any of those — the root exact-video-engine.js file is generated from src/, git hooks enforce it, and releases are cut by editing the VERSION file. Points to DEVELOPING.md.
---

# Developing in this repo

Read **DEVELOPING.md** at the repository root. It covers:

- `exact-video-engine.js` at the root is *generated* from `src/` by
  `node build.mjs` — edit `src/`, rebuild, and commit both together.
- Running the tests (`bash test/run-tests.sh`); the suite's design rationale
  is in the sibling implementation-details skill's `testing.md`.
- Releasing: editing `VERSION` on `main` is the whole release, and
  `.githooks/sync_version.sh` derives every pinned version from it.
- Getting the checked-in git hooks to actually run.

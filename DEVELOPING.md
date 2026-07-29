# Developing exact-video-engine.js

## Building

The engine's source lives in `src/` as ES modules — one per concern (the range
readers, the Matroska scan, `ContainerIndex`, the two engines, the ladder) — so
each piece can be read, edited, and tested in isolation (the parsers import
into plain Node, no browser required). `exact-video-engine.js` at the repo root
is *generated* from them:

```sh
node build.mjs           # rewrite exact-video-engine.js from src/
node build.mjs --check   # verify it is in step; pre-commit and CI both run this
```

The build only drops the module import/export syntax and concatenates in
dependency order — no minification, no renaming — so the shipped file reads
line for line like the source. Edit `src/`, run the build, and commit both
together; the pre-commit hook refuses a commit that lets them drift, and the
release workflow re-checks before tagging.

Bundler consumers do not use the generated file at all: `import` resolves to
`index.mjs`, which re-exports the same names from the modules in `src/`.

## Tests

`test/` needs `ffmpeg` on the PATH and Playwright (`npm install`):

```sh
bash test/run-tests.sh
```

What each test pins, why the fixture clips are shaped the way they are, and
what would silently pass without each case is documented in
[agent-skills/implementation-details/testing.md](agent-skills/implementation-details/testing.md)
— read it before adding or modifying tests.

## Releasing

`VERSION` holds the version and nothing else. Editing it on `main` is the whole
release: a [workflow](.github/workflows/release.yml) tags that commit `vX.Y.Z`
and cuts a GitHub release from it.

The pinned jsDelivr URLs in `demo.html`, the README, the user-guide skill, and
the `version` field in `package.json` are *derived* from `VERSION` by
`.githooks/sync_version.sh`, which `.githooks/pre-commit` runs for you, so they
land in the same commit that changes `VERSION`. A release is then:

```sh
echo 1.3.0 > VERSION
git commit -am "Release v1.3.0"   # the hook repoints the pins, in this commit
git push                          # the workflow tags v1.3.0 and releases it
```

The hook only wakes up for a commit that touches `VERSION`, and it refuses to
run if any of the pinned files have unstaged changes, rather than quietly
sweeping them into the release commit.

### Getting the hook to run

Git never runs hooks out of the working tree. They live in `.git/hooks`, which
is not part of the repository and is not cloned — deliberately, so that cloning
a repo cannot make it execute code on your next commit. A checked-in
`.githooks/pre-commit` therefore does nothing on its own, and needs one of:

- **Nothing**, if you use the [shell-configs](https://github.com/jasper-tms/shell-configs)
  global hook dispatcher *and* this repo's `origin` is an account you listed in
  its `git-hooks/trusted-remotes`. The dispatcher finds `.githooks/<hook-name>`
  by itself.
- **One command**, if you use that dispatcher but this repo is not one of yours
  (you cloned or forked it, so `jasper-tms` is not in your trusted list). The
  dispatcher will otherwise skip the hook and say so on stderr:

  ```sh
  git config hooks.allowRepoHooks true
  ```

- **A symlink**, if you do not use that dispatcher at all:

  ```sh
  ln -s ../../.githooks/pre-commit .git/hooks/pre-commit
  ```

Do **not** point `core.hooksPath` at `.githooks`. It would work, but only by
shadowing whatever global hooks you already have, silently and everywhere in
this repo — which is exactly the failure the dispatcher exists to avoid.

If the hook never runs, nothing breaks — it only gets noisier. The release
workflow re-derives the pins with `.githooks/sync_version.sh --check` and
refuses to tag a commit that disagrees with `VERSION`, so the failure mode is a
red CI run rather than a published tag whose demo page loads the previous
release. (Tags are immutable and jsDelivr caches them forever, which is why
that check exists at all.) To recover: run `.githooks/sync_version.sh`, commit,
push.

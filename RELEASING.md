# Releasing

A release is a **git tag**. Publishing is automated from the tag so that what
ships to npm is exactly the tested, tagged commit — see
`.claude/plans/versioning-and-release.md` for the design.

## One-time setup (maintainer)
Pick one publish credential:
- **Trusted Publishing (recommended, tokenless):** configure OIDC for
  `@bluearch/mission-control` on npmjs.com → Package → Settings → Trusted
  Publisher → GitHub Actions (`.github/workflows/release.yml`). No secret needed.
- **or NPM_TOKEN:** create an npm *automation* token, add it as the repo secret
  `NPM_TOKEN` (Settings → Secrets → Actions).

## Cut a release
From a clean `main` (all PRs merged, suite green):

```bash
git checkout main && git pull
# choose one — bumps package.json, runs tests (preversion), commits, tags,
# and pushes commit+tag (postversion):
npm version patch   # bug/crash/perf fix, no new surface   → 1.1.0 → 1.1.1
npm version minor   # new backwards-compatible surface      → 1.1.0 → 1.2.0
npm version major   # breaking hotkey/config/CLI change      → 1.1.0 → 2.0.0
```

Update `CHANGELOG.md` in the **same commit** as the bump (add the dated section
before running, or `--amend` after). Then the pushed `vX.Y.Z` tag triggers
`.github/workflows/release.yml`:

1. **verify matrix** (macOS + linux × Node 20 + 22) — on each cell: `npm ci &&
   npm test`, then `npm run verify:pack`. The publish job `needs:` all four cells
   green (see the tarball gate below),
2. asserts the tag matches `package.json`,
3. `npm publish --provenance --access public` (provenance links the tarball to
   this commit + CI run — the community can verify it at
   `npm view @bluearch/mission-control`),
4. creates a GitHub Release.

## The tarball gate (`npm run verify:pack`)
`npm test` exercises the **working tree**; it cannot catch a file missing from
`package.json` `files:`, a runtime dep that only resolves from your dev
`node_modules`, or a node-pty spawn-helper that crashes on a fresh install —
exactly the bugs that turn a clean local run into a broken
`npx @bluearch/mission-control`. `scripts/verify-pack.mjs` tests the *published
artifact* instead:

- **PACK** — `npm pack` (the exact tgz npm would ship; repo stays clean).
- **MANIFEST** — the critical files are in the tarball.
- **INSTALL + BOOT** — install the tgz into a throwaway temp dir with an empty
  `$HOME` + `MC_CONFIG_DIR` and `--omit=dev`, then run `MC_SMOKE=1 mc`
  (`tui/selfCheck.mjs`): the full import graph resolves and a real
  `pty.spawn('echo','hi')` succeeds. This is the ground-truth pass — if it's
  green, "install is simple" is *verified*, not asserted.
- **NPX-SELFHEAL** — reinstall with `--ignore-scripts` (npx skips postinstall)
  and break the spawn-helper exec bit: the runtime self-heal (`fixNodePty`) must
  repair it and still boot.
- **NEGATIVE-CONTROL** — same broken helper with self-heal disabled *must* fail.
  A green-only verifier proves nothing; this confirms the harness catches the
  real `posix_spawnp` break.

Run it locally before cutting any release: `npm run verify:pack` (exit 0 = safe
to publish). `MC_VERIFY_KEEP=1` keeps the temp dirs for inspection; `--report
<path>` writes a machine-readable summary.

## Verify
```bash
npm view @bluearch/mission-control version   # == the tag you pushed
npx @bluearch/mission-control@latest         # runs the shipped build
```
In-app, the header shows `version + short-sha` (`tui/lib/version.js`) so you can
confirm a running instance matches a published release.

## Manual publish (fallback, discouraged)
If you must publish locally: `npm login`, ensure a clean tree at the tag, then
`npm publish`. The `prepublishOnly` guard refuses a dirty/untagged tree; override
only with `FORCE_PUBLISH=1` and know why.

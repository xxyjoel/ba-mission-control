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

1. `npm ci && npm test` on the exact tagged tree,
2. asserts the tag matches `package.json`,
3. `npm publish --provenance --access public` (provenance links the tarball to
   this commit + CI run — the community can verify it at
   `npm view @bluearch/mission-control`),
4. creates a GitHub Release.

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

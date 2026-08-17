# Public release checklist

Pre-flight for making BlueArch Mission Control public and publishing
`@bluearch/mission-control` to npm. Work top-to-bottom; nothing here is
automated by CI because each step needs a human decision or an account action.

## 1. History & privacy (decide first — irreversible once public)

Working tree is clean of secrets and personal data. **Git history still
contains** personal data — home-directory paths, a personal email in old blobs,
and commit-author metadata (a personal email + a local machine hostname). No
API keys/tokens exist anywhere (audited: 0 hits across all 2,535 blobs / 378
commits). Pick one:

- [ ] **Accept history** — normal for solo OSS (author email is expected), or
- [ ] **Squash to a clean single commit** via an orphan branch (recommended if
      you want the paths/hostname gone), or
- [ ] **`git filter-repo`** to redact paths + rewrite author (preserves history
      shape; rewrites all SHAs).

## 2. Secrets hygiene (done / verify)

- [x] Full-history secret scan — clean (keys, tokens, webhooks, private keys).
- [x] `.gitignore` blocks `settings.json`, session/cost state, `.env`, keys.
- [ ] Do **not** commit `tasks/archive/batch-*` or `.claude/plans/` — they carry
      personal paths (plans are now gitignored).
- [ ] (Optional) Run `gitleaks detect` / `trufflehog git file://.` as a second
      opinion before flipping public.

## 3. GitHub repo settings (Settings → …)

- [ ] **Code security**: enable *Secret scanning* + *Push protection*.
- [ ] **Code security**: enable *Private vulnerability reporting* (powers
      SECURITY.md's disclosure channel).
- [ ] **Dependabot**: enable alerts + security updates (config in
      `.github/dependabot.yml`).
- [ ] **Branches**: protect `main` — require PR review + passing `forge-ci`.
- [ ] **Pages**: Build from `main` → `/docs` (serves the landing page).
- [ ] Set repo description + topics (`claude-code`, `tui`, `agents`,
      `tmux-alternative`) and upload a 1280×640 **social preview** image.

## 4. Content still needed (tracked in the task db)

- [ ] BlueArch brand kit → finalize `docs/assets/tokens.css`.
- [ ] Generate demo GIFs: `brew install vhs && vhs tapes/hero.tape` →
      commit `assets/hero.gif` to `main` (README + landing reference it).
- [ ] Fill the CoC enforcement contact in `CODE_OF_CONDUCT.md`.

## 5. npm publish (`@bluearch/mission-control`) — DONE 2026-08-17

- [x] Confirm the `@bluearch` npm org exists and you're a member
      (`bluearchgroup`, owner).
- [x] Enable **2FA** on the npm account (`auth-and-writes`).
- [x] `npm publish --dry-run` → tarball is exactly the `files` allowlist
      (77 files: bin/tui/server + fix-node-pty + README + LICENSE).
- [x] `npm publish` — `1.1.2` live, dist-tag `latest`. Note: the browser-OTP
      flow needs a live interactive terminal; approving after the CLI exits
      uploads nothing.
- [x] Smoke test: clean-shell `npx` → `MC_SMOKE_OK 1.1.2`.
- [ ] Register the OIDC trusted publisher (npmjs.com → package → Settings →
      Trusted publisher: repo `xxyjoel/ba-mission-control`, workflow
      `release.yml`) so future tags publish from CI.

## 6. Tag the release

- [x] `v1.1.2` tagged and pushed (cut via `npm version`; suite green).
- [ ] Cut a GitHub Release with the hero GIF + a short "what is this" blurb.

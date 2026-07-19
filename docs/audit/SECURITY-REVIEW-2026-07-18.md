# Security Review — Product Hunt release readiness

**Date:** 2026-07-18 · **Scope:** entire tracked tree + full public git history ·
**Repo:** `ba-mission-control` (PUBLIC, AGPL-3.0) · **Verdict:** **SHIP** (the one
Medium finding below was fixed in this pass).

This review answers three explicit asks for the public launch: (1) no "glass
worm"-class malware, (2) no secret keys in the present repo **or** git history,
(3) general code-security go/no-go. It combines deterministic scans with a
full-tree `forge-security-reviewer` audit.

## Summary table

| Class | Result |
|---|---|
| Glass worms (invisible Unicode, bidi, tag chars, obfuscation) | ✅ Clean |
| Secret keys — working tree | ✅ Clean |
| Secret keys — full git history (all commits/blobs on `origin/main`) | ✅ Clean |
| Supply chain (deps, lockfile, install hooks) | ✅ Clean |
| Command / argv injection | ✅ Clean |
| Path traversal / arbitrary file access | ✅ Clean (one guard-consistency nit) |
| PII in file content | ✅ Clean |
| PII in commit metadata | ⚠️ Minor (author email — see below) |
| Terminal-escape passthrough (prompt-injection surface) | ⚠️ 1 Medium — **FIXED 2026-07-18** |

## Glass-worm / supply-chain scan

- **Invisible Unicode:** scanned every tracked text file for zero-width
  (U+200B–200F, 2060–2064, FEFF), bidi overrides (U+202A–202E), Unicode tag
  chars (U+E0000–E007F), and variation selectors. Only two hits, both benign: a
  `⚠️` emoji in `docs/audit/KEYBINDINGS.md` and a deliberate ZWJ family-emoji in
  `tests/lib/format.test.mjs` (a grapheme-handling test). **No tag chars, no
  bidi overrides, no zero-width in source.**
- **Obfuscation / dynamic exec:** no `eval`, `new Function`, or dynamic/network
  `require` in tracked source.
- **Dependencies:** 5 runtime (`@xterm/headless` 6.0.0, `ink` ^5, `node-pty`
  1.1.0 pinned, `react` ^18.3.1, `tsx` ^4.19) + 1 dev (`ink-testing-library`).
  All first-party/well-established, no typosquat candidates. OSV.dev returns
  zero advisories for node-pty 1.1.0 / tsx / ink / @xterm/headless; the only
  React advisory is a 0.5.x DOM-XSS, N/A to React 18.3.1 under a terminal
  renderer with no DOM.
- **Install hook:** the sole `postinstall` (`scripts/fix-node-pty.mjs`) is a
  best-effort `chmod +x` on node-pty's prebuilt spawn-helper — no network, no
  download, try/catch-wrapped.

## Secrets & PII

- **Working tree & full history:** scanned every commit/blob reachable from
  `origin/main` (8-commit clean squash) for AWS keys, `sk-`/`sk-ant-`,
  `ghp_`/`github_pat_`, Slack tokens, Google API keys, and PEM private-key
  headers → **zero matches**. No `.env`/`.pem`/`.key`/`id_rsa`/`credentials`
  file was ever committed. `.gitignore` covers `.env*`, `*.pem`, `*.key`,
  `**/settings.json`, `sessions.json`.
- **PII in content:** none in the current tree or any diff.
- **PII in commit metadata (⚠️ minor):** 7 of 8 public commits are authored as
  `joelproctor@joels-MacBook-Pro.local` (git's auto-generated local identity —
  exposes a username + machine hostname; not a secret, not a real address). The
  8th uses the GitHub noreply address. **Recommendation: do not rewrite history**
  — the 8 commits are already public and a rewrite would break the 6 open
  Dependabot PRs and change every SHA for zero security gain. Set
  `git config user.email` to the GitHub noreply address so future commits are
  clean.
- **Network egress:** limited to a single user-configured Slack webhook
  (`server/slack.js`), URL-validated to `https://hooks.slack.com/`, stored in
  gitignored settings, never logged.

## Code-security findings

### MEDIUM — Terminal-escape passthrough in Fleet Log — **FIXED 2026-07-18**
`tui/FleetLog.jsx` routed only `tool`/`sys`/`think` kinds through `humanize()`
(the escape stripper); `asst`/`user`/`bcast`/`err` rendered raw. Since `asst`
text comes verbatim from the untrusted `claude` stream (`server/agent.mjs`,
`server/jsonlConnector.mjs`), injected ANSI/OSC escapes (e.g. OSC-52 clipboard
write, screen clear) reached the host terminal from the **passive** fleet view,
no zoom needed. **Fix applied:** all kinds now route through `humanize()`
(strips OSC/CSI/C0, then cosmetically collapses paths/UUIDs/JSON). `FleetLog`
suite green (7/7). `Card.jsx` was already safe.

### LOW — OSC-52 clipboard passthrough in zoom PTY
`server/ptyAgent.mjs` / `tui/zoom/PtyPane.jsx` forward OSC-52 to `process.stdout`
(intentional clipboard integration). A hostile zoomed session could overwrite
the system clipboard (paste-hijack). Requires the user to actively zoom into a
compromised session. **Recommendation:** gate behind an opt-in setting (default
off). *Follow-up, not launch-blocking.*

### LOW/INFO — sessionId UUID-guard inconsistency (legacy path)
The legacy stream-json `Agent` (`server/agent.mjs`, `FLEET_USE_PTY=0` — not the
runtime default) reassigns `this.sessionId` from the CLI init event without the
`UUID_SHAPE` guard that `sessionFileTailer`/`statusFile` apply before path-join.
CLI-emitted (not user/model-controlled), so not practically reachable.
**Recommendation:** apply the guard or delete the legacy path (tracked as forge
task 0304/0305). *Follow-up.*

### Clean classes (stated explicitly for the go/no-go)
- **argv injection — clean.** Every subprocess spawn is argv-form
  (`execFile`/`execFileSync`/`spawn` with array args); no `shell:true`, no
  string-interpolated `exec`. `CLAUDE_BIN` (untrusted) only ever passed as
  `argv[0]`.
- **Path traversal — clean** (modulo the LOW nit): `claudeSessionPath` /
  `statusFilePath` UUID-guard before path-join; settings persistence is a fixed
  path with atomic tmp+rename.
- **CI — clean:** `.github/workflows/forge-ci.yml` uses pinned major action
  versions, no `pull_request_target`, no untrusted PR data in shell steps.

## Non-security note — repo drift
The public repo is no longer "main-only" (as HANDOFF states): Dependabot has
created 6 branches + 6 open PRs (`refs/pull/1–6`). All are clean single-commit
dependency bumps (verified: 0 PII, based on the clean `origin/main`). Decide
whether to merge/close them before the launch push.

## Method (reproducible)
Deterministic scans: invisible-Unicode perl regex over `git ls-files`; `rg`
secret-pattern scan of tree + `git log -p origin/main`; `git rev-list --all
--objects` filename audit; author-metadata reconciliation. Plus a full-tree
`forge-security-reviewer` audit (argv/path/injection/supply-chain/render).

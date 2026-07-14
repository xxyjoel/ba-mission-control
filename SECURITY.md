# Security model — BlueArch Mission Control

Mission Control (`mc`) is a **single-user, localhost-only** terminal TUI that
supervises up to N real `claude` CLI subprocesses. It has **no network
listener, no HTTP server, no auth layer, and no multi-user surface** (see
`CLAUDE.md` → Non-goals). The security surface is therefore: the environment it
trusts, the secrets it stores, the untrusted session content it renders, and
how it spawns subprocesses.

This document enumerates each.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
suspected vulnerability. Use GitHub's private vulnerability reporting:

> Repo **Security** tab → **Report a vulnerability** (GitHub → Security Advisories).

This routes the report confidentially to the maintainers. We aim to acknowledge
within a few days. Because `mc` is a single-user, localhost-only tool with no
network listener, the practical attack surface is narrow (see boundaries below),
but we take input-handling and subprocess issues seriously.

## Supported versions

Security fixes target the latest released version on `main`. Older tags are not
backported.

## Trust boundaries

| Source | Trust | Why |
|---|---|---|
| The user running `mc` and their env vars | **Trusted** | Single-user tool; the operator already has shell access on the box. |
| `claude` subprocess **session content** (assistant text, tool output, tool/model/branch names, files claude `Read`s) | **Untrusted** | Attacker-influenceable — a fetched page, a malicious repo file. Painted to the real terminal. |
| `CLAUDE_BIN` (as a spawn target) | **Untrusted-for-shell-safety** | Even though user-set, it is the program path we exec — never interpolated into a shell string. |
| On-disk session transcripts (`~/.claude/projects/.../*.jsonl`) | **Untrusted** | Same as session content; parsed defensively (JSON.parse per line, no deep merge, sessionId UUID-validated before path-join). |

## Environment variables

All are read from the operator's environment (trusted source) but each has a
defined consumer and handling rule. None is ever interpolated into a shell.

| Var | Trust / role | Consumed by | Notes |
|---|---|---|---|
| `CLAUDE_BIN` | Untrusted spawn target | `server/ptyAgent.mjs`, `server/agent.mjs`, `tui/main.jsx`, `tui/lib/auth.js` | Path to the `claude` binary. **argv-form only** (`spawn`/`execFileSync` positional) — a hostile value like `/x; echo PWNED` is a literal filename, not shell-evaluated. Pinned by `tests/agent.security.test.mjs` (0110). |
| `ANTHROPIC_API_KEY` | **Secret** | `tui/lib/auth.js` (presence check only) | mc only checks whether it is set, to report auth status. It is **never logged** and never read into mc state; the actual key is inherited by the `claude` child via the process env. |
| `MC_MOCK` | Dev/test | `server/fleet.mjs`, `server/mockAgent.mjs` | Fixture name (`server/fixtures/<name>.jsonl`). Replays a recording instead of spawning real `claude`. Path is `join`ed under a fixed dir. |
| `MC_NO_TRANSCRIPT` | Test/runtime flag | `server/agent.mjs` | `=1` disables transcript persistence. |
| `REPO_PARENTS` | Power-user override | `server/repos.mjs` | Colon-separated parent dirs to scan for repos. Used for filesystem listing only (no spawn, no shell). |
| `FLEET_USE_PTY` | Rollback flag | `server/fleet.mjs` | `=0` falls back to the legacy stream-json `Agent`. |
| `MC_CONFIG_DIR` | Override | `tui/lib/configDir.js` | Forces the settings/state directory (default `~/.config/claude-mc`). |
| `MC_DEBUG` | Opt-in logging | `tui/lib/debugLog.js` | `=1` writes structured JSONL to `$XDG_STATE_HOME/claude-mc/debug.log`. Off by default; never writes to stdout/stderr. Records lifecycle/error events only — **do not** add secrets to dlog kv payloads. |
| `MC_DEBUG_KEYS` | Opt-in overlay | `tui/lib/debugKeys.js`, `tui/lib/TextField.jsx` | `=1` shows a keypress overlay for debugging input. |
| `XDG_STATE_HOME` | Path base | `tui/lib/debugLog.js` | Standard XDG base for the debug log. |

## Secrets at rest

- **`slackWebhook`** (`settings.json`, key `slackWebhook`): an optional Slack
  Incoming Webhook URL used by `:feedback` / `:request` (`tui/lib/slack.js`).
  Set via `:slack <url>`; hidden from the Settings UI (shown only as
  `◆ yes (hidden)`). **It is stored in plaintext** in `settings.json` and is
  **not encrypted at rest**. TODO(slack): a leaked `settings.json` leaks the
  webhook — anyone with the URL can post to that Slack channel. Treat the file
  as sensitive (mode 600 on the config dir is recommended).
- **`ANTHROPIC_API_KEY`**: never persisted by mc (env-only; see above).
- **`settings.json`** otherwise holds only non-secret preferences (theme,
  density, cost caps, model defaults, etc.) under `~/.config/claude-mc/` (or
  `MC_CONFIG_DIR`). Written atomically (tmp + rename) to avoid corruption.

## Untrusted session content → terminal

Session content is attacker-influenceable yet painted to the operator's real
terminal even in the non-zoomed fleet view. Defenses:

- `humanize()` (`tui/lib/format.js`) strips **all** terminal escape sequences —
  OSC (incl. OSC-52 clipboard-write), CSI, other ESC-introduced forms, and C0
  control bytes — from every tier-2 preview and from `activity`, `branch`, the
  api-error tail, and `resolvedModel` before render (task 0181).
- `claudeSessionPath()` (`server/sessionFileTailer.mjs`) validates `sessionId`
  is a canonical UUID before path-joining, guarding `--resume` ids read off disk
  against path traversal.
- The JSONL tailer does `JSON.parse` per line with **no deep merge** into agent
  state — only known last-writer-wins fields are copied.

## Subprocess execution

Every subprocess is launched in **argv form** — `spawn(file, args, opts)` /
`execFile`/`execFileSync(file, args, opts)` — with **no `shell: true`** anywhere
in `server/` or `tui/`. Call sites: `server/ptyAgent.mjs` (claude PTY),
`server/agent.mjs` (legacy claude), `server/git.mjs` (`git`), `tui/main.jsx`
(`claude --version`), `tui/lib/auth.js` (`claude auth status`),
`tui/lib/version.js` (`git`), `tui/lib/modelProbe.js` (`claude -p`),
`tui/lib/tasks.js` (`gh`). User-controlled values (`CLAUDE_BIN`, repo paths) are
only ever passed as positional argv elements, so shell metacharacters in them
are inert. This is the `CLAUDE.md` rule, enforced by review and by
`tests/agent.security.test.mjs`.

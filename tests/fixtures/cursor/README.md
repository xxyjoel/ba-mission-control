# Cursor CLI spike fixtures (task 0420 phase 0)

Captured from **`cursor-agent` v2026.09.18-9a7762b** on 2026-09-22 via
`scripts/probe-cursor.mjs` against throwaway workspace `/tmp/mc-cursor-spike`.
Redacted copies of auth/usage payloads; PTY screens and step logs are real shape.

Fixture naming: `session.*` = main driven session (`session.pty.ndjson`,
`session.steps.ndjson`); `trust-*`, `plain-launch-ctrl-d.*`,
`random-resume-sigterm.*` = focused scenarios; `hooks.ndjson` = hook probe output
(not Cursor-native schema — see below).

## Spike answers (task 0420)

1. **`create-chat` / resume id** — Online `create-chat` ~1.6s, exit 0, prints uuid;
   no transcript/meta until `--resume` (`create-chat.json`: `transcriptAfterCreate` null).
   With `CURSOR_API_ENDPOINT=https://127.0.0.1:9`, still exit 0 and mints a uuid locally
   (~1.6s) — **does not spend quota on that probe**. `--resume <fresh create-chat id>`
   opens empty composer in ~6s (`random-resume-sigterm.ready.screen.txt`, `plain-launch-ctrl-d.*`).

2. **Transcript timing / shape** — Lines append incrementally during the turn
   (`session.steps.ndjson` `chat-state` vs `session.transcript.jsonl`); no separate
   `tool_result` role — results live in assistant `tool_use` + following assistant text.
   No approval lines in JSONL. Todos: `CallDynamicTool` / `TodoWrite` in transcript
   (`session.transcript.jsonl`); hooks also see `preToolUse` `Task` / `Shell`.
   Subagent = separate chat id (`session.subagent.transcript.jsonl`, `hooks.ndjson`).

3. **PTY screens (raw replay: `*.pty.ndjson`)** — Working:
   `session.t1-working-composing.screen.txt`, `session.t2-working-editing.screen.txt`,
   `session.t3-running.screen.txt`. Approval:
   `session.t3-approval-shell.screen.txt`, `session.t4-subagent-approval.screen.txt`.
   Trust: `trust-first-run.trust-prompt.screen.txt`. Ready composer:
   `session.ready.screen.txt`, `plain-launch-ctrl-d.ready.screen.txt`.
   **Update banner: not captured** (`about.sample.json` was `up_to_date`; unverified).

4. **Paste / submit** — Bracketed paste **on** at ready (`session.steps.ndjson`
   `bracketedPaste:true`; `probe-cursor.mjs` `submit()`). Paste + CR on same tick
   submits turns (`paste bp=true` + `submit-cr` before user lines in transcript).
   Slash commands via same submit path work (`/compact`, `/exit` in `session.steps.ndjson`;
   menu in `session.slash-menu.screen.txt`).

5. **Keybindings vs MC chrome** — ⌃U clears composer (`session.key-ctrl-u.screen.txt`).
   **⌃Y opens chat picker** (`session.key-ctrl-y-chat-picker.screen.txt`) — forwarded
   in zoom (MC scroll is ⌃B). ⌃K/⌃J often no-op or exit picker (`session.key-ctrl-k*.screen.txt`).
   ⌃Q types literal `q` in composer (`session.key-ctrl-q.screen.txt`) — no MC conflict.
   Shift+Tab cycles Agent/Plan/Ask/Debug (`session.key-shift-tab-*.screen.txt`).

6. **SIGWINCH** — Resize during shell approval redraws the dialog once, narrower
   (`session.t3-approval-shell.screen.txt` → `session.t3-approval-after-resize.screen.txt`;
   `session.steps.ndjson` `resize` ~83429 bytes before) — **no full double header
   like 0404** observed on this capture.

7. **Signals / exit** — SIGSTOP mid-turn: screen frozen on last frame
   (`session.t3-sigstopped.screen.txt`); SIGCONT resumes (`session.steps.ndjson`).
   SIGTERM → exit 143 (`random-resume-sigterm.steps.ndjson`). `/exit` → exit 0
   (`session.steps.ndjson` `exitCode:0`). Plain ⌃D → exit 0 (`plain-launch-ctrl-d.steps.ndjson`).

8. **Hooks** — Global `~/.cursor/hooks.json` honored when present; spike used a temp
   hooks file writing `hooks.ndjson`. `conversation_id`/`session_id` == chatId;
   `transcript_path` always **null** in payloads; `model` present; `preCompact` carries
   `context_usage_percent`, `context_tokens`, `context_window_size` (`hooks.ndjson`).
   Spawn env includes **`MC_SLOT_TOKEN`** when set on PTY (`hooks.ndjson` `mcValues`);
   foreign IDE session line shows **no** token (`sessionStart` scrubbed note).

9. **Local context / tokens** — Transcript JSONL has **no** usage. Footer shows
   `Composer 2.5 · N.N%` while running (`session.t3-running.screen.txt`). Hooks
   `stop`/`afterAgentResponse` include token fields; `preCompact` has context numbers.
   `about.sample.json` / `status.sample.json` do not expose live ctx; **`print-mode.result.json`**
   has `usage` + `request_id` for headless turns only.

10. **`meta.json.updatedAtMs`** — Moves on activity, not every assistant chunk
    (`session.steps.ndjson` `chat-state`: bumps with transcript growth and at turn end;
    `session.meta.json` final `updatedAtMs` matches last bump).

11. **Dashboard usage API auth** — **Yes, without browser cookie:** macOS keychain
    `cursor-access-token` (`security find-generic-password -a cursor-user …`) plus
    cookie `WorkosCursorSessionToken=<jwt-sub-tail>::<token>`; `status --format json`
    `userId` alone **failed**, jwt sub tail **HTTP 200** (`usage-events.sample.json`).

12. **Usage ↔ hook join key** — Events carry **`conversationId`** matching chatId /
    hook `conversation_id` (`usage-events.sample.json`, `hooks.ndjson`). No
    `generation_id` on usage rows; `print-mode.result.json` `request_id` **not** on
    dashboard events — attribute by **conversationId** (+ timestamp), not generation_id.

13. **Usage feed latency / IDE mix** — CLI turns appear in same account feed
    (`isHeadless:false` on probe events); subagent chat gets its own `conversationId`.
    Latency probe: event timestamp between print-mode t0–t1, visible on first poll ~5s
    after turn (`usage-events.sample.json` `latencyProbe`). **8 unrelated IDE events**
    in window (`otherConversationEventsInWindow`).

14. **Included-plan cost display** — Rows use `usageBasedCosts: "-"` with nonzero
    `requestsCosts` / `tokenUsage.totalCents` / `chargedCents` for included kinds
    (`usage-events.sample.json`). **Recommend:** card `costSession` from charged fields;
    optional API-equivalent from `requestsCosts` or `totalCents` (product decision D1
    already picks dashboard connector accounting).

## PTY detectors (`ptySignals.mjs` — codify against these fixtures)

Anchors are substring/regex on **bottom content rows** (see `probe-cursor.mjs` boot helpers).

| state | regex / anchor | fixture |
|-------|----------------|---------|
| trust | `/Workspace Trust Required/i` or `/Trust this workspace/i` | `trust-first-run.trust-prompt.screen.txt` |
| ready | `/(Plan, search, build anything\|→ Add a follow-up\|Add a follow-up)/` | `session.ready.screen.txt` |
| working | `/⠰\|Running\|Composing\|Editing\|Reconnecting\|Summarizing/i` or `/Waiting for approval\.\.\./` | `session.t3-running.screen.txt`, `session.t1-working-composing.screen.txt` |
| approval (waiting) | `/Run this command\?/` or `/Not in allowlist:/` | `session.t3-approval-shell.screen.txt` |
| update notice | **unverified** — no fixture; `provider.zoom.bannerMatcher` null until captured | — |

Hybrid: prefer hooks `preToolUse` / `beforeSubmitPrompt` → working; `beforeShellExecution` +
approval regex → waiting; `stop` → idle (`hooks.ndjson`).

## Supporting files

| file | role |
|------|------|
| `create-chat.json` | latency + offline mint |
| `hooks.ndjson` | redacted hook firehose + env inventory |
| `usage-events.sample.json` | dashboard shape, attribution, latency |
| `status.sample.json` / `about.sample.json` | auth + about probes |
| `print-mode.result.json` | headless `-p` JSON result |
| `list-models.txt` | `--list-models` parse sample |
| `session.meta.json` / `plain-launch.meta.json` | chat store metadata |

## Unverified / machine notes

- Update-available TUI banner not captured (CLI was current).
- Hook install used spike temp config; pre-spike `~/.cursor/hooks.json` recorded as
  **ABSENT** in `/tmp/mc-cursor-spike-hooks-was.txt` (still absent after spike on capture machine).

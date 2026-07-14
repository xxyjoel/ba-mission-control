# Hook-event schema contract (task 0202)

Frozen from the reviewed spike capture (`spike-0260-capture.ndjson`, task 0201),
real payloads from **claude 2.1.176**. This is the contract `statusHookTailer`
codes against — do not infer field names from memory of the spike.

## Common fields (every event)

| field | type | notes |
|-------|------|-------|
| `session_id` | string (uuid) | **the key** — status file is derived from this |
| `cwd` | string (abs path) | the session's working dir |
| `transcript_path` | string (abs path) | claude's JSONL for this session |
| `hook_event_name` | string | `PreToolUse` \| `Notification` \| `Stop` |

Volatile fields (absolute paths, real uuids, `tool_use_id`) appear verbatim in
the fixture and are **not scrubbed** — the tailer must tolerate real values.

## Per-event fields

- **`PreToolUse`** — also `tool_name`, `tool_input` (object), `tool_use_id`,
  `permission_mode`, `effort`. Fires **instantly** when a tool is requested /
  the approval dialog appears.
- **`Notification`** — also `notification_type` ∈ {`permission_prompt`,
  `idle_prompt`} and a human `message`. **No `permission_mode` on Notification.**
  - `permission_prompt` (`message:"Claude needs your permission"`) is a
    **DELAYED push** — fires ~10–20s AFTER the dialog appears, not on-show.
  - `idle_prompt` (`message:"Claude is waiting for your input"`) fires ~60–90s
    after `Stop`.
- **`Stop`** — also `last_assistant_message`, `stop_hook_active`,
  `background_tasks`, `session_crons`. Turn finished. (Interrupts → `StopFailure`,
  not `Stop` — see task 0245.)

## Event → status mapping (the tailer's job)

| event | status |
|-------|--------|
| `PreToolUse` | `working` (and: opens the gated-regex INPUT window, task 0250) |
| `Notification:permission_prompt` | `waiting` (authoritative ≤20s backstop) |
| `Notification:idle_prompt` | `idle` |
| `Stop` | `idle` (also closes the outstanding-PreToolUse window) |

## Hybrid decision (task 0201)

Hook events are source-of-truth for **working/idle**. For **instant INPUT**, a
narrow `detectApprovalPrompt` regex runs ONLY while a `PreToolUse` is
outstanding (unresolved by a following `Stop`); `permission_prompt` is the
≤20s backstop that catches a reworded dialog. See
`.claude/plans/hooks-based-status-feed.md`.

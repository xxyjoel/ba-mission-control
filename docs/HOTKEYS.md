# Hotkey reference — mc + claude cross-check

**Purpose:** every key mc binds, every key `claude` binds in its
interactive PTY, and where they collide. Verify before touching
`tui/zoom/PtyPane.jsx` or `tui/zoom/ptyKeys.js`.

**Sources:**
- mc bindings: code-walked from `tui/App.jsx`, `tui/modals/*.jsx`,
  `tui/zoom/zoomKeys.js` (the zoom chrome-key source of truth),
  `tui/zoom/PtyPane.jsx`, `tui/zoom/ptyKeys.js`, `tui/lib/TextField.jsx`
- claude bindings: official Anthropic docs
  (https://code.claude.com/docs/en/interactive-mode), verified 2026-06-17

If you add a hotkey, update the matching row here in the same commit.
The existing `docs/audit/KEYBINDINGS.md` was a one-shot 2026-06-10
inventory and is no longer authoritative — line numbers are stale.

---

## 1. mc fleet view (no modal open)

`tui/App.jsx:1140-1322`. Gated by `if (modal) return` at line 1169 — none
of these fire while a modal (including Zoom) is open.

| Key | Action | File:Line |
|---|---|---|
| `?` | Open Help | 1182 |
| `,` / `Esc` | Open Settings | 1180 |
| `b` / `B` | Open Broadcast | 1183 |
| `d` / `D` | Open Dashboard | 1184 |
| `q` / `Q` | Open QuitConfirm | 1189 |
| `n` / `Ctrl+N` | Open NewSession (lowercase only — Shift+N is free) | 1252 |
| `/` | Enter filter mode | 1192 |
| `:` | Enter command bar | 1197 |
| `Shift+Tab` | Cycle permission mode | 1175 |
| `0`–`9` | Jump to slot 1–10 | 1203 |
| `←` `→` `↑` `↓` (or `h` `l` `k` `j` if vim keys) | Grid focus nav | 1225-1228 |
| `↵` (enter) | Zoom focused agent OR launch new | 1235 |
| `p` / `P` | Pause focused agent (SIGSTOP) | 1266 |
| `r` / `R` | Resume focused agent (SIGCONT) | 1273 |
| `k` / `K` | Kill focused agent (press twice within 3s) | 1280 |
| `a` / `A` | Approve pending action | 1313 |

## 2. Command bar (`:` or `/` active)

`tui/App.jsx:1144-1166`. Override everything while active.

| Key | Action |
|---|---|
| `Esc` | Cancel, exit command mode |
| `↵` | Commit (filter applies, command runs) |
| `Backspace` / `Delete` | Delete last char |
| Any printable char | Append to buffer |

## 3. PtyPane (inside Zoom modal)

Chrome keys are defined in `tui/zoom/zoomKeys.js` — the single source of
truth, verified end-to-end by `tests/zoom/zoomKeys.realparser.test.jsx`
(which drives the real bytes through Ink's parser). Exactly 5 intercepts;
everything else is forwarded to the embedded `claude` PTY via `ptyKeys.js`.
All chrome keys are in the `Ctrl+A..Z` range — the ONLY range Ink delivers as
`{ctrl:true, input:<letter>}` — so a binding can't silently die the way
`Ctrl+]` / `Ctrl+\` (0x1d / 0x1c) did.

| Key | mc action | Claude key it shadows | Severity |
|---|---|---|---|
| `Ctrl+Q` | Exit zoom | none | **None** — Q=quit; replaces the old Esc-exit and the dead `Ctrl+]` |
| `Ctrl+Y` | Enter scroll mode (`w`/`s` line · `b`/`f` half-page · `g`/`G` top/bottom · `Esc` exits) | `Ctrl+Y` paste-deleted-text | **Low** — claude editing-only key |
| `Ctrl+K` | Toggle mc's tools panel | `Ctrl+K` delete-to-end-of-line | **Low** — claude editing-only key; moved here off `Ctrl+T` (claude todos) |
| `Ctrl+U` | Toggle mc's stats panel | `Ctrl+U` delete-to-line-start | **Low** — claude editing-only key; moved here off `Ctrl+S` (claude stash) |
| `Ctrl+J` / `Shift+Enter` | Newline without submitting | matches claude's own `chat:newline` | **None** — same action |

**Forwarded, NOT intercepted** (the keys mc used to shadow, now returned to
claude): `Esc` (interrupt / back-out), `Ctrl+T` (todos), `Ctrl+S` (stash),
`Shift+Tab` (claude's perm-mode cycle). The fleet-view `Shift+Tab` still cycles
the focused slot's perm at the App level (gated by `if (modal) return`).

## 4. Keys forwarded to claude (`tui/zoom/ptyKeys.js`)

Every key not in the table above is encoded and written to the PTY.

| Key | Bytes |
|---|---|
| Arrows ←↑↓→ | `CSI A/B/C/D` (or `CSI 1;<mod>X` when modified) |
| `PageUp` / `PageDown` | `CSI 5~` / `CSI 6~` |
| `Home` / `End` | `CSI H` / `CSI F` |
| `Tab` / `Shift+Tab` | `\t` / `CSI Z` (`Shift+Tab` forwards → claude's perm cycle) |
| `Backspace` / `Delete` | `\x7f` (both — Ink can't distinguish) |
| `Return` | `\r` |
| `Esc` | `\x1b` (forwarded — zoom exit is `Ctrl+Q`, not Esc) |
| `Ctrl+<letter>` | `0x01`-`0x1a` (except `Ctrl+Q/Y/K/U/J` — intercepted as chrome keys, see §3) |
| `Alt+<X>` | `\x1b` + X |
| Multi-char paste in bracketed mode | `CSI 200~ … CSI 201~` |
| Printable | as-is |

**Not encoded** (silently dropped):
- `F1`-`F12`
- Forward Delete (collapsed to backspace)
- Mouse events

## 5. Claude interactive bindings (source: official docs)

### General controls

| Key | Claude action | Reaches claude in mc zoom? |
|---|---|---|
| `Ctrl+C` | Interrupt; second press exits Claude | ✓ (forwarded as `0x03`) |
| `Ctrl+D` | Exit Claude session (EOF) | ✓ (`0x04`) |
| `Ctrl+G` | Open in default text editor | ✓ (`0x07`) |
| `Ctrl+X Ctrl+E` | Open in editor (readline native) | ✓ (chord works) |
| `Ctrl+X Ctrl+K` | Stop all running background subagents (×2) | ✓ |
| `Ctrl+L` | Redraw screen | ✓ (`0x0c`) |
| `Ctrl+O` | Toggle transcript viewer | ✓ (`0x0f`) |
| `Ctrl+R` | Reverse search command history | ✓ (`0x12`) |
| `Ctrl+V` / `Cmd+V` | Paste image from clipboard | ⚠ (Cmd doesn't reach Ink on macOS; Ctrl+V works) |
| `Ctrl+B` | Background a bash command | ✓ (`0x02`) |
| `Ctrl+T` | Toggle task list | ✓ (forwarded — mc's tools panel moved to `Ctrl+K`) |
| `Esc` | Interrupt Claude | ✓ (forwarded — zoom exit moved to `Ctrl+Q`) |
| `Esc Esc` | Clear input draft / open rewind | ✓ (both taps forwarded) |
| `Shift+Tab` / `Alt+M` | Cycle permission modes | ✓ (both forwarded) |
| `Option+P` / `Alt+P` | Switch model | ✓ (Alt+P forwarded as `\x1b p`) |
| `Option+T` / `Alt+T` | Toggle extended thinking | ✓ |
| `Option+O` / `Alt+O` | Toggle fast mode | ✓ |
| `←` / `→` | Cycle dialog tabs (when in a dialog) | ✓ |
| `↑` / `↓` (`Ctrl+P` / `Ctrl+N`) | Cursor or history nav | ✓ |

### Text editing (inside Claude's input)

| Key | Action | Forwarded? |
|---|---|---|
| `Ctrl+A` | Cursor to line start | ✓ |
| `Ctrl+E` | Cursor to line end | ✓ |
| `Ctrl+K` | Delete to end of line | ✗ **intercepted by mc** (tools panel — see §3) |
| `Ctrl+U` | Delete to line start | ✗ **intercepted by mc** (stats panel — see §3) |
| `Ctrl+W` | Delete previous word | ✓ |
| `Ctrl+Y` | Paste deleted text | ✗ **intercepted by mc** (scroll mode — see §3) |
| `Alt+Y` (after Ctrl+Y) | Cycle paste history | ✓ (needs Option-as-Meta on macOS) |
| `Alt+B` / `Alt+F` | Word back / forward | ✓ (needs Option-as-Meta) |

### Multiline input

| Method | Forwarded? |
|---|---|
| `\` + `Enter` | ✓ |
| `Option+Enter` / `Alt+Enter` | ✓ (with Option-as-Meta) |
| `Shift+Enter` | ✓ in terminals that send it natively (iTerm2, WezTerm, Ghostty, Kitty, Warp, Terminal.app, Windows Terminal) |
| `Ctrl+J` | ✓ (universal) |

### Special prefixes (typed at start of input)

| Char | Claude action | Reaches claude in mc zoom? |
|---|---|---|
| `/` | Slash command / skill | ✓ (typed inline) |
| `!` | Shell mode | ✓ |
| `@` | File path mention | ✓ |
| `Space` (hold or tap) | Voice dictation (if enabled) | ✓ |

### Transcript viewer (after `Ctrl+O`)

These only fire when transcript viewer is open. All forwarded.

| Key | Action |
|---|---|
| `?` | Toggle help panel |
| `{` / `}` | Jump prev/next user prompt |
| `Ctrl+E` | Toggle show all content |
| `[` | Dump conversation to terminal scrollback |
| `v` | Open conversation in `$EDITOR` |
| `q` / `Ctrl+C` / `Esc` | Exit transcript view (`Esc` intercepted by mc) |

### Vim editor mode (only if `/config` → Editor mode = vim)

The full vim grammar applies inside Claude's input editor when vim mode
is on. `h j k l w b e 0 $ ^ gg G x dd D dw cc cw yy p u .` and the
character-search motions `f F t T` are all interpreted. **All forwarded**
because mc doesn't intercept any letters.

---

## 6. Conflict matrix (zoom only — fleet view is gated)

The five PtyPane intercepts are the entire conflict surface. After the
`Ctrl+Q/Y/K/U/J` rewrite, mc no longer shadows any of claude's general
controls (`Esc`, `Ctrl+T`, `Ctrl+S`, `Shift+Tab` all forward). The only
remaining overlaps are with claude's three readline EDITING keys, which
only matter while the user is typing in the composer:

| mc key | mc action | Claude key it shadows | Severity |
|---|---|---|---|
| `Ctrl+Q` | Exit zoom | none | None |
| `Ctrl+Y` | Scroll mode | paste-deleted-text (editing only) | Low |
| `Ctrl+K` | Tools panel | delete-to-end-of-line (editing only) | Low |
| `Ctrl+U` | Stats panel | delete-to-line-start (editing only) | Low |
| `Ctrl+J` | Newline | claude's own newline | None — same action |

---

## 7. Scroll bindings (in zoom) — SHIPPED

**Status:** the mode-prefix scheme shipped, bound to `Ctrl+Y` (not the
originally-explored `Ctrl+\`, which is `0x1c` — outside Ink's ctrl-letter
range and therefore unreachable). `Ctrl+Y` enters scroll mode; while active,
`w`/`s` scroll one line, `b`/`f` half a page, `g`/`G` jump to top/bottom, and
`Esc` (or any other key) exits and returns input to claude. See `ZOOM_KEYS.SCROLL`
in `tui/zoom/zoomKeys.js` and the scroll-mode handler in `PtyPane.jsx`. The
candidate analysis below is kept as historical rationale.

Original goal: scroll the PTY viewport up/down (xterm-headless has 5000 lines
of scrollback enabled but PtyPane never reads above the visible viewport).
Constraints:

- Must not steal a key that's typed as text — rules out plain letters
  including `w` `s` `j` `k` `h` `l`
- Must not collide with the Claude bindings table above
- Should be discoverable

### Candidates (ranked)

| Binding | Up / Down | Conflict | Discoverability | Recommendation |
|---|---|---|---|---|
| **`Shift+PageUp` / `Shift+PageDown`** | scroll | **None** — Claude binds only plain PageUp/PageDown (forwarded today, but currently no-op in Claude itself); Shift+PageUp is the macOS Terminal scrollback convention so muscle memory transfers | High | ★ Best baseline |
| **`Alt+W` / `Alt+S`** | scroll | None — Claude's Alt bindings are P/T/O/B/F/Y/M | Medium (needs docs) | Good if user wants the w/s metaphor; depends on Option-as-Meta config on macOS |
| **Mode prefix `Ctrl+\` + then plain `w` / `s`** | enter scroll mode, w/s scroll, Esc exits scroll mode | None — `Ctrl+\` (FS, `0x1c`) is unused by Claude; w/s only steal text input *while in scroll mode* | High once learned, vim-feel | Best if user wants exactly w/s semantics |
| **`Ctrl+U` / `Ctrl+D`** (less/vim convention) | scroll | **HIGH** — both are core Claude editing keys (delete to line start, EOF/exit) | — | ✗ Rejected |
| **`Ctrl+B` / `Ctrl+F`** | scroll | **HIGH** — `Ctrl+B` is Claude's background-bash trigger | — | ✗ Rejected |
| **`PageUp` / `PageDown`** | scroll | None today, but reserves a likely future Claude binding | High | Acceptable but burns the namespace |

### Recommended scheme

`Shift+PageUp` / `Shift+PageDown` for half-page; `Alt+W` / `Alt+S` for one
line at a time (for users who like the w/s metaphor and have Option-as-Meta
configured). Document both in Help.

If the user insists on plain `w` / `s`: implement the mode-prefix scheme
(`Ctrl+\` enters scroll mode, w/s/`g`/`G` work as vim-like motions, any
other key exits mode and forwards).

---

## 8. Verification protocol (when changing intercepts)

For each row of section 6 you change:

1. `cd ~/path/to/a/repo`
2. `claude` (bare, not through mc)
3. Press the key
4. Note Claude's response
5. Open mc, zoom in, press the same key, confirm mc owns/forwards as expected

For each row of section 7 you add:

1. Zoom into a session with > 1 screenful of output
2. Press the scroll key — viewport should scroll up
3. Type a message containing the letter form of the key (e.g. "swift")
   — the letters should land in claude's input, not trigger scroll
4. Press End (or whatever "return to bottom" key you wire) — viewport
   snaps to live cursor

# ba-mission-control — Complete Keybindings Inventory

Generated 2026-06-10. Every `useInput` handler in the codebase, with the
exact file:line, modifier conditions, conflicts, and which test (if any)
proves it works.

This doc is the answer to: **"what is X bound to and does it actually work?"**

---

## How Ink dispatches keys

`useInput((input, key) => …)` registers a listener. ALL registered
listeners receive every keystroke — there is **no propagation control**.
That means a single keypress can trigger handlers in:

- `App.jsx` (root)
- The active modal (Zoom / Settings / etc.)
- Any nested component with its own `useInput` (e.g. `TextField`)

Ordering across handlers is determined by Ink's internal listener list
(roughly mount order). The practical guarantee is: every active handler
runs, and each one decides for itself whether to act on the key.

**`isActive: false`** silences a handler (used by TextField when its
`focus` prop is false). **Early-return guards** (e.g. `if (modal) return`
in App.jsx) act as the equivalent of "let modal own this key."

---

## Global (App.jsx) — fires only when NO modal is open

`App.jsx:899` — `if (modal) return` at line 928 makes this a no-op while
a modal renders.

| Trigger | File:Line | Action | Conflicts | Test |
|---------|-----------|--------|-----------|------|
| `?` | 941 | open Help | — | ✓ `App.hotkeys.test.jsx` |
| `,` | 940 | open Settings | — | ✓ `App.hotkeys.test.jsx` |
| `Esc` | 939 | open Settings | — | — |
| `b` / `B` | 942 | open Broadcast | — | ✓ `App.hotkeys.test.jsx` |
| `d` / `D` | 943 | open Dashboard | — | ✓ `App.hotkeys.test.jsx` |
| `q` / `Q` | 948 | open QuitConfirm | — | ✓ `App.hotkeys.test.jsx` |
| `n` / `N` / Ctrl+N | 1099+ | open NewSession | Ctrl+N rarely typed | ✓ `App.hotkeys.test.jsx` |
| `0`–`9` | 1003 | jump to slot (0=10) | — | ✓ `App.hotkeys.test.jsx` |
| `↑↓←→` / `hjkl` | 984–987 | grid focus nav | `vimKeys` setting toggles hjkl | ✓ `App.hotkeys.test.jsx` |
| `↵` | 1041+ | zoom focused / launch empty | — | — |
| `p` / `P` | 1060+ | pause focused | — | — |
| `r` / `R` | 1066+ | resume focused | — | — |
| `K` (capital) | 1083+ | arm kill (3s window) | second `K` confirms | — |
| `a` / `A` | 1077+ | approve pending action | — | — |
| `Shift+Tab` | 934 | cycle permission mode | also Zoom-internal (modal owns first) | — |
| `/` | 1029 | filter mode | — | ✓ `App.hotkeys.test.jsx` |
| `:` | 1033 | command bar | — | ✓ `App.hotkeys.test.jsx` |

---

## Zoom modal (`tui/modals/Zoom.jsx`)

> ⚠️ **SUPERSEDED — table below predates the PTY-embed rewrite.** Zoom is now
> an embedded `claude --resume` PTY (`tui/zoom/PtyPane.jsx` is the single
> `useInput` handler; `tui/zoom/ptyKeys.js` translates keys to bytes).
> `Zoom.jsx` no longer owns the line numbers / scroll handlers cited below.
> **Current key reality:**
> - Most keys (typing, arrows incl. `Shift+↑/↓`, `PgUp/PgDn`, `Home/End`,
>   `/` and `@` menus, history recall) **forward to claude's own PTY** — its
>   native TUI handles them.
> - mc chrome intercepts (single source of truth: `tui/zoom/zoomKeys.js`,
>   verified by `tests/zoom/zoomKeys.realparser.test.jsx`): `Ctrl+Q` exit zoom,
>   `Ctrl+Y` scroll mode, `Ctrl+K` toggle tools, `Ctrl+U` toggle stats,
>   `Ctrl+J` / `Shift+↵` newline. ALL chrome keys are `Ctrl+A..Z` (0x01-0x1a),
>   the only range Ink reliably decodes as `{ctrl:true, input:<letter>}`.
> - **Forwarded to claude** (no longer intercepted): `Esc` (cancel/back-out),
>   `Ctrl+T` (todos), `Ctrl+S` (stash), `Shift+Tab` (perm-mode).
> - ⚠️ `Ctrl+]` (0x1d) and `Ctrl+\` (0x1c) were the OLD exit/scroll keys and were
>   **silently dead**: those bytes are above 0x1a, so Ink delivers them with
>   `ctrl:false` → a `key.ctrl && input===']'` handler is unreachable. Synthetic
>   unit tests passed because they fabricated `{ctrl:true,input:']'}`, a shape
>   the real parser never emits. The realparser test drives the actual bytes.
> - **Scroll mode**: `Ctrl+Y` enters it; `w`/`s` line, `b`/`f` half-page,
>   `g`/`G` ends, `Esc` (or any other key) exits.
>
> The historical table is kept for archival reference only — do not treat its
> line numbers or test column as current.

Active whenever the Zoom modal is rendered. Composer (`TextField`) is
ALSO active simultaneously when `focus={!composerSuspended}` is true.

| Trigger | File:Line | Action | Conflict with TextField? | Test |
|---------|-----------|--------|--------------------------|------|
| `Shift+Tab` | 257 | cycle permission mode | TextField ignores Tab when not shift | — |
| `Ctrl+T` / `Ctrl+t` | 265 | toggle tool visibility | TextField ignores key.ctrl | — |
| `Ctrl+S` / `Ctrl+s` | 272 | toggle stats panel | TextField ignores key.ctrl | ✓ `Zoom.input.test.jsx` |
| `Esc` | 469 (close-empty) | close Zoom | TextField handles Esc internally (escape-merge timer) | — |
| `PgUp` (`\x1b[5~`) | 281 | scroll log half-page up | — | superseded (see banner) |
| `PgDn` (`\x1b[6~`) | 296 | scroll log half-page down | — | — |
| ~~`Shift+↑`~~ | ~~309~~ | ~~scroll log ONE line up~~ | superseded — now forwarded to claude's PTY (see banner) | ✗ no such test |
| ~~`Shift+↓`~~ | ~~316~~ | ~~scroll log ONE line down~~ | superseded — now forwarded to claude's PTY (see banner) | ✗ no such test |
| `Home` (`\x1b[H` / `\x1b[1~`) | 322 | scroll to top | — | — |
| `End` (`\x1b[F` / `\x1b[4~`) | 328 | snap to live tail | — | — |
| `Ctrl+G` (BEL `\x07`) | 335 | snap to live tail | — | ✓ `Zoom.input.test.jsx` |
| `↑` (alone) | 388 | composer history recall (newer→older) | TextField multi-line nav (takes precedence inside multi-line) | ✓ `Zoom.input.test.jsx` |
| `↓` (alone) | 397 | composer history recall (older→newer) | same | ✓ `Zoom.input.test.jsx` |
| `/` prefix in composer | TextField → onChange | open slash dropdown | — | ✓ `Zoom.slash.test.jsx` |
| `@` prefix in composer | TextField → onChange | open file mention dropdown | — | — |
| `Tab` | 367 | autocomplete fill (slash or @ open) | TextField ignores Tab | — |
| `a` / `y` / `1` (binary prompt) | 416 | approve | TextField swallows when composer not suspended | ✓ `Zoom.chips.test.jsx` |
| `r` / `n` / `2` (binary prompt) | 420 | reject | same | ✓ `Zoom.chips.test.jsx` |

---

## TextField (`tui/lib/TextField.jsx:157`)

`isActive: focus` — silenced when the host (e.g. Broadcast) sets
`focus={false}`. When active, it consumes (sets state for) most
keystrokes. Returns WITHOUT consuming on: arrow up/down at top/bottom of
buffer (so parent can recall history), Tab (so parent autocompletes),
plain ctrl/meta combos that aren't bound here.

| Trigger | File:Line | Action | Sequence delivered | Test |
|---------|-----------|--------|--------------------|------|
| `←` | 297 | cursor one char left | xterm `\x1b[D` | ✓ `TextField.test.jsx` |
| `→` | 301 | cursor one char right | xterm `\x1b[C` | ✓ `TextField.test.jsx` |
| `Ctrl+A` | 181 | cursor to line start | `\x01` | ✓ `TextField.test.jsx` |
| `Ctrl+E` | 186 | cursor to line end | `\x05` | ✓ `TextField.test.jsx` |
| **`Option+←` / `Ctrl+←`** | **272** | **prev word boundary** | `\x1b[1;3D` / `\x1b[1;5D` | ✓ `TextField.wordjump.test.jsx` |
| **`Option+→` / `Ctrl+→`** | **276** | **next word boundary** | `\x1b[1;3C` / `\x1b[1;5C` | ✓ `TextField.wordjump.test.jsx` |
| **`Option+B` / `Option+F`** | **280, 284** | **prev / next word (Emacs)** | `\x1bb` / `\x1bf` | ✓ `TextField.wordjump.test.jsx` |
| `↑` (multi-line) | 269 | cursor up one line | `\x1b[A` | — |
| `↑` (single-line / top of buffer) | 272 | NO-OP — Zoom history recall fires | same | ✓ `Zoom.input.test.jsx` |
| `↓` (multi-line) | 274 | cursor down one line | `\x1b[B` | — |
| `↓` (single-line / bottom) | 277 | NO-OP — Zoom history recall | same | ✓ `Zoom.input.test.jsx` |
| `Ctrl+J` / raw LF | 197 | insert newline at cursor | `\x0a` | ✓ `TextField.test.jsx` + PTY recipe |
| `Option+↵` / `Shift+↵` | 192 | insert newline at cursor | `\x1b\r` | ✓ `TextField.test.jsx` |
| `↵` | 205 | submit | `\r` | ✓ `TextField.test.jsx` |
| `Backspace` | 219 | delete char before cursor | `\x7f` / `\x1b[3~` | ✓ `TextField.test.jsx` |
| `Esc` | 161 (deferred) | cancel (after 80ms escape-merge window) | `\x1b` | — |
| typed character | 305 | insert at cursor | any printable | ✓ `TextField.test.jsx` |

---

## Other modals

| Modal | File:Line | Key handlers |
|-------|-----------|--------------|
| QuitConfirm | `QuitConfirm.jsx:17` | `y/Y/↵` exit · `n/N/Esc` cancel · anything else ignored |
| Help | `Help.jsx:31` | `Esc/↵/?` close |
| Settings | `Settings.jsx:107` | `Esc/,` close · `Tab` / `Shift+Tab` cycle sections · `1`–`9` jump section · `↑↓←→/hjkl` row nav · `↵/space` toggle/cycle |
| Broadcast | `Broadcast.jsx:32` | `Esc` close · `Tab` cycle target · `Space/↵` toggle · `←/→` chip nav · `a/A` all |
| Dashboard | `Dashboard.jsx:123` | `Esc/d/D` close · `s/S` sort cycle · `r/R` reverse · `↑↓` row nav · `↵` zoom |
| NewSession | `NewSession.jsx:164` | `Esc` close · `Ctrl+B` browse repos · `↑↓` model nav · `←/→` permission |
| RepoPicker | `RepoPicker.jsx:74` | `Esc` close · `↑↓/hjkl` nav · `↵` descend · `←` ascend · `.` pick current |

---

## Command-bar verbs (`:verb`)

Every verb handler in App.jsx `runCommand`. See `COMPONENTS.md §3.2`
for the full list — too many to mirror here.

---

## Known conflicts (resolved)

| Conflict | Resolution |
|----------|------------|
| `q` quits AND is the arming key for q-then-y confirm | Replaced with `<QuitConfirm>` modal (q opens modal; modal owns y/n) — `81be274` |
| TextField `↑/↓` swallows Zoom history recall when composer is single-line | TextField returns without consuming when cursor is at top/bottom — `Zoom.input.test.jsx` proves history fires |
| Composer ↑/↓ vs log scroll | Moot post-rewrite: arrows forward to claude's PTY; mc scroll lives in a separate `Ctrl+Y` scroll mode (`PtyPane.jsx`), so there is no overlap to resolve |
| Mac swallows Ctrl+↑/↓ for Mission Control | Resolved by the PTY-embed rewrite — mc no longer binds `Ctrl+↑/↓` at all (GH #5). Original task: `tasks/open/0125-replace-ctrl-arrow-scroll-binding-mac-conflict.md` |
| Composer at bottom of Zoom (couldn't see input on narrow terminals) | Composer moved to top of modal — `ecf7ff7` |

---

## How we prove a binding works

Three independent layers of evidence, each pinned in tests:

1. **Unit test (ink-testing-library)** — renders the component, writes
   the raw escape sequence to stdin, asserts the rendered frame OR a
   state change. Fast (~200ms), runs in CI. File pattern: `*.test.jsx`.

2. **Real-PTY recipe** — spawns the actual process in a node-pty
   pseudo-terminal, feeds it the same escape sequence, and reads the
   xterm-rendered frame via `@xterm/headless`. Catches encoding bugs
   the virtual frame can't see. File pattern: `tests/recipes/*.test.jsx`.

3. **`MC_DEBUG_KEYS=1` log** — runtime instrumentation in
   `TextField.jsx`. When set, every key event the field receives is
   appended to `${MC_CONFIG_DIR:-~/.config/claude-mc}/debug-keys.log`
   with `inputBytes` + `key` flags + `action`. Use this when a user
   reports a terminal-specific issue and you need to see what THEIR
   terminal actually delivered. Sample line:
   ```json
   {"ts":1718500000000,"input":"","inputBytes":[27,91,49,59,50,65],
    "key":{"upArrow":true,"shift":true},"action":"received"}
   ```

## Scroll inside Zoom (current)

The pre-rewrite `Shift+↑/↓` log scroll **no longer exists** — there is no
`tests/Zoom.shiftarrow.test.jsx`. Inside the PTY-embedded Zoom, arrow keys
forward to claude's own TUI. mc provides a dedicated scroll mode instead:

- `Ctrl+Y` enters scroll mode (`tui/zoom/PtyPane.jsx`).
- `w`/`s` scroll one line back/forward, `b`/`f` half-page, `g`/`G` to ends.
- `Esc` (or any other key) exits.

## Diagnostic: what if a key "doesn't work" on your terminal?

Run mc with the key logger:

```sh
MC_DEBUG_KEYS=1 npm start
```

Open a zoomed session, press the key, then `Ctrl+C` to quit, then:

```sh
tail -20 ~/.config/claude-mc/debug-keys.log
```

Look for a line where `key.upArrow=true` and `key.shift=true`. If you see
that, the keystroke is reaching the TextField — meaning Zoom should
ALSO have seen it (both handlers run). If you see `key.upArrow=true` but
NO `shift`, your terminal is not modulating with shift — that's a
terminal-side issue (some old terminals strip modifiers from arrow keys
unless `xterm-modifyOtherKeys` is enabled).

If you see no entry at all, the field doesn't have focus. Check whether
you're in a modal (e.g. Settings) instead of the main Zoom view.

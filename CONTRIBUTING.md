# Contributing to BlueArch Mission Control

Thanks for your interest in improving Mission Control! This is a keyboard-first
terminal TUI for running up to 10 real `claude` CLI agent sessions. It's built
on Node + [Ink](https://github.com/vadimdemedes/ink) (React for terminals) with
`tsx` as the JSX runtime — **there is no build step**.

## Ground rules

- Be respectful. This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md).
- Keep changes focused and reviewable. Small PRs merge faster.
- Discuss large or architectural changes in an issue first.

## Development setup

Requirements: **Node 20+**, the `claude` CLI on your `PATH`, `git`, and a
terminal with 24-bit color + Unicode.

```bash
git clone https://github.com/xxyjoel/ba-mission-control.git
cd ba-mission-control
npm install
npm start            # launches the TUI (needs a real TTY)
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm start` | Run the TUI |
| `npm run dev` | Run with file-watch reload |
| `npm run dev:sandbox` | Run against an isolated `~/.config/claude-mc-dev` config |
| `npm test` | Run the full test suite |
| `npm run test:watch` | Watch-mode tests |

### Work offline with mock mode

You don't need a live Claude session (or to spend tokens) to iterate on UI.
`MC_MOCK=<fixture>` plays back a recorded stream:

```bash
MC_MOCK=quick-reply npm start
```

Fixtures live in `server/fixtures/` (`quick-reply`, `tool-loop`,
`long-thinking`, `approval-request`). Mock mode is what the demo GIFs are
recorded against, so recordings stay deterministic.

## Conventions

- **ESM only.** `"type": "module"`; files use the `.jsx` extension and `tsx`
  handles JSX at runtime. No transpile/build step — don't add one.
- **Never spawn shell strings** with env-var or user-input interpolation. Always
  use argv-form helpers (`execFile`, `execFileSync`, `spawn`). `CLAUDE_BIN` is
  user-controlled — treat it as untrusted. See `SECURITY.md`.
- **Ink layout:** give each card in a horizontal flex row an explicit
  `width={N}`; `flexGrow` alone biases earlier children. See `tui/App.jsx`.
- **Modals replace the main view** — don't use `position: 'absolute'` to overlay
  (unreliable for terminal stacking).
- **Settings** live in `~/.config/claude-mc/settings.json`; extend the
  `SETTINGS_SCHEMA` array in `tui/lib/settings.js`, not ad-hoc reads.
- Prefer a specific `// TODO(<tag>): <what + why>` comment over deferring work
  silently.

## Tests

Tests use the built-in `node:test` runner via `tsx`. Add or update a test for
the behavior you change — see `tests/` for patterns (component render tests use
`ink-testing-library`). Note: `useInput` needs a real TTY, so hotkey tests that
error with "Raw mode is not supported" in a non-TTY are expected, not a bug.

Run the suite before opening a PR:

```bash
npm test
```

## Regenerating the demo GIFs

Terminal recordings are scripted with [charmbracelet/vhs](https://github.com/charmbracelet/vhs)
so they're reproducible. Install VHS (`brew install vhs`) and run:

```bash
vhs tapes/hero.tape        # → assets/hero.gif
vhs tapes/zoom.tape
vhs tapes/themes.tape
vhs tapes/dashboard.tape
```

The `.tape` scripts drive `MC_MOCK` fixtures, so recordings need no live Claude
auth and produce identical output every run.

## Submitting a pull request

1. Branch from `main`.
2. Make your change + add/adjust tests.
3. Run `npm test` and confirm green.
4. Open a PR using the template. Explain the *why*, not just the *what*.

## License

By contributing, you agree that your contributions are licensed under the
project's [AGPL-3.0](./LICENSE) license.

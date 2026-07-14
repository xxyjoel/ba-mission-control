# Demo recordings (VHS)

Terminal GIFs for the README and landing page are scripted with
[charmbracelet/vhs](https://github.com/charmbracelet/vhs) so they're
**reproducible** — same script, same output, every time.

## Install VHS

```sh
brew install vhs        # macOS
# or see https://github.com/charmbracelet/vhs#installation
```

## Render

Each `.tape` writes a GIF into `../assets/`:

```sh
vhs tapes/hero.tape        # → assets/hero.gif   (README hero)
vhs tapes/zoom.tape        # → assets/zoom.gif   (zoom modal: scroll/stats/tools)
vhs tapes/themes.tape      # → assets/themes.gif (cycle palettes incl. Matrix)
vhs tapes/dashboard.tape   # → assets/dashboard.gif (fleet dashboard, D key)
```

## Why MC_MOCK

Every tape launches with `MC_MOCK=<fixture>` (fixtures live in
`../server/fixtures/`: `quick-reply`, `tool-loop`, `long-thinking`,
`approval-request`). Mock mode replays a recorded JSONL stream instead of
spawning a real `claude` subprocess, so recordings:

- need **no** Claude auth and spend **no** tokens,
- are **deterministic** (identical frames each run),
- can run in CI.

## Calibration

Timings (`Sleep`, `@800ms`) are a starting point. On first render, watch the
GIF and adjust the sleeps so each step is readable — the mock stream's pacing
and your terminal's startup time affect where events land. Keep `Width`/`Height`
consistent across tapes so the assets look like a set.

## Tapes to add

Only `hero.tape` is committed as the reference. Add the remaining three by
copying it and changing the `Output`, the launched fixture, and the interaction:

- **zoom.tape** — launch, `Enter` to zoom, `Ctrl+y` scroll mode (w/s/b/f/g/G),
  `Ctrl+u` stats panel, `Ctrl+k` tools panel, `Ctrl+q` to exit.
- **themes.tape** — `:theme tokyo`, `:theme gruvbox`, `:theme matrix`, … to show
  the palette gallery.
- **dashboard.tape** — `d` to open the fleet dashboard, sort columns.

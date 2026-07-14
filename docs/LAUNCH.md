# Launch copy — Mission Control

Ready-to-paste copy for the public launch. Tune the specifics (metrics, exact
quotes) before posting. Keep the honest, technical register — especially on HN.

---

## Hacker News — "Show HN"

**Title** (≤ 80 chars, no hype, no trailing period):

```
Show HN: Mission Control – a terminal TUI for running 10 Claude Code agents
```

**Body** (first-person, posted as text; HN dislikes marketing tone):

> I kept running several Claude Code sessions at once — one refactoring, one
> writing tests, one reviewing — and lost track of which one was waiting on me,
> which was burning tokens, and which had quietly gone idle. tmux panes all look
> the same, and a full GUI app felt like overkill.
>
> Mission Control is a keyboard-first terminal TUI that supervises up to 10 real
> `claude` CLI subprocesses on a grid. Each card shows live status, context-window
> pressure, tokens/min, session + weekly cost (read from Claude's own usage, not
> estimated), a todo burndown, and — the part I couldn't get any other way —
> sub-agent fan-out: when an agent spawns parallel Task/Workflow sub-agents, the
> card shows `⋔{n}` and folds their token/cost back into the parent.
>
> It's built on Ink (React for terminals) with tsx, so there's no build step. No
> HTTP server, no telemetry, no account beyond your own Claude login — it just
> spawns and supervises subprocesses on localhost. Pause/resume are POSIX signals
> (SIGSTOP/SIGCONT). Zoom into any session for a full PTY view with scrollback.
>
> It runs anywhere a terminal does, including over SSH, and happily alongside
> tmux. macOS and Linux; Node 20+; AGPL-3.0.
>
>     npx @bluearch/mission-control
>
> Repo: https://github.com/xxyjoel/ba-mission-control
>
> Honest limitations: single-user and localhost-only by design; SIGSTOP pauses
> the process but won't cancel an in-flight request; the `run_in_background` Task
> "idle" edge case isn't fully surfaced yet. Happy to answer questions.

**Tips**
- Post around 8–10am ET on a weekday; reply to every comment in the first 2 hours.
- Don't ask for upvotes anywhere (HN penalizes it).
- Lead with the itch, not the feature list. Be first to name the limitations.

---

## Product Hunt

**Name:** BlueArch Mission Control

**Tagline** (≤ 60 chars):

```
Fleet command for your Claude Code agents — in the terminal
```

Alternates:
- `Run 10 Claude Code agents from one keyboard`
- `Open-source mission control for AI coding agents`

**Description** (≤ 260 chars):

> A keyboard-first terminal TUI for running up to 10 real Claude Code sessions at
> once — with live cost, context, and sub-agent fan-out tracking. No GUI, no
> Electron, no telemetry. Open source, self-hosted, made in the USA. 🇺🇸

**First comment (from the maker):**

> Hey PH 👋 I built this because I run a lot of Claude Code agents in parallel and
> kept losing track of which one needed me and what they were costing. Mission
> Control puts the whole fleet on one grid: live status, context pressure,
> tokens/min, real cost, todo burndown, and sub-agent fan-out (`⋔`) — all
> keyboard-driven, all local. It runs in any terminal (even over SSH) alongside
> tmux.
>
> It's fully open source (AGPL-3.0) and self-hosted — no telemetry, nothing leaves
> your machine but your own Claude calls. `npx @bluearch/mission-control` to try it.
> Would love your feedback, especially on the fleet/triage UX.

**Topics:** Developer Tools, Artificial Intelligence, Open Source, Terminal

**Gallery:** hero.gif (grid + navigation), zoom.gif, themes.gif (incl. Matrix),
dashboard.gif, social-preview.png. First asset should be the hero GIF.

---

## X / Reddit one-liner

> Ten Claude Code agents, one keyboard. Mission Control is an open-source terminal
> TUI that tracks every agent's status, cost, context, and sub-agent fan-out — no
> GUI, no telemetry, all local. `npx @bluearch/mission-control`

(r/commandline, r/ClaudeAI — read each sub's self-promo rules first.)

---

## FAQ

**Does it phone home / send telemetry?**
No. There's no network listener and no analytics. The only network traffic is the
`claude` subprocesses talking to Anthropic on your behalf — the same calls you'd
make running `claude` directly.

**Do I need an API key?**
It uses your existing Claude auth — either a `claude auth login` session or
`ANTHROPIC_API_KEY` in your environment. Mission Control never reads or stores the
key; it's inherited by the `claude` child processes.

**Does it work on Linux? Windows?**
macOS and Linux, yes (pause/resume use POSIX signals). Windows is untested.

**Is it really running real agents, or a mock?**
Real. Each session is a live `claude` CLI subprocess. Cost is summed from Claude's
own `total_cost_usd`, not estimated. (There's a `MC_MOCK` mode for offline UI dev.)

**How is this different from tmux?**
tmux is a generic multiplexer — every pane looks the same. Mission Control
understands Claude Code: per-agent status, cost/context/token tracking, approval
routing, sub-agent fan-out, no prefix keys. It runs alongside tmux and over SSH.

**How is this different from cmux?**
cmux is a native macOS GUI app. Mission Control is a terminal TUI — no app bundle,
no Electron, runs anywhere a terminal does. Different tool for people who live in
the terminal.

**Why AGPL instead of MIT?**
Strong copyleft: modifications stay open. For a local TUI the network clause has
little practical effect, but it keeps the project and its forks open source.

**Can I theme it?**
Seven built-in palettes including green-phosphor **Matrix**; `:theme <name>` or
Settings → Colors. It's self-hosted, so the palettes in `tui/lib/themes.js` are
yours to edit.

**How many agents can it run?**
Up to 10 on the grid by default (configurable higher). Each is one subprocess;
practical limits are your machine and your Claude rate limits.

**What's the catch / current limitations?**
Single-user and localhost-only by design. Pausing (SIGSTOP) stops the process but
won't cancel a request already in flight. The `run_in_background` Task "idle" case
isn't fully surfaced yet. It's v1.0.0 — issues and PRs welcome.

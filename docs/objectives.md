# Project objectives

The canonical ledger of what this project is for and how close it is. This file
is the contract `/forge:doctor` checks conformance against. Narrative history
belongs in the task db (each task's Why and Result sections); this file is the
durable, measurable index.

> Seeded by `forge install`. Replace the example rows below with your project's
> real objectives, then keep the **Status** column current as work lands.

Status vocabulary: **done** (shipped + enforced) · **partial** (some surface
shipped, gaps remain) · **planned** (charter exists, not built).

## Objectives

| # | Objective | Status | Signal that proves it |
|---|-----------|--------|------------------------|
| 1 | *(example)* Core feature X works end to end | planned | a test/command a reviewer can run to see it working |
| 2 | *(example)* Deploys are gated and repeatable | planned | `/forge:deploy` is the only sanctioned path; reviewer blocks on critical findings |

<!--
Add one row per durable objective. Keep rows measurable: the "Signal" column
must name a concrete, observable thing (a passing test, a command's output, an
enforced hook) — not an aspiration. Move Status planned → partial → done as the
signal becomes real.
-->

## How progress is tracked

- **This ledger** — the Status column moves planned → partial → done as work lands.
- **`tasks/`** — the single record: narrative in each task's Why section,
  outcomes in its Result section (HANDOFF retired 2026-08-15).
- **`tasks/_index.md`** — auto-generated live task state.
- **`/forge:doctor`** — machine-checked conformance per directive.

#!/usr/bin/env node
// bin/mc.mjs — CLI entry for `mc` (BlueArch Mission Control TUI).
//
// We use tsx's programmatic loader registration so the bin shebang stays at
// plain `node` and JSX files in tui/ still load transparently. This keeps
// `mc` runnable as a normal Node script + as `npm start`.

import { register } from 'tsx/esm/api';

// Run React (via Ink) in PRODUCTION mode. With NODE_ENV unset, React 19 runs its
// dev build, which emits ~7 unbounded `performance.measure()` User-Timing entries
// per render; Node's perf_hooks timeline retains them forever (nothing calls
// clearMeasures), so over a long uptime they accumulate to millions of
// PerformanceMeasure objects → multi-GB heap → OOM (issue #18, root-caused
// 2026-07-28 from a 4.3GB heapsnapshot: 3.3M such objects). Production React emits
// zero and halves boot heap. Set BEFORE the dynamic import below that loads
// React/Ink (static imports are hoisted, but React arrives via that import, so this
// assignment lands first). Explicit `NODE_ENV=development` still overrides for local
// debugging.
process.env.NODE_ENV ??= 'production';

register();

// Headless self-check (`MC_SMOKE=1 mc`): boot the runtime WITHOUT the Ink render
// (which needs a TTY), prove the import graph resolves + a real pty.spawn works,
// print `MC_SMOKE_OK <version>`, exit. This is the assertion scripts/verify-pack.mjs
// runs against a freshly-installed tarball, so a broken `files:` manifest or a
// non-executable node-pty spawn-helper fails BEFORE the build reaches npm.
if (process.env.MC_SMOKE === '1') {
  const { selfCheck } = await import('../tui/selfCheck.mjs');
  await selfCheck();
} else {
  await import('../tui/main.jsx');
}

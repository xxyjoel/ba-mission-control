// tests/perf.measures.test.jsx — regression guard for OOM #18 (task 0349/0352).
//
// React's DEV build emits ~7 unbounded `performance.measure()` User-Timing entries
// per render; Node's perf_hooks retains them forever → millions of PerformanceMeasure
// objects over a long uptime → multi-GB heap → OOM. The app fixes this by running
// React in PRODUCTION mode (bin/mc.mjs sets NODE_ENV=production before importing Ink).
//
// This file guards BOTH halves of the fix:
//   1. behavioral — under production React, N re-renders accumulate ZERO measures;
//   2. wiring     — bin/mc.mjs actually sets NODE_ENV=production BEFORE the dynamic
//                   import that loads React/Ink.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('production React accumulates zero performance.measure entries across re-renders', async () => {
  // Set BEFORE the first React load, then dynamic-import so React evaluates in prod.
  // (Static imports are hoisted; a fresh per-file test process loads React here first.)
  process.env.NODE_ENV = 'production';
  const React = (await import('react')).default;
  const { render } = await import('ink-testing-library');
  const { Box, Text } = await import('ink');
  const h = React.createElement;
  const App = ({ n }) => h(Box, { flexDirection: 'column' }, h(Text, null, `tick ${n}`));

  const before = performance.getEntriesByType('measure').length;
  const { rerender, unmount } = render(h(App, { n: 0 }));
  for (let i = 1; i <= 200; i++) rerender(h(App, { n: i }));
  const delta = performance.getEntriesByType('measure').length - before;
  try { unmount(); } catch {}

  assert.equal(delta, 0, `expected 0 accumulated perf measures in production React, got ${delta}`);
});

test('bin/mc.mjs sets NODE_ENV=production before importing the Ink/React app', () => {
  const src = readFileSync(join(__dirname, '..', 'bin', 'mc.mjs'), 'utf8');
  const assignIdx = src.search(/process\.env\.NODE_ENV\s*\?\?=\s*['"]production['"]/);
  const importIdx = src.search(/import\(\s*['"]\.\.\/tui\/main\.jsx['"]\s*\)/);
  assert.ok(assignIdx !== -1, 'bin/mc.mjs must default NODE_ENV to production');
  assert.ok(importIdx !== -1, 'bin/mc.mjs must load the app via dynamic import(../tui/main.jsx)');
  assert.ok(assignIdx < importIdx, 'NODE_ENV must be set BEFORE the dynamic app import');
});

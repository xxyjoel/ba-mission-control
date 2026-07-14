// tests/projectHealth.test.mjs — the per-project Session Health reader that
// feeds the card chip + zoom stats line. Pins: latest-reading parse, trend
// arrow vs the prior reading, partial-leading-line tolerance (tail window cut
// mid-record), missing-file safety, and the mtime/TTL cache.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectHealth, _resetProjectHealthCache } from '../tui/lib/projectHealth.js';

function makeRepo(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-health-'));
  mkdirSync(join(dir, '.project-health'), { recursive: true });
  if (lines != null) {
    writeFileSync(join(dir, '.project-health', 'history.jsonl'), lines);
  }
  _resetProjectHealthCache();
  return dir;
}
function row(o) { return JSON.stringify(o); }

test('reads the latest reading: score + verdict word', () => {
  const dir = makeRepo(row({ composite: 85.9, verdict: 'HEALTHY — converging' }) + '\n');
  const h = readProjectHealth(dir);
  assert.equal(h.score, 85.9);
  assert.equal(h.verdictWord, 'HEALTHY');
  rmSync(dir, { recursive: true, force: true });
});

test('trend arrow reflects delta vs the prior reading', () => {
  const up = makeRepo([row({ composite: 80, verdict: 'STABLE' }), row({ composite: 86, verdict: 'HEALTHY' })].join('\n') + '\n');
  assert.equal(readProjectHealth(up).arrow, '↑');
  rmSync(up, { recursive: true, force: true });

  const down = makeRepo([row({ composite: 90, verdict: 'HEALTHY' }), row({ composite: 70, verdict: 'DEGRADED' })].join('\n') + '\n');
  assert.equal(readProjectHealth(down).arrow, '↓');
  rmSync(down, { recursive: true, force: true });

  const flat = makeRepo([row({ composite: 86 }), row({ composite: 86.2 })].join('\n') + '\n');
  assert.equal(readProjectHealth(flat).arrow, '·');
  rmSync(flat, { recursive: true, force: true });
});

test('tolerates a partial leading line (tail window cut mid-record)', () => {
  // Simulate the tail starting in the middle of an older record.
  const garbage = '{"composite": 99, "verdict": "trunca';
  const dir = makeRepo(garbage + '\n' + row({ composite: 77, verdict: 'STABLE — holding' }) + '\n');
  const h = readProjectHealth(dir);
  assert.equal(h.score, 77);
  assert.equal(h.verdictWord, 'STABLE');
  rmSync(dir, { recursive: true, force: true });
});

test('missing file / no reading yet → null (no throw)', () => {
  const dir = makeRepo(null); // .project-health exists but no history.jsonl
  assert.equal(readProjectHealth(dir), null);
  assert.equal(readProjectHealth('/nope/does/not/exist'), null);
  assert.equal(readProjectHealth(''), null);
  assert.equal(readProjectHealth(undefined), null);
  rmSync(dir, { recursive: true, force: true });
});

test('TTL cache: a rewrite within the TTL is not re-read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-health-'));
  mkdirSync(join(dir, '.project-health'), { recursive: true });
  const file = join(dir, '.project-health', 'history.jsonl');
  writeFileSync(file, row({ composite: 50, verdict: 'DEGRADED' }) + '\n');
  _resetProjectHealthCache();

  const t0 = 1_000_000;
  assert.equal(readProjectHealth(dir, t0).score, 50);
  // Rewrite, but read again within the TTL with the same logical clock — cached.
  writeFileSync(file, row({ composite: 95, verdict: 'HEALTHY' }) + '\n');
  assert.equal(readProjectHealth(dir, t0 + 100).score, 50, 'within TTL → cached value');
  // Past the TTL it re-stats; mtime changed → fresh read.
  assert.equal(readProjectHealth(dir, t0 + 5000).score, 95, 'past TTL + mtime change → re-read');
  rmSync(dir, { recursive: true, force: true });
});

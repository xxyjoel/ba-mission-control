// tests/procStats.test.mjs — 0387: per-agent CPU/RSS sampling.
// parsePsOutput is the pure seam; samplePids gets one live smoke test against
// our own pid (ps exists on every platform mc supports).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePsOutput, samplePids } from '../server/procStats.mjs';

test('parsePsOutput: ragged whitespace rows → pid map', () => {
  const m = parsePsOutput('  123  4.5  180224\n 9999   0.0   65536\n');
  assert.equal(m.size, 2);
  assert.deepEqual(m.get(123), { cpu: 4.5, rssKb: 180224 });
  assert.deepEqual(m.get(9999), { cpu: 0, rssKb: 65536 });
});

test('parsePsOutput: malformed rows and empty input are skipped, not fatal', () => {
  assert.equal(parsePsOutput('').size, 0);
  assert.equal(parsePsOutput(null).size, 0);
  const m = parsePsOutput('garbage line\n42 1.0\n7 x y\n77 2.0 1024\n');
  assert.equal(m.size, 1);
  assert.deepEqual(m.get(77), { cpu: 2.0, rssKb: 1024 });
});

test('samplePids: empty/invalid pid list resolves to empty Map without spawning', async () => {
  assert.equal((await samplePids([])).size, 0);
  assert.equal((await samplePids([0, -1, 1.5, NaN])).size, 0);
});

test('samplePids: samples our own process', async () => {
  const m = await samplePids([process.pid]);
  const s = m.get(process.pid);
  assert.ok(s, 'own pid must be present');
  assert.ok(s.rssKb > 1000, `a live node process has >1MB RSS (got ${s.rssKb}KiB)`);
  assert.ok(s.cpu >= 0);
});

test('samplePids: a dead pid resolves to empty Map (ps exit 1 is data)', async () => {
  // Pick a pid far above typical pid_max usage that is almost surely free;
  // even if it exists the assertion only checks we do not reject.
  const m = await samplePids([2 ** 22 - 7]);
  assert.ok(m instanceof Map);
});

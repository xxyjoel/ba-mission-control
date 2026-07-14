// tests/smoke.test.mjs — verifies the test harness itself works.
// Removed (or left) once the rest of the suite is populated.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('harness boots and node:test runs', () => {
  assert.equal(1 + 1, 2);
});

test('tsx loader is active for ESM imports', async () => {
  const { Fleet } = await import('../server/fleet.mjs');
  assert.ok(typeof Fleet === 'function', 'Fleet should be importable');
});

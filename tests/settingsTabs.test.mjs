// tests/settingsTabs.test.mjs — Settings tab-strip window math.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_SCHEMA } from '../tui/lib/settings.js';
import { tabChipWidth, visibleTabRange } from '../tui/lib/settingsTabs.js';

test('tabChipWidth: last tab has no trailing gap', () => {
  const last = SETTINGS_SCHEMA.length - 1;
  assert.equal(tabChipWidth(SETTINGS_SCHEMA, last), `[${last + 1}] ${SETTINGS_SCHEMA[last].title}`.length);
  assert.ok(tabChipWidth(SETTINGS_SCHEMA, 0) > `[1] ${SETTINGS_SCHEMA[0].title}`.length);
});

test('visibleTabRange: active NOTES fits fully inside a 92-col modal strip', () => {
  const avail = 92 - 4; // Settings paddingX={2}
  const notes = SETTINGS_SCHEMA.findIndex(t => t.id === 'notes');
  const { lo, hi } = visibleTabRange(SETTINGS_SCHEMA, notes, avail);
  assert.ok(lo <= notes && notes <= hi);
  let used = 0;
  for (let i = lo; i <= hi; i++) used += tabChipWidth(SETTINGS_SCHEMA, i);
  // leading ‹ / trailing › are painted outside this sum; chips alone must fit.
  assert.ok(used <= avail, `window width ${used} exceeds avail ${avail}`);
  assert.equal(SETTINGS_SCHEMA[notes].title, 'NOTES');
});

test('visibleTabRange: early tabs still start at GENERAL when active is LAYOUT', () => {
  const { lo, hi } = visibleTabRange(SETTINGS_SCHEMA, 1, 88);
  assert.equal(lo, 0);
  assert.ok(hi >= 1);
});

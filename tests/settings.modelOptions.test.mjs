// tests/settings.modelOptions.test.mjs — the Settings "Default model" cycler
// must list the LIVE catalog, not a snapshot. It was previously a hardcoded
// array that silently fell out of sync with tui/lib/models.js (fable-5 and
// sonnet-5 existed but were unselectable — task 0367), and a frozen
// Object.keys() snapshot would equally miss models discovered from the
// claude CLI probe after import. The options are therefore the modelIds()
// FUNCTION, resolved per keypress by the Settings cycler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_SCHEMA, SETTINGS_DEFAULTS } from '../tui/lib/settings.js';
import { MODELS, modelIds } from '../tui/lib/models.js';

function defaultModelItem() {
  for (const group of SETTINGS_SCHEMA) {
    const item = group.items.find((i) => i.key === 'defaultModel');
    if (item) return item;
  }
  return null;
}

test('Default-model options are the live modelIds() view, not a frozen list', () => {
  const item = defaultModelItem();
  assert.ok(item, 'defaultModel item exists in SETTINGS_SCHEMA');
  assert.equal(typeof item.options, 'function', 'options must be a live function');
  assert.deepEqual(item.options(), modelIds());
});

test('options() reflects a model discovered after module load', () => {
  const item = defaultModelItem();
  MODELS['zz-test-model'] = { label: 'ZZ', cliModel: 'claude-zz-test', kind: 'sonnet', maxCtx: 1, maxOut: 1 };
  try {
    assert.ok(item.options().includes('zz-test-model'), 'a catalog mutation shows up in the cycler');
  } finally {
    delete MODELS['zz-test-model'];
  }
});

test('the shipped defaultModel is a valid catalog id', () => {
  assert.ok(
    MODELS[SETTINGS_DEFAULTS.defaultModel],
    `defaultModel '${SETTINGS_DEFAULTS.defaultModel}' must exist in MODELS`,
  );
});

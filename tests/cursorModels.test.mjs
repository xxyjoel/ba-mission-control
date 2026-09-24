// tests/cursorModels.test.mjs — refreshCursorModels → registerProviderModels.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, modelIds } from '../tui/lib/models.js';
import {
  parseCursorModelList,
  refreshCursorModels,
  cursorModelArg,
} from '../server/providers/cursor/models.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cursor');
const LIST = readFileSync(join(FIX, 'list-models.txt'), 'utf8');

afterEach(() => {
  for (const k of Object.keys(MODELS)) if (k.startsWith('cursor:')) delete MODELS[k];
});

test('parseCursorModelList: real list-models fixture', () => {
  const list = parseCursorModelList(LIST);
  assert.ok(list.length > 10);
  assert.equal(list[0].id, 'auto');
  assert.ok(list.some((m) => m.id === 'composer-2.5'));
});

test('refreshCursorModels: exec --list-models then registerProviderModels', async () => {
  const calls = [];
  const models = await refreshCursorModels({
    exec: async (bin, args) => {
      calls.push({ bin, args });
      return LIST;
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--list-models']);
  assert.ok(models.some((m) => m.id === 'composer-2.5'));
  assert.ok(modelIds('cursor').includes('cursor:composer-2.5'));
  assert.ok(MODELS['cursor:composer-2.5']);
});

test('cursorModelArg: strips cursor: prefix', () => {
  assert.equal(cursorModelArg('cursor:composer-2.5'), 'composer-2.5');
  assert.equal(cursorModelArg('auto'), 'auto');
  assert.equal(cursorModelArg(null), null);
});

// tests/models.provider.test.mjs — 0420: Cursor models live in the same
// catalog under namespaced keys, and every Claude-facing selector keeps
// seeing exactly the Claude list it saw before.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODELS, modelIds, newestModelId, resolveModelId, estimatedPricingFor, modelByCli, modelColor,
  registerProviderModels, cursorCliArg, parseCursorModelList,
} from '../tui/lib/models.js';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];

// Real `cursor-agent --list-models` output (2026-09-22), including the
// trailing zero-width spaces the CLI prints on one label.
const LIST_MODELS_FIXTURE = 'Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5\nclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\ngrok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b\n';

const CLAUDE_IDS_BEFORE = modelIds();

afterEach(() => {
  for (const k of Object.keys(MODELS)) if (k.startsWith('cursor:')) delete MODELS[k];
});

test('parseCursorModelList: parses `id - Label` lines, skips header/blank, strips zero-width chars', () => {
  assert.deepEqual(parseCursorModelList(LIST_MODELS_FIXTURE), [
    { id: 'auto', label: 'Auto (default)' },
    { id: 'composer-2.5', label: 'Composer 2.5' },
    { id: 'claude-opus-5-thinking-high', label: 'Claude Opus 5 1M Thinking' },
    { id: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol 1M High' },
    { id: 'grok-4.7-low-fast', label: 'Grok 4.7  Low Fast' },
  ]);
});

test('parseCursorModelList: garbage in → [] (never throws)', () => {
  assert.deepEqual(parseCursorModelList(''), []);
  assert.deepEqual(parseCursorModelList(null), []);
  assert.deepEqual(parseCursorModelList('Available models\n\nnot a model line\n'), []);
});

test('registerProviderModels: namespaced entries with provider/kind/cliModel/label, no pricing', () => {
  registerProviderModels('cursor', parseCursorModelList(LIST_MODELS_FIXTURE));
  const e = MODELS['cursor:composer-2.5'];
  assert.deepEqual(e, { label: 'Composer 2.5', cliModel: 'cursor:composer-2.5', kind: 'cursor', provider: 'cursor' });
  assert.equal(MODELS['cursor:auto'].label, 'Auto (default)');
  for (const [k, m] of Object.entries(MODELS)) {
    if (!k.startsWith('cursor:')) continue;
    for (const f of ['costPerMTokIn', 'costPerMTokOut', 'costPerMTokCacheCreation', 'costPerMTokCacheRead', 'estimatedPricing']) {
      assert.ok(!(f in m), `${k} carries no ${f}`);
    }
  }
});

test('registerProviderModels: maxCtx parsed from 1M / 300K in the label, else absent', () => {
  registerProviderModels('cursor', [
    ...parseCursorModelList(LIST_MODELS_FIXTURE),
    { id: 'k-model', label: 'Some Model 300K' },
  ]);
  assert.equal(MODELS['cursor:claude-opus-5-thinking-high'].maxCtx, 1_000_000);
  assert.equal(MODELS['cursor:gpt-5.6-sol-high'].maxCtx, 1_000_000);
  assert.equal(MODELS['cursor:k-model'].maxCtx, 300_000);
  assert.ok(!('maxCtx' in MODELS['cursor:composer-2.5']));
  assert.ok(!('maxCtx' in MODELS['cursor:auto']));
});

test('registerProviderModels: re-registering replaces the provider\'s previous list', () => {
  registerProviderModels('cursor', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
  registerProviderModels('cursor', [{ id: 'b', label: 'B2' }]);
  assert.deepEqual(modelIds('cursor'), ['cursor:b']);
  assert.equal(MODELS['cursor:b'].label, 'B2');
});

test('modelIds(): default and "claude" return the unchanged Claude-only list', () => {
  registerProviderModels('cursor', parseCursorModelList(LIST_MODELS_FIXTURE));
  assert.deepEqual(modelIds(), CLAUDE_IDS_BEFORE);
  assert.deepEqual(modelIds('claude'), CLAUDE_IDS_BEFORE);
  assert.deepEqual(modelIds('cursor'), [
    'cursor:auto', 'cursor:composer-2.5', 'cursor:claude-opus-5-thinking-high',
    'cursor:gpt-5.6-sol-high', 'cursor:grok-4.7-low-fast',
  ]);
});

test('newestModelId / resolveModelId / estimatedPricingFor ignore cursor entries', () => {
  const before = {
    opus: newestModelId('opus'), auto: resolveModelId('auto'),
    est: estimatedPricingFor('claude-opus-9'), estUnknown: estimatedPricingFor('mystery-model'),
  };
  // A cursor entry whose id looks like a newer Claude opus must not win.
  registerProviderModels('cursor', [{ id: 'opus-99', label: 'Opus 99' }, { id: 'claude-opus-5-thinking-high', label: 'Claude Opus 5 1M Thinking' }]);
  MODELS['cursor:opus-99'].kind = 'opus'; // even if a kind collides
  assert.equal(newestModelId('opus'), before.opus);
  assert.equal(newestModelId('cursor'), null);
  assert.equal(resolveModelId('auto'), before.auto);
  assert.deepEqual(estimatedPricingFor('claude-opus-9'), before.est);
  assert.deepEqual(estimatedPricingFor('mystery-model'), before.estUnknown);
});

test('modelByCli: finds cursor entries by their namespaced cli id and never matches a claude one', () => {
  registerProviderModels('cursor', parseCursorModelList(LIST_MODELS_FIXTURE));
  assert.equal(modelByCli('cursor:composer-2.5').id, 'cursor:composer-2.5');
  assert.equal(modelByCli('cursor:claude-opus-5-thinking-high').provider, 'cursor');
  assert.equal(modelByCli('claude-opus-4-8').id, 'opus-4.8');
  assert.equal(modelByCli('composer-2.5'), null, 'bare cursor id is not a catalog cli id');
  assert.equal(modelByCli('cursor:opus-4.8'), null);
});

test('modelColor: kind cursor falls through to the default colour', () => {
  registerProviderModels('cursor', [{ id: 'auto', label: 'Auto (default)' }]);
  assert.equal(modelColor('cursor:auto', theme), theme.brBlue);
});

test('cursorCliArg strips the namespace; auto is a real cursor model id and passes', () => {
  assert.equal(cursorCliArg('cursor:composer-2.5'), 'composer-2.5');
  assert.equal(cursorCliArg('cursor:auto'), 'auto');
  assert.equal(cursorCliArg('composer-2.5'), 'composer-2.5');
  assert.equal(cursorCliArg(null), null);
  assert.equal(cursorCliArg(''), null);
});

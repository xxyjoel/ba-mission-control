// tests/Card.providerPlaceholder.test.jsx — 0420 decision D1.
//
// A provider that cannot (yet) measure cost / tokens / throughput ships those
// fields as null. The card prints a same-shape placeholder — `$-.--` and
// `-↓ -↑`, tok/min `-` — deliberately distinct from UNKNOWN ('?'), which
// stays reserved for an unknown ctx limit. A null context prints `-` for the
// ctx value and draws no bar (an empty bar reads as 0%).
//
// Claude agents never ship null, so their cards must stay byte-identical:
// tests/fixtures/card-golden-0420.json was captured from the pre-0420 Card
// with colour forced on, and every case is re-rendered and compared.

import './lib/force-color.js';
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import Card from '../tui/Card.jsx';
import { THEMES } from '../tui/lib/themes.js';
import { MODELS, registerProviderModels } from '../tui/lib/models.js';
import { GOLDEN_CASES, GOLDEN_NOW } from './lib/cardGolden0420.js';

const theme = THEMES['BlueArch'];
const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/card-golden-0420.json', import.meta.url), 'utf8'));
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

function frame(agent, props = {}) {
  const realNow = Date.now;
  Date.now = () => GOLDEN_NOW;
  try {
    const { lastFrame, unmount } = render(
      <Box width={props.cardWidth || 56}>
        <Card agent={agent} focused={false} threshold={150000} warnPct={85}
          borderStyle="rounded" theme={theme} cardWidth={56} {...props} />
      </Box>,
    );
    const f = lastFrame() || '';
    unmount();
    return f;
  } finally {
    Date.now = realNow;
  }
}

for (const c of GOLDEN_CASES) {
  test(`golden: Claude card is byte-identical to pre-0420 — ${c.name}`, () => {
    assert.ok(GOLDEN[c.name], 'fixture has this case');
    assert.equal(frame(c.agent, c.props), GOLDEN[c.name]);
  });
}

const nullAgent = (over = {}) => ({
  ...GOLDEN_CASES[0].agent,
  slot: 7, id: 's7-null', name: 'cursor-ish', model: 'sonnet-4.6',
  costSession: null, tokensIn: null, tokensOut: null, tokensCacheRead: null,
  context: null, spark: null, lastTokRate: null, procMemKb: 0,
  ...over,
});

const rowOf = (f, rx) => strip(f).split('\n').find((l) => rx.test(l)) || '';

test('D1: null cost/tokens render `$-.-- ses … -↓ -↑` on the foot row', () => {
  const f = frame(nullAgent());
  const foot = rowOf(f, /ses/);
  assert.match(foot, /│ \$-\.-- ses +-↓ -↑ │$/, `foot row: ${JSON.stringify(foot)}`);
  assert.doesNotMatch(foot, /\?/, 'placeholder is not the UNKNOWN marker');
  assert.doesNotMatch(foot, /\$0\.00|0↓|0↑/, 'no fabricated zero');
});

test('D1: null tok/min renders `-` instead of a number (even while working)', () => {
  const f = frame(nullAgent({ status: 'working' }));
  const row = rowOf(f, /tok\/min/);
  assert.match(row, /│ tok\/min - +│$/, `tok/min row: ${JSON.stringify(row)}`);
});

test('D1: tok/min is `-` when tokensOut is null even if lastTokRate is absent', () => {
  const a = nullAgent();
  delete a.lastTokRate;
  assert.match(rowOf(frame(a), /tok\/min/), /tok\/min - /);
});

test('D1: null context → ctx value `-`, no bar, known limit printed', () => {
  const f = frame(nullAgent({ model: 'sonnet-4.6' }));
  const row = rowOf(f, /ctx /);
  assert.match(row, /│ ctx limit 1\.0M - +│$/, `ctx row: ${JSON.stringify(row)}`);
  assert.doesNotMatch(row, /[█·│]{3}/, 'no bar drawn for an unmeasured context');
});

test('D1: null context on a model with no maxCtx → `limit ? -`', () => {
  registerProviderModels('cursor', [{ id: 'composer-2.5', label: 'Composer 2.5' }]);
  try {
    const f = frame(nullAgent({ model: 'cursor:composer-2.5' }));
    assert.match(rowOf(f, /ctx /), /│ ctx limit \? - +│$/);
    assert.match(rowOf(f, /Composer/), /Composer 2\.5/, 'namespaced catalog label reaches the card');
  } finally {
    delete MODELS['cursor:composer-2.5'];
  }
});

test('D1: a null-valued card keeps the fixed 11-row shape', () => {
  assert.equal(strip(frame(nullAgent())).split('\n').length, 11);
});

test('D1: a real zero is still a zero, not a placeholder', () => {
  const f = frame(nullAgent({ costSession: 0, tokensIn: 0, tokensOut: 0, context: 0, lastTokRate: 0 }));
  assert.match(rowOf(f, /ses/), /\$0\.00 ses +0↓ 0↑/);
  assert.match(rowOf(f, /tok\/min/), /tok\/min 0 /);
});

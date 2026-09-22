// tests/NewSession.subscriptions.test.jsx — task 0420, the subscription row.
//
// With one usable subscription (today's only case) the modal must render the
// frames captured before 0420 byte for byte (tests/fixtures/ui-baseline-0420.mjs).
// With two or more, a `subscription ◀ … ▶` row appears directly above
// `model`, Tab gains a third stop, and ←/→ on it swaps the model list.
import '../tests/lib/force-color.js';
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mc-ns-subs-'));

const { render } = await import('ink-testing-library');
const { default: NewSession } = await import('../tui/modals/NewSession.jsx');
const { THEMES } = await import('../tui/lib/themes.js');
const { getProvider } = await import('../server/providers/index.mjs');
const BASE = await import('./fixtures/ui-baseline-0420.mjs');

const theme = THEMES['BlueArch'];
const noop = () => {};
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const strip = (s) => (s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const repo = (name) => ({ name, parent: '~/projects', path: `~/projects/${name}`, absPath: `/Users/test/projects/${name}`, last: 'just now', defaultBranch: 'main', remote: '(local)' });

const CLAUDE = getProvider('claude');
const CURSOR = getProvider('cursor');
const CURSOR_MODELS = ['cursor:auto', 'cursor:composer-2.5', 'cursor:gpt-5'];
const modelsFor = (id) => (id === 'cursor' ? CURSOR_MODELS : ['sonnet-4.6', 'opus-4.7']);
const defaultModelFor = (id) => (id === 'cursor' ? 'cursor:composer-2.5' : 'sonnet-4.6');
const modelLabel = (id) => ({ 'cursor:auto': 'Auto', 'cursor:composer-2.5': 'Composer 2.5', 'cursor:gpt-5': 'GPT-5', 'sonnet-4.6': 'SONNET 4.6', 'opus-4.7': 'OPUS 4.7' }[id] || id);

function mount(props = {}) {
  return render(
    <NewSession slot={3} repos={[repo('alpha'), repo('beta')]} defaultModel="sonnet-4.6"
      onLaunch={noop} onClose={noop} theme={theme} {...props} />,
  );
}
async function keys(inst, ks) { for (const k of ks) { await tick(); inst.stdin.write(k); } await tick(); }

for (const [name, extra] of [
  ['no provider props (App today)', {}],
  ['providers=[claude]', { providers: [CLAUDE] }],
  ['providers=[claude] + every new prop', { providers: [CLAUDE], initialProvider: 'claude' }],
]) {
  test(`seamless, ${name}: initial / list-focus / model-cycle frames match pre-0420`, async () => {
    const inst = mount(extra);
    await tick();
    assert.equal(inst.lastFrame(), BASE.newSession_initial);
    await keys(inst, ['\t']);
    assert.equal(inst.lastFrame(), BASE.newSession_list);
    await keys(inst, ['\x1b[C']);
    assert.equal(inst.lastFrame(), BASE.newSession_listRight);
    // Tab still toggles straight back to path — no third stop with one provider.
    await keys(inst, ['\t']);
    assert.match(strip(inst.lastFrame()), /focus \[path\]/);
    inst.unmount();
  });
}

test('seamless: a tall height budget leaves the one-provider frame untouched', async () => {
  const inst = mount({ height: 40 });
  await tick();
  assert.equal(inst.lastFrame(), BASE.newSession_initial);
  inst.unmount();
});

test('one provider: onLaunch still carries provider: claude', async () => {
  const calls = [];
  const inst = mount({ onLaunch: (p) => calls.push(p) });
  await keys(inst, ['\r']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  assert.equal(calls[0].model, 'sonnet-4.6');
  inst.unmount();
});

const two = (extra = {}) => mount({ providers: [CLAUDE, CURSOR], modelsFor, defaultModelFor, modelLabel, ...extra });

test('two providers: the subscription row sits directly above model', async () => {
  const inst = two();
  await tick();
  const lines = strip(inst.lastFrame()).split('\n');
  const sub = lines.findIndex(l => /subscription ◀ Claude Code ▶/.test(l));
  const mod = lines.findIndex(l => /model ◀ SONNET 4\.6 ▶/.test(l));
  assert.ok(sub > 0, lines.join('\n'));
  assert.equal(mod, sub + 1, 'model row immediately follows the subscription row');
  inst.unmount();
});

test('two providers: Tab cycles path → list → subscription → path', async () => {
  const inst = two();
  await tick();
  assert.match(strip(inst.lastFrame()), /focus \[path\]/);
  await keys(inst, ['\t']);
  assert.match(strip(inst.lastFrame()), /focus \[list\]/);
  await keys(inst, ['\t']);
  const f = strip(inst.lastFrame());
  assert.match(f, /focus \[subscription\]/);
  assert.match(f, /← → subscription/);
  assert.match(f, /▶ subscription ◀ Claude Code ▶/);
  await keys(inst, ['\t']);
  assert.match(strip(inst.lastFrame()), /focus \[path\]/);
  inst.unmount();
});

test('two providers: ←/→ in list focus still cycles the model within the provider', async () => {
  const inst = two();
  await keys(inst, ['\t', '\x1b[C']);
  const f = strip(inst.lastFrame());
  assert.match(f, /model ◀ OPUS 4\.7 ▶/);
  assert.match(f, /subscription ◀ Claude Code ▶/);
  inst.unmount();
});

test('two providers: ←/→ in subscription focus swaps provider, model list and default model', async () => {
  const calls = [];
  const inst = two({ onLaunch: (p) => calls.push(p) });
  await keys(inst, ['\t', '\t', '\x1b[C']);
  let f = strip(inst.lastFrame());
  assert.match(f, /subscription ◀ Cursor ▶/);
  assert.match(f, /model ◀ Composer 2\.5 ▶/, 'reset to defaultModelFor(cursor)');
  // Back to list focus: ←/→ now walk the Cursor models.
  await keys(inst, ['\t', '\t', '\x1b[C']);
  f = strip(inst.lastFrame());
  assert.match(f, /focus \[list\]/);
  assert.match(f, /model ◀ GPT-5 ▶/);
  await keys(inst, ['\r']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'cursor');
  assert.equal(calls[0].model, 'cursor:gpt-5');
  assert.equal(calls[0].repoPath, '/Users/test/projects/alpha');
  inst.unmount();
});

test('two providers: ← wraps, and switching back to Claude restores its default model', async () => {
  const inst = two();
  await keys(inst, ['\t', '\t', '\x1b[D']);
  assert.match(strip(inst.lastFrame()), /subscription ◀ Cursor ▶/);
  await keys(inst, ['\x1b[D']);
  const f = strip(inst.lastFrame());
  assert.match(f, /subscription ◀ Claude Code ▶/);
  assert.match(f, /model ◀ SONNET 4\.6 ▶/);
  inst.unmount();
});

test('initialProvider preselects the subscription and its default model', async () => {
  const calls = [];
  const inst = two({ initialProvider: 'cursor', onLaunch: (p) => calls.push(p) });
  await tick();
  const f = strip(inst.lastFrame());
  assert.match(f, /subscription ◀ Cursor ▶/);
  assert.match(f, /model ◀ Composer 2\.5 ▶/);
  await keys(inst, ['\r']);
  assert.equal(calls[0].provider, 'cursor');
  inst.unmount();
});

test('an initialProvider that is not available falls back to the first provider', async () => {
  const inst = mount({ providers: [CLAUDE], initialProvider: 'cursor' });
  await tick();
  assert.equal(inst.lastFrame(), BASE.newSession_initial);
  inst.unmount();
});

test('a provider with no model list keeps its default model and ←/→ is a no-op', async () => {
  const inst = two({ modelsFor: (id) => (id === 'cursor' ? [] : modelsFor(id)), initialProvider: 'cursor' });
  await keys(inst, ['\t', '\x1b[C']);
  assert.match(strip(inst.lastFrame()), /model ◀ Composer 2\.5 ▶/);
  inst.unmount();
});

test('80×24: with two providers the modal fits the overlay height App gives it', async () => {
  // App: overlayHeight(24, 0) = 24 - (3 + 2) = 19 rows for the modal.
  const many = Array.from({ length: 12 }, (_, i) => repo(`r${i}`));
  const inst = two({ repos: many, height: 19 });
  await tick();
  const f = strip(inst.lastFrame());
  const lines = f.split('\n');
  assert.ok(lines.length <= 19, `${lines.length} rows:\n${f}`);
  assert.match(f, /subscription ◀ Claude Code ▶/);
  assert.match(f, /model ◀ SONNET 4\.6 ▶/);
  assert.match(f, /esc cancel/);
  assert.match(f, /▼ \d+ more/);
  // The selection still scrolls within the shorter list.
  await keys(inst, ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B']);
  const g = strip(inst.lastFrame());
  assert.ok(g.split('\n').length <= 19, g);
  assert.match(g, /▶ r6 /, 'the highlighted row stays inside the shortened list');
  inst.unmount();
});

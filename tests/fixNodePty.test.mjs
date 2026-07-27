// tests/fixNodePty.test.mjs — the node-pty spawn-helper self-heal (0345).
// It must resolve node-pty regardless of hoisting, never throw, and report a
// summary — this is the runtime backstop for npx installs that skip postinstall.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixNodePty } from '../scripts/fix-node-pty.mjs';

test('fixNodePty never throws and returns a summary', () => {
  let res;
  assert.doesNotThrow(() => { res = fixNodePty(); });
  assert.equal(typeof res.root, 'string');
  assert.equal(typeof res.present, 'boolean');
  assert.ok(Array.isArray(res.fixed));
});

test('resolves node-pty install dir (present in this repo)', () => {
  const res = fixNodePty();
  assert.equal(res.present, true, 'node-pty should be resolvable in the dev tree');
  assert.ok(res.root.endsWith('node-pty'), `root should point at node-pty, got ${res.root}`);
});

test('after running, every existing spawn-helper is executable', () => {
  const { root } = fixNodePty();
  const candidates = [join(root, 'build/Release/spawn-helper')];
  const prebuilds = join(root, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const d of readdirSync(prebuilds)) candidates.push(join(prebuilds, d, 'spawn-helper'));
  }
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    assert.notEqual(statSync(p).mode & 0o111, 0, `${p} should have an execute bit`);
  }
});

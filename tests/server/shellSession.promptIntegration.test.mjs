// tests/server/shellSession.promptIntegration.test.mjs — S8 (0408).
//
// The cd-on-focus injection used to arm on ANY prompt-shaped output — a
// python REPL's `>>>`, an ssh remote's `$` — and then typed `cd '<dir>'`
// into whatever was running. Contract now: once the shell has emitted a
// shell-integration mark (OSC 133 prompt lifecycle, or OSC 7 cwd report),
// those marks own atFreshPrompt and the regex heuristic is retired for the
// session. Shells with no integration keep the regex fallback unchanged
// (pinned by shellSession.cd.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { getShellSession, cdToCwd, _resetForTest } from '../../server/shellSession.mjs';

function makeStubSpawn() {
  const calls = [];
  const stub = (bin, args, opts) => {
    const dataHandlers = [];
    const writes = [];
    const pty = {
      pid: 9400 + calls.length,
      writes,
      onData(fn) { dataHandlers.push(fn); return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write(d) { writes.push(d); },
      kill() {},
      resize() {},
      fireData(chunk) { for (const fn of dataHandlers) fn(chunk); },
    };
    calls.push(pty);
    return pty;
  };
  stub.calls = calls;
  return stub;
}

// xterm-headless parses asynchronously — give the OSC handlers a beat.
const settle = () => new Promise((r) => setTimeout(r, 60));

test.beforeEach(() => _resetForTest());
test.afterEach(() => _resetForTest());

test('S8: OSC 133;A arms atFreshPrompt and flags integration', async () => {
  const stub = makeStubSpawn();
  const s = getShellSession({ spawn: stub });
  assert.ok(s.term, 'emulator required');
  stub.calls[0].fireData('\x1b]133;A\x07user@host repo % ');
  await settle();
  assert.equal(s.promptIntegration, true);
  assert.equal(s.atFreshPrompt, true);
  assert.equal(cdToCwd('/repo/x'), true);
});

test('S8: after integration is seen, prompt-SHAPED output no longer arms the cd', async () => {
  const stub = makeStubSpawn();
  const s = getShellSession({ spawn: stub });
  stub.calls[0].fireData('\x1b]133;A\x07% ');
  await settle();
  // The user runs a command; OSC 133;C marks command output running.
  stub.calls[0].fireData('\x1b]133;C\x07python3\n');
  await settle();
  assert.equal(s.atFreshPrompt, false);
  // A REPL prints its prompt-shaped `>>>` — the retired regex must not bite.
  stub.calls[0].fireData('Python 3.12\n>>> ');
  await settle();
  assert.equal(s.atFreshPrompt, false, 'REPL prompt must not arm the cd injection');
  assert.equal(cdToCwd('/repo/x'), false);
  assert.deepEqual(stub.calls[0].writes, [], 'nothing typed into the REPL');
});

test('S8: OSC 7 (cwd report at prompt) also counts as integration', async () => {
  const stub = makeStubSpawn();
  const s = getShellSession({ spawn: stub });
  stub.calls[0].fireData('\x1b]7;file://mac/Users/joel\x07% ');
  await settle();
  assert.equal(s.promptIntegration, true);
  assert.equal(s.atFreshPrompt, true);
});

test('S8: without integration marks the regex fallback still drives freshness', () => {
  const stub = makeStubSpawn();
  const s = getShellSession({ spawn: stub });
  stub.calls[0].fireData('joel@mac repo $ ');
  assert.equal(s.promptIntegration, false);
  assert.equal(s.atFreshPrompt, true, 'legacy heuristic unchanged for plain shells');
});

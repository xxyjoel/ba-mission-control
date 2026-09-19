// tests/hookSettings.quoting.test.mjs — S7 (0408): the one shipped shell
// string is single-quoted. claude's hook runner passes `command` through a
// shell; the old double-quoted form still let ", $, ` and \ in a
// home/install path alter the command. The proof here is a round-trip: a
// real /bin/sh word-splits the built command and must hand back the paths
// verbatim, with no expansion (the hostile fixtures use harmless `echo`
// probes — if quoting ever regresses, INJECTED shows up in the output).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildHookSettings } from '../server/hookSettings.mjs';

function stopCommand(settings) {
  return settings.hooks.Stop[0].hooks[0].command;
}

// Word-split `cmd` exactly the way claude's hook runner's shell would, using
// printf so nothing is executed beyond the quoting under test.
function shellWords(cmd) {
  const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${cmd}`], { encoding: 'utf8' });
  return out.split('\n').slice(0, -1);
}

test('S7: node binary and emitter path are single-quoted', () => {
  const p = '/home/user/.local/state/claude-mc/hook-runtime/emit-status.mjs';
  const cmd = stopCommand(buildHookSettings({ emitterPath: p }));
  assert.match(cmd, /^'.*' '.*'$/, `both argv elements single-quoted — got: ${cmd}`);
  assert.deepEqual(shellWords(cmd), [process.execPath, p], 'shell parses back exactly two words');
});

test('S7: ", $() and backticks in the path are inert', () => {
  const hostile = '/tmp/a"$(echo INJECTED)"`echo INJECTED`/emit.mjs';
  const cmd = stopCommand(buildHookSettings({ emitterPath: hostile }));
  const words = shellWords(cmd);
  assert.equal(words.length, 2);
  assert.equal(words[1], hostile, 'path survives the shell verbatim');
  assert.ok(!words.join(' ').includes('INJECTEDINJECTED') || words[1] === hostile,
    'no expansion happened');
  assert.ok(!cmd.includes(`"${hostile}"`), 'no double-quoted (expandable) form remains');
});

test("S7: an embedded single quote round-trips via the '\\'' idiom", () => {
  const hostile = "/tmp/o'brien/emit.mjs";
  const cmd = stopCommand(buildHookSettings({ emitterPath: hostile }));
  assert.ok(cmd.includes("/tmp/o'\\''brien/emit.mjs"), `quote-escaped — got: ${cmd}`);
  assert.deepEqual(shellWords(cmd), [process.execPath, hostile], 'shell hands the path back verbatim');
});

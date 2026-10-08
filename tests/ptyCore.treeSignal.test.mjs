// tests/ptyCore.treeSignal.test.mjs — 0442: which processes a pause / kill
// signals beyond claude's own group. claude's Bash tool runs each shell under
// setsid (own session + group), so -pid alone misses builds and tests.
// Pure rows in, targets out; process.kill is mocked, nothing real is signalled.

import test from 'node:test';
import assert from 'node:assert/strict';
import { treeSignalTargets, signalProcessTree } from '../server/ptyCore.mjs';

const ROOT = 5000;
// claude (5000) → mcp (5001, same group), bash-tool zsh (5002, setsid),
// its build (5003, in 5002's group), a grandchild (5004) that joined a group
// led by a NON-descendant (777), and unrelated mc / system rows.
const ROWS = [
  { pid: 1, ppid: 0, pgid: 1 },
  { pid: 777, ppid: 1, pgid: 777 },
  { pid: 900, ppid: 1, pgid: 900 }, // mc itself
  { pid: ROOT, ppid: 900, pgid: ROOT },
  { pid: 5001, ppid: ROOT, pgid: ROOT },
  { pid: 5002, ppid: ROOT, pgid: 5002 },
  { pid: 5003, ppid: 5002, pgid: 5002 },
  { pid: 5004, ppid: 5003, pgid: 777 },
  { pid: 6000, ppid: 777, pgid: 777 },
];

test('0442: a setsid descendant group is signalled as -pgid; same-group kids are left to -root', () => {
  const t = treeSignalTargets(ROOT, ROWS);
  assert.ok(t.includes(-5002), 'the Bash-tool shell group');
  assert.ok(!t.includes(5001) && !t.includes(-ROOT), 'covered by the -root group signal');
});

test('0442: a descendant in a group led by a non-descendant gets its own pid only', () => {
  const t = treeSignalTargets(ROOT, ROWS);
  assert.ok(t.includes(5004));
  assert.ok(!t.includes(-777) && !t.includes(6000));
});

test('0442: never targets 0, 1, mc\'s own group, or a non-descendant', () => {
  const t = treeSignalTargets(ROOT, ROWS);
  for (const bad of [0, 1, -1, 900, -900, 777, 6000]) assert.ok(!t.includes(bad), `target ${bad}`);
  assert.deepEqual(t.sort(), [-5002, 5004].sort());
});

test('0442: cycles and self-parented rows end the walk; garbage rows are ignored', () => {
  const rows = [
    { pid: ROOT, ppid: 9, pgid: ROOT },
    { pid: 10, ppid: ROOT, pgid: 10 },
    { pid: 11, ppid: 10, pgid: 10 },
    { pid: 10, ppid: 11, pgid: 10 }, // loop back
    { pid: 12, ppid: 12, pgid: 12 },
    { pid: NaN, ppid: ROOT, pgid: 3 },
    null,
  ];
  assert.deepEqual(treeSignalTargets(ROOT, rows), [-10]);
  assert.deepEqual(treeSignalTargets(ROOT, []), []);
  assert.deepEqual(treeSignalTargets(ROOT, undefined), []);
});

test('0442: signalProcessTree snapshots BEFORE the group signal, then signals the extras', (t) => {
  const order = [];
  t.mock.method(process, 'kill', (target, sig) => { order.push(`kill:${target}:${sig}`); return true; });
  const list = () => { order.push('ps'); return ROWS; };
  signalProcessTree(ROOT, 'SIGTERM', list);
  assert.deepEqual(order, ['ps', `kill:-${ROOT}:SIGTERM`, 'kill:-5002:SIGTERM', 'kill:5004:SIGTERM']);
});

test('0442: SIGSTOP walks again after the group stop to catch a shell spawned in between', (t) => {
  const order = [];
  t.mock.method(process, 'kill', (target, sig) => { order.push(`kill:${target}:${sig}`); return true; });
  let n = 0;
  const late = { pid: 5010, ppid: ROOT, pgid: 5010 };
  const list = () => { order.push('ps'); return n++ ? [...ROWS, late] : ROWS; };
  signalProcessTree(ROOT, 'SIGSTOP', list);
  assert.deepEqual(order.slice(0, 3), ['ps', `kill:-${ROOT}:SIGSTOP`, 'ps']);
  assert.ok(order.includes('kill:-5010:SIGSTOP'));
});

test('0442: a group-signal error propagates (for the ESRCH/EPERM fallback); extra errors do not', (t) => {
  t.mock.method(process, 'kill', (target) => {
    if (target === -ROOT) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  assert.throws(() => signalProcessTree(ROOT, 'SIGCONT', () => ROWS), { code: 'ESRCH' });

  const seen = [];
  t.mock.restoreAll();
  t.mock.method(process, 'kill', (target) => {
    seen.push(target);
    if (target === -5002) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  assert.doesNotThrow(() => signalProcessTree(ROOT, 'SIGCONT', () => ROWS));
  assert.ok(seen.includes(5004), 'one failed extra must not cut off the rest');
});

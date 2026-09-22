// tests/SubscriptionLogin.test.jsx — task 0420, the Connect modal.
//
// Connect runs the vendor CLI's own login (`<bin> <loginArgv>`) in a real PTY
// rendered inside the modal, so the user sees the URL / device prompt. mc never
// handles the credential. The spawn is injected here; no process runs.
import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import SubscriptionLogin from '../tui/modals/SubscriptionLogin.jsx';
import { THEMES } from '../tui/lib/themes.js';

const theme = THEMES['BlueArch'];
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
const strip = (s) => (s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function fakeSpawn() {
  const rec = { calls: [], writes: [], kills: [], resizes: [], data: null, exit: null };
  rec.spawn = (file, args, opts) => {
    rec.calls.push({ file, args, opts });
    return {
      pid: 4242,
      onData(cb) { rec.data = cb; return { dispose() {} }; },
      onExit(cb) { rec.exit = cb; return { dispose() {} }; },
      write(b) { rec.writes.push(b); },
      resize(c, r) { rec.resizes.push([c, r]); },
      kill(sig) { rec.kills.push(sig || 'SIGHUP'); },
    };
  };
  return rec;
}

const provider = (bin = 'cursor-agent') => ({ id: 'cursor', label: 'Cursor', bin: () => bin, loginArgv: ['login'] });

test('spawns <bin> <loginArgv> in argv form — an untrusted bin is argv[0], never a shell string', async () => {
  const rec = fakeSpawn();
  const evil = '/opt/x; rm -rf ~ #';
  const inst = render(<SubscriptionLogin provider={provider(evil)} spawn={rec.spawn} onExit={() => {}} onCancel={() => {}} theme={theme} width={80} height={19} />);
  await tick();
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].file, evil);
  assert.deepEqual(rec.calls[0].args, ['login']);
  assert.equal(rec.calls[0].opts.env.TERM, 'xterm-256color');
  inst.unmount();
});

test('renders the CLI output inside the modal with a header naming the command', async () => {
  const rec = fakeSpawn();
  const inst = render(<SubscriptionLogin provider={provider()} spawn={rec.spawn} onExit={() => {}} onCancel={() => {}} theme={theme} width={80} height={19} />);
  await tick();
  rec.data('Open this URL to log in:\r\nhttps://cursor.com/loginDeepControl?x=1\r\n');
  await tick(80);
  const f = strip(inst.lastFrame());
  assert.match(f, /connect Cursor · cursor-agent login/);
  assert.match(f, /https:\/\/cursor\.com\/loginDeepControl/);
  assert.match(f, /⌃Q cancel/);
  assert.ok(f.split('\n').length <= 19, f);
  inst.unmount();
});

test('the process exiting hands control back with the exit code', async () => {
  const rec = fakeSpawn();
  const exits = [];
  const inst = render(<SubscriptionLogin provider={provider()} spawn={rec.spawn} onExit={(r) => exits.push(r)} onCancel={() => {}} theme={theme} width={80} height={19} />);
  await tick();
  rec.exit({ exitCode: 0 });
  await tick();
  assert.deepEqual(exits, [{ providerId: 'cursor', exitCode: 0 }]);
  inst.unmount();
});

test('keys go to the login process; ⌃Q kills it and cancels', async () => {
  const rec = fakeSpawn();
  let cancelled = 0;
  const inst = render(<SubscriptionLogin provider={provider()} spawn={rec.spawn} onExit={() => {}} onCancel={() => { cancelled++; }} theme={theme} width={80} height={19} />);
  await tick();
  inst.stdin.write('y'); await tick();
  inst.stdin.write('\r'); await tick();
  assert.deepEqual(rec.writes, ['y', '\r']);
  inst.stdin.write('\x11'); await tick();
  assert.equal(cancelled, 1);
  assert.equal(rec.kills.length, 1);
  inst.unmount();
});

test('unmounting kills a still-running login so it never outlives the modal', async () => {
  const rec = fakeSpawn();
  const inst = render(<SubscriptionLogin provider={provider()} spawn={rec.spawn} onExit={() => {}} onCancel={() => {}} theme={theme} width={80} height={19} />);
  await tick();
  inst.unmount();
  assert.equal(rec.kills.length, 1);
});

test('a spawn failure renders an error and stays closable', async () => {
  let cancelled = 0;
  const spawn = () => { throw new Error('posix_spawnp failed'); };
  const inst = render(<SubscriptionLogin provider={provider()} spawn={spawn} onExit={() => {}} onCancel={() => { cancelled++; }} theme={theme} width={80} height={19} />);
  await tick();
  assert.match(strip(inst.lastFrame()), /posix_spawnp failed/);
  inst.stdin.write('\x11'); await tick();
  assert.equal(cancelled, 1);
  inst.unmount();
});

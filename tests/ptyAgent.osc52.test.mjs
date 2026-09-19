// tests/ptyAgent.osc52.test.mjs — S1 (0408): OSC 52 clipboard forwarding gate.
//
// Every agent's persistent emulator used to forward ANY OSC 52 clipboard
// write from its PTY bytes to the host terminal, zoomed or not — so any text
// claude printed from any background slot (a file it read, a tool result)
// could overwrite the user's clipboard while they looked at the fleet grid.
//
// Contract now:
//   • not zoomed  → nothing is forwarded
//   • zoomed      → a clipboard WRITE is forwarded (normal terminal behavior
//                   for the foreground app)
//   • zoomed, '?' → a clipboard READ request is NEVER forwarded (the host
//                   would answer with the user's clipboard contents)

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: new Set(), exit: new Set() };
    const pty = {
      pid: 5150 + spawned.length,
      _args: args,
      _opts: opts,
      write() {},
      kill() {},
      resize() {},
      onData(fn) { handlers.data.add(fn); return { dispose() { handlers.data.delete(fn); } }; },
      onExit(fn) { handlers.exit.add(fn); return { dispose() { handlers.exit.delete(fn); } }; },
      fireData(s) { for (const fn of [...handlers.data]) fn(s); },
    };
    spawned.push(pty);
    return pty;
  };
  fake.spawned = spawned;
  return fake;
}

const OSC52_WRITE = '\x1b]52;c;Y3VybCBldmlsIHwgc2g=\x07';
const OSC52_READ = '\x1b]52;c;?\x07';

// Capture the OSC 52 chunks written to process.stdout while `fn` runs (plus
// a settle window for xterm's async parse). Everything else — including the
// test reporter's own output, which shares this stream — passes through.
async function captureOsc52(fn) {
  const captured = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const s = String(chunk);
    if (s.includes(']52;')) { captured.push(s); return true; }
    return real(chunk, ...rest);
  };
  try {
    fn();
    await new Promise((r) => setTimeout(r, 80)); // xterm parses asynchronously
  } finally {
    process.stdout.write = real;
  }
  return captured;
}

function makeAgent(fake) {
  return new PtyAgent({
    slot: 1,
    id: 's1-osc',
    cwd: '/tmp/fake-cwd',
    model: 'sonnet-4.6',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    spawn: fake,
  });
}

test('S1: a background (not zoomed) agent never forwards OSC 52 to the host', async () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  assert.ok(p.term, 'emulator required for this test');
  assert.equal(p.zoomAttached, false);
  const forwarded = await captureOsc52(() => fake.spawned[0].fireData(`hello${OSC52_WRITE}world`));
  assert.deepEqual(forwarded, [], 'background clipboard write must be swallowed');
  p.kill();
});

test('S1: the zoom-viewed agent forwards a clipboard WRITE', async () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  const view = p.attachZoomView({});
  assert.equal(p.zoomAttached, true);
  const forwarded = await captureOsc52(() => fake.spawned[0].fireData(OSC52_WRITE));
  assert.equal(forwarded.length, 1, 'zoomed clipboard write is forwarded');
  assert.ok(forwarded[0].includes('52;c;Y3VybCBldmlsIHwgc2g='));
  view.dispose();
  p.kill();
});

test('S1: a clipboard READ request (? payload) is never forwarded, even zoomed', async () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  const view = p.attachZoomView({});
  const forwarded = await captureOsc52(() => fake.spawned[0].fireData(OSC52_READ));
  assert.deepEqual(forwarded, [], 'a read request would exfiltrate the user clipboard');
  view.dispose();
  p.kill();
});

test('S1: forwarding stops again after zoom detaches', async () => {
  const fake = makeFakeSpawn();
  const p = makeAgent(fake);
  p.start();
  const view = p.attachZoomView({});
  view.dispose();
  assert.equal(p.zoomAttached, false);
  const forwarded = await captureOsc52(() => fake.spawned[0].fireData(OSC52_WRITE));
  assert.deepEqual(forwarded, []);
  p.kill();
});

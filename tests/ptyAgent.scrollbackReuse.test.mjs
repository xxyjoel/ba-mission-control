// tests/ptyAgent.scrollbackReuse.test.mjs — 0402: a restart must not wipe the
// emulator.
//
// start() used to dispose this.term and build a fresh Terminal on every spawn.
// A fresh emulator has buffer.active.length === rows, so PtyPane's
// maxOffset = max(0, length - rows) is 0, every scroll key clamps to 0 and
// Ctrl+Y enters a mode that cannot move. Measured on a live agent at rows=50,
// one start() call: buffer len 226 → 27, maxOffset 176 → 0. --resume reprints
// the transcript into the viewport, so the screen still LOOKS full — the
// history is simply gone.
//
// Contract now: one Terminal per agent for its whole life. A restart resizes
// it if the geometry moved and writes a seam marker; it never rebuilds it.
// The OSC 52 and bell handlers therefore register exactly once — a per-spawn
// registration on a reused term would fire every clipboard write twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PtyAgent } from '../server/ptyAgent.mjs';

function makeFakeSpawn() {
  const spawned = [];
  const fake = (bin, args, opts) => {
    const handlers = { data: new Set(), exit: new Set() };
    const pty = {
      pid: 7000 + spawned.length,
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

// An agent plus its fake spawn, killed even when an assertion throws — a
// leaked PtyAgent keeps a live Terminal and a 3s readyTimer, which stalls the
// whole test file instead of reporting the one failure.
async function withAgent(overrides, body) {
  const fake = makeFakeSpawn();
  const p = new PtyAgent({
    slot: 1,
    id: 's1-scrollback',
    cwd: '/tmp/fake-cwd',
    model: 'sonnet-4.6',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    spawn: fake,
    ...overrides,
  });
  try {
    await body(p, fake);
  } finally {
    try { p.kill(); } catch {}
  }
}

// xterm parses asynchronously — give it a window before reading the buffer.
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// Render every buffer line (scrollback + viewport) as plain text.
function bufferText(term) {
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n');
}

// One line per row, more than fits on screen, each individually identifiable.
function fillScrollback(pty, n) {
  let s = '';
  for (let i = 1; i <= n; i++) s += `line-${i}\r\n`;
  pty.fireData(s);
}

// Capture what the agent forwards to the real terminal while `fn` runs.
// `match` picks the chunks this test cares about; everything else (the test
// reporter shares this stream) passes through untouched.
async function captureStdout(match, fn) {
  const captured = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const s = String(chunk);
    if (match(s)) { captured.push(s); return true; }
    return real(chunk, ...rest);
  };
  try {
    fn();
    await settle();
  } finally {
    process.stdout.write = real;
  }
  return captured;
}

test('0402: changeModel keeps the emulator and its scrollback', async () => {
  await withAgent({}, async (p, fake) => {
    p.start();
    assert.ok(p.term, 'emulator required for this test');
    const rows = p.term.rows;
    const termBefore = p.term;

    fillScrollback(fake.spawned[0], rows * 4);
    await settle();
    const lenBefore = p.term.buffer.active.length;
    assert.ok(lenBefore > rows, `buffer must exceed one screen before the restart (len=${lenBefore}, rows=${rows})`);

    assert.equal(p.changeModel('opus-4.8'), true);
    await settle();

    // The old code disposed term here and built a new one: sameTerm=false and
    // length back down to rows, i.e. maxOffset 0 and a dead scroll mode.
    assert.ok(p.term === termBefore, 'the Terminal instance is reused across start()');
    assert.ok(
      p.term.buffer.active.length > rows,
      `scrollback survives the restart (len=${p.term.buffer.active.length}, rows=${rows})`,
    );
    assert.match(bufferText(p.term), /line-1\b/, 'the oldest line is still readable');
  });
});

test('0402: the restart writes a seam into the buffer', async () => {
  await withAgent({}, async (p, fake) => {
    p.start();
    fillScrollback(fake.spawned[0], 30);
    await settle();
    p.changeModel('opus-4.8');
    await settle();
    // --resume reprints context; without a break the replay reads as the old
    // conversation continuing. Measured caveat: the marker goes to the
    // VIEWPORT, and claude's post---resume repaint (EL 2K + CUU) erases the
    // viewport — see the repaint test below, where the marker is gone and the
    // scrollback is not. So this pins that the seam is written, not that the
    // user always gets to see it.
    assert.match(bufferText(p.term), /session restarted/, 'a seam marker separates the two runs');
  });
});

test('0402: a restart does not re-register the OSC 52 handler', async () => {
  await withAgent({}, async (p, fake) => {
    p.start();
    p.changeModel('opus-4.8');
    p.zoomAttached = true;
    const captured = await captureStdout(
      (s) => s.includes(']52;'),
      () => fake.spawned.at(-1).fireData('\x1b]52;c;aGVsbG8=\x07'),
    );
    p.zoomAttached = false;
    // Two registrations on one reused emulator would forward the same
    // clipboard write twice (acceptance criterion of 0402).
    assert.equal(captured.length, 1, `clipboard forwarded exactly once, got ${captured.length}`);
  });
});

test('0402: a restart does not re-register the bell handler', async () => {
  await withAgent({}, async (p, fake) => {
    p.start();
    p.changeModel('opus-4.8');
    p.zoomAttached = true;
    const bells = await captureStdout(
      (s) => s === '\x07',
      () => fake.spawned.at(-1).fireData('\x07'),
    );
    p.zoomAttached = false;
    assert.equal(bells.length, 1, `bell forwarded exactly once, got ${bells.length}`);
  });
});

test('0402: a restart after a viewport change resizes the reused emulator', async () => {
  await withAgent({ cols: 100, rows: 30 }, async (p, fake) => {
    p.start();
    const termBefore = p.term;
    fillScrollback(fake.spawned[0], 60);
    await settle();

    // Fleet.setViewport can move the geometry while the agent has a live PTY;
    // the restart must not leave the emulator at the stale size.
    p.cols = 120;
    p.rows = 40;
    p.changeModel('opus-4.8');
    await settle();

    assert.ok(p.term === termBefore, 'still the same Terminal');
    assert.equal(p.term.cols, 120);
    assert.equal(p.term.rows, 40);
    assert.ok(p.term.buffer.active.length > 40, 'resize did not cost the scrollback');
  });
});

test('0402: kill() still disposes the emulator', async () => {
  await withAgent({}, async (p) => {
    p.start();
    assert.ok(p.term);
    p.kill();
    assert.ok(p.term === null, 'the term is released with the slot, not kept forever');
  });
});

test('0402: changePermissionMode keeps the emulator and its scrollback', async () => {
  // The Shift+Tab cycle — the other restart the user triggers on purpose, and
  // named alongside changeModel in 0402's acceptance criterion.
  await withAgent({ permissionMode: 'acceptEdits' }, async (p, fake) => {
    p.start();
    const rows = p.term.rows;
    const termBefore = p.term;
    fillScrollback(fake.spawned[0], rows * 4);
    await settle();

    assert.equal(p.changePermissionMode('plan'), true);
    await settle();

    assert.ok(p.term === termBefore, 'the Terminal instance survives a permission-mode switch');
    assert.ok(
      p.term.buffer.active.length > rows,
      `scrollback survives the switch (len=${p.term.buffer.active.length}, rows=${rows})`,
    );
    assert.match(bufferText(p.term), /line-1\b/, 'the oldest line is still readable');
  });
});

test('0402: claude repainting after --resume does not cost the scrollback', async () => {
  // 0402 measured the post---resume repaint as EL 2K x98 + CUU x50 + ED J x0.
  // It rewrites the VIEWPORT; with ED J absent nothing erases the scrollback
  // above it. That is what makes reuse worth doing — the history survives the
  // repaint that made a fresh emulator look full.
  await withAgent({}, async (p, fake) => {
    p.start();
    const rows = p.term.rows;
    fillScrollback(fake.spawned[0], rows * 4);
    await settle();
    const lenBefore = p.term.buffer.active.length;

    p.changeModel('opus-4.8');
    await settle();
    // Cursor up over the whole viewport, erasing each line, then repaint.
    fake.spawned.at(-1).fireData(`\x1b[${rows}A` + '\x1b[2K\r\n'.repeat(rows) + 'resumed transcript\r\n');
    await settle();

    assert.ok(
      p.term.buffer.active.length >= lenBefore,
      `history outlives the repaint (was ${lenBefore}, now ${p.term.buffer.active.length})`,
    );
    const after = bufferText(p.term);
    assert.match(after, /line-1\b/, 'the oldest line is still readable after the repaint');
    // Measured: the seam marker does NOT survive — it sat in the erased
    // viewport. The history above it does, which is the point of the fix.
    assert.doesNotMatch(after, /session restarted/, 'the marker lives in the viewport claude repaints');
  });
});

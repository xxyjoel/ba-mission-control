// tests/zoom/ptyPane.osc8.test.jsx — 0472.
//
// The bug: a link claude drew in zoom lost its URL. claude 2.1.296 picks one
// of two forms in its link helper: in a terminal it thinks can follow links
// (iTerm, ghostty, kitty, Warp…, read from the env mc passes through) it
// writes ONLY the title, wrapped in OSC 8; otherwise `title (url)` as plain
// text. The emulator kept the URL as cell data, but rowToRuns never read it,
// so zoom showed the bare title with nothing to open — an artifact link
// claude drew this way could not be reached from mc.
//
// The fix: link cells form their own run, and PtyPane writes that run back
// out wrapped in OSC 8. Only http(s) URLs are written back, with control
// bytes stripped, so a URL cannot smuggle escape sequences into mc's screen.
//
// The bytes below are rebuilt from claude's render code, not captured live.

import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PtyPane from '../../tui/zoom/PtyPane.jsx';
import { makeStubAgent } from '../lib/zoom-stub.js';
import { renderAt, tick, stripAnsi, THEME } from '../lib/render-size.js';

const URL_ = 'https://claude.ai/code/artifact/abc';
const OSC8 = (url, text, end = '\x1b\\') => `\x1b]8;;${url}${end}${text}\x1b]8;;${end}`;
const stripOsc = (s) => (s || '').replace(/\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, '');

async function renderBytes(bytes) {
  const stub = makeStubAgent({ cols: 60, rows: 6 });
  stub.term.write(bytes);
  const r = renderAt(
    <PtyPane
      agent={stub.agent}
      width={60}
      height={6}
      focus={true}
      onClose={() => {}}
      onToggleTools={() => {}}
      onToggleStats={() => {}}
      onCyclePerm={() => {}}
      theme={THEME}
    />,
    { cols: 70, rows: 16 },
  );
  await tick();
  const raw = r.lastFrame() || '';
  r.unmount();
  return raw;
}

test('0472: an OSC 8 link claude drew keeps its URL in zoom', async () => {
  const raw = await renderBytes(`  \x1b[2mOpened ⧉ ${OSC8(URL_, 'My Page')} done\x1b[22m`);
  assert.ok(raw.includes(`\x1b]8;;${URL_}`), `frame re-emits OSC 8 for ${URL_}`);
  // The visible text is unchanged: title only, layout intact.
  assert.match(stripOsc(stripAnsi(raw)), /Opened ⧉ My Page done/);
});

test('0472: BEL-terminated OSC 8 (claude\'s own terminator) also survives', async () => {
  const raw = await renderBytes(`Published ⧉ ${OSC8(URL_, URL_, '\x07')}`);
  assert.ok(raw.includes(`\x1b]8;;${URL_}`));
  assert.match(stripOsc(stripAnsi(raw)), /Published ⧉ https:\/\/claude\.ai\/code\/artifact\/abc/);
});

test('0472: a non-http link is shown as text but never wrapped', async () => {
  const raw = await renderBytes(`x ${OSC8('javascript:alert(1)', 'click')} y`);
  assert.ok(!raw.includes('\x1b]8;;javascript'), 'javascript: URI is not re-emitted');
  assert.ok(!raw.includes('\x1b]8;;file'), 'no other scheme leaks');
  assert.match(stripOsc(stripAnsi(raw)), /x click y/);
});

test('0472: control bytes in a URL never reach mc\'s screen raw', async () => {
  // xterm's parser already ends the URI at C1 ST (\u009c) and drops C0, but
  // the re-emit path must not depend on that.
  const raw = await renderBytes(`a ${OSC8('https://a.example/\u009b31mq', 'L')} b`);
  assert.ok(!raw.includes('\u009b'), 'no raw CSI from the URL');
  const opens = [...raw.matchAll(/\x1b\]8;;([^\x1b\x07]*)/g)].map((m) => m[1]).filter(Boolean);
  for (const u of opens) assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(u), `clean URL: ${JSON.stringify(u)}`);
});

test('0472: safeLinkUrl keeps http(s) and refuses the rest', async () => {
  const { safeLinkUrl } = await import('../../tui/zoom/ptyCells.js');
  assert.equal(safeLinkUrl(URL_), URL_);
  assert.equal(safeLinkUrl('HTTP://x.example/a?b=1'), 'HTTP://x.example/a?b=1');
  assert.equal(safeLinkUrl('https://a.example/\x1b]0;pwn\x07'), 'https://a.example/]0;pwn');
  assert.equal(safeLinkUrl('javascript:alert(1)'), undefined);
  assert.equal(safeLinkUrl('file:///etc/passwd'), undefined);
  assert.equal(safeLinkUrl('https://' + 'a'.repeat(2050)), undefined);
  assert.equal(safeLinkUrl(undefined), undefined);
});

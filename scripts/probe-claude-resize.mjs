// scripts/probe-claude-resize.mjs — does a real claude leave copies of its
// screen in mc's emulator when the terminal is resized? (0480)
//
// Runs claude in a PTY feeding an @xterm/headless emulator, the way ptyCore
// does. It fills the transcript past one screen with claude's local
// `/context` command (no model call), then replays a slow window drag: each
// step resizes the PTY, then the emulator, 300 ms apart (just over mc's
// 250 ms settle), and pauses after each drag. After each drag it prints:
//   contextHeaders  copies of the /context header in the whole buffer (3 = no copy)
//   footers         claude mode-line rows on screen (1 = no copy)
//   rules           horizontal rules around the input box on screen (2 = one box)
// and writes the screen to <outDir>/view-<label>.txt.
//
// Usage:
//   node scripts/probe-claude-resize.mjs <workdir> <outDir>
//   CLAUDE_BIN=~/.local/share/claude/versions/2.1.326 node scripts/probe-claude-resize.mjs …
// <workdir> should be a throwaway folder; claude asks to trust it and the
// probe answers yes. Measured 2026-11-17: 2.1.296, 2.1.322 and 2.1.326 left
// no copies (3 / 1 / 2 after every drag).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pty from 'node-pty';
import xterm from '@xterm/headless';

const { Terminal } = xterm;
const [workdir, outDir] = process.argv.slice(2);
if (!workdir || !outDir) {
  console.error('usage: node scripts/probe-claude-resize.mjs <workdir> <outDir>');
  process.exit(2);
}
const bin = process.env.CLAUDE_BIN || 'claude';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cols = 120;
let rows = 40;
const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
const p = pty.spawn(bin, [], { name: 'xterm-256color', cwd: workdir, cols, rows, env: { ...process.env, TERM: 'xterm-256color' } });
p.onData((d) => term.write(d));
let exited = false;
p.onExit(() => { exited = true; });

const lines = () => {
  const b = term.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out;
};
const view = () => lines().slice(term.buffer.active.baseY, term.buffer.active.baseY + rows);
const waitFor = async (re, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (view().some((l) => re.test(l))) return true; await sleep(200); }
  return false;
};
const report = (label) => {
  const v = view();
  const row = {
    label, size: `${cols}x${rows}`,
    contextHeaders: lines().filter((l) => /context usage/i.test(l)).length,
    footers: v.filter((l) => /for shortcuts|auto mode|accept edits|bypass permissions|plan mode/i.test(l)).length,
    rules: v.filter((l) => /^\s*─{20,}/.test(l)).length,
  };
  console.log(JSON.stringify(row));
  writeFileSync(join(outDir, `view-${label}.txt`), v.map((l, i) => `${String(i).padStart(2)}|${l}`).join('\n'));
};

// The trust question defaults to "No, exit" (2.1.326): move down to "Yes,
// I trust this folder" before Enter.
if (await waitFor(/trust this folder/i, 8000)) {
  await sleep(800);
  p.write('\x1b[B'); await sleep(400); p.write('\r');
  const t0 = Date.now();
  while (Date.now() - t0 < 10000 && view().some((l) => /trust this folder/i.test(l))) await sleep(200);
}
// claude's own footer, not the trust menu's ❯ (both use that mark).
if (!(await waitFor(/for shortcuts|auto mode|accept edits|bypass permissions|plan mode/i, 25000))) {
  console.error('claude prompt not seen. Screen:\n' + view().filter((l) => l.trim()).join('\n'));
  p.kill(); process.exit(1);
}
await sleep(1500);
for (let k = 0; k < 3; k++) { p.write('/context'); await sleep(600); p.write('\r'); await sleep(3500); }
report('start');
const drags = [
  [[110, 40], [100, 39], [90, 39], [81, 39]],
  [[95, 44], [110, 47], [119, 49]],
  [[110, 52], [100, 55], [96, 58]],
  [[140, 65], [180, 72], [215, 77]],
  [[190, 70], [170, 60]],
];
for (const steps of drags) {
  for (const [c, r] of steps) {
    if (exited) { console.error('claude exited'); process.exit(1); }
    cols = c; rows = r;
    p.resize(c, r);
    term.resize(c, r);
    await sleep(300);
  }
  await sleep(2500);
  report(`drag-to-${cols}x${rows}`);
}
p.kill();
await sleep(300);
process.exit(0);

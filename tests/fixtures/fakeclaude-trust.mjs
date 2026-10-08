#!/usr/bin/env node
// tests/fixtures/fakeclaude-trust.mjs — 0468: stand-in for claude opening on
// its folder-trust dialog. The dialog text is copied from a real capture
// (claude 2.1.294, fresh temp dir, no input sent — see
// tests/fixtures/claude-trust-dialog.screen.txt).
//
// Behaviour:
//   • every byte received is appended to $FAKE_TRUST_LOG as one JSON line
//     {phase, data}, so a test can see what mc typed and when.
//   • while the dialog is up, an Enter picks the highlighted "No, exit": the
//     process prints "exit" and exits 1 — what the real claude does.
//   • when the file $FAKE_TRUST_CLEAR appears (the test's stand-in for the
//     user answering "Yes" in zoom), the dialog is cleared and a composer is
//     drawn; input after that is only logged.
import { appendFileSync, existsSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('0.0.0 (fake-trust)\n');
  process.exit(0);
}

const LOG = process.env.FAKE_TRUST_LOG;
const CLEAR = process.env.FAKE_TRUST_CLEAR;
let phase = 'dialog';

function log(data) {
  if (!LOG) return;
  try { appendFileSync(LOG, JSON.stringify({ phase, data }) + '\n'); } catch {}
}

const DIALOG = [
  '─'.repeat(100),
  ' Accessing workspace:',
  '',
  ` ${process.cwd()}`,
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\r\n');

process.stdout.write('\x1b[2J\x1b[H' + DIALOG + '\r\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (buf) => {
  const s = buf.toString('utf8');
  log(s);
  if (phase === 'dialog' && s.includes('\r')) {
    process.stdout.write('\r\nexit\r\n');
    process.exit(1);
  }
});

const poll = setInterval(() => {
  if (phase === 'dialog' && CLEAR && existsSync(CLEAR)) {
    phase = 'composer';
    process.stdout.write('\x1b[2J\x1b[H' + '─'.repeat(100) + '\r\n> \r\n' + '─'.repeat(100) + '\r\n');
  }
}, 50);
poll.unref?.();
setTimeout(() => process.exit(0), 60_000).unref?.();

// scripts/probe-hooks-interactive.mjs — spike part B: drive an interactive
// claude PTY to emit Notification(permission_prompt), PreToolUse, Stop, and
// Notification(idle_prompt) into a capture file.
//
// Usage:
//   node scripts/probe-hooks-interactive.mjs
//   CLAUDE_BIN=/path/to/claude node scripts/probe-hooks-interactive.mjs
//
// Capture file: /tmp/probe-hooks-capture-<uuid>.jsonl

import { spawn as ptySpawn } from 'node-pty';
import { writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CLAUDE_BIN is user-controlled — treat as untrusted; never interpolate into
// a shell string. Pass as argv[0] only.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const cwd = process.cwd();

const runId = randomUUID();
const captureFile = join(tmpdir(), `probe-hooks-capture-${runId}.jsonl`);
writeFileSync(captureFile, '');

// Self-contained emitter: reads stdin, appends one JSONL line to captureFile.
const emitterFile = join(tmpdir(), `probe-hooks-emitter-${runId}.mjs`);
writeFileSync(emitterFile, [
  '#!/usr/bin/env node',
  "import { appendFileSync } from 'node:fs';",
  `const f = ${JSON.stringify(captureFile)};`,
  'const c = [];',
  "process.stdin.on('data', d => c.push(d));",
  "process.stdin.on('end', () => { appendFileSync(f, Buffer.concat(c).toString().trim() + '\\n'); process.exit(0); });",
].join('\n'), { mode: 0o755 });

// Settings: wire hooks + force permission prompts to appear interactively.
// skipAutoPermissionPrompt:false overrides global true so claude asks before
// running tools instead of auto-approving them.
const emitterCmd = `node ${emitterFile}`;
const hookEntry = [{ hooks: [{ type: 'command', command: emitterCmd }] }];
const settingsFile = join(tmpdir(), `probe-hooks-settings-${runId}.json`);
writeFileSync(settingsFile, JSON.stringify({
  skipAutoPermissionPrompt: false,
  permissions: { allow: [], deny: [] }, // clear inherited tool allow-lists
  hooks: { Notification: hookEntry, PreToolUse: hookEntry, Stop: hookEntry },
}));

// Interactive spawn — no --print. Explicit default permission mode so write
// operations require user approval (triggers Notification:permission_prompt).
const args = ['--settings', settingsFile, '--permission-mode', 'default'];

console.log(`[probe-hooks-interactive] capture:  ${captureFile}`);
console.log(`[probe-hooks-interactive] emitter:  ${emitterFile}`);
console.log(`[probe-hooks-interactive] settings: ${settingsFile}`);
console.log(`[probe-hooks-interactive] spawning: ${CLAUDE_BIN} ${args.join(' ')}`);

const pty = ptySpawn(CLAUDE_BIN, args, {
  name: 'xterm-256color', cols: 120, rows: 30, cwd,
  env: { ...process.env, TERM: 'xterm-256color' },
});

let buf = '';
pty.onData(chunk => { buf += chunk; process.stdout.write(chunk); });
pty.onExit(({ exitCode, signal }) => {
  console.log(`\n[probe-hooks-interactive] claude exited code=${exitCode} signal=${signal}`);
  reportCapture();
  process.exit(exitCode ?? 0);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Strip ANSI escape sequences before pattern matching.
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b[^[]/g, ''); }

async function waitFor(pattern, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(stripAnsi(buf))) { console.log(`\n[probe] found: ${label}`); return true; }
    await sleep(300);
  }
  console.log(`\n[probe] TIMEOUT waiting for: ${label}`);
  return false;
}

function reportCapture() {
  try {
    const lines = readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean);
    console.log(`\n[probe] capture lines: ${lines.length}`);
    for (const ln of lines) {
      try {
        const obj = JSON.parse(ln);
        const evt = obj.hook_event_name || obj.type || '?';
        const ntype = obj.notification_type || '';
        console.log(`  EVENT: ${evt}${ntype ? ':' + ntype : ''} — ${JSON.stringify(obj).slice(0, 200)}`);
      } catch { console.log(`  RAW: ${ln.slice(0, 200)}`); }
    }
  } catch (e) { console.log(`[probe] capture read error: ${e.message}`); }
  console.log(`[probe] capture file: ${captureFile}`);
}

async function run() {
  // Wait for claude's interactive prompt (up to 15s startup time).
  // buf may contain ANSI escapes so test the visible chars via decoded text.
  await sleep(8000); // give claude time to start up and reach prompt
  console.log('\n[probe] post-startup wait done');

  // Send a prompt that uses the Write tool — Write always requires approval in
  // default permission mode, reliably triggering Notification:permission_prompt.
  const probe0260File = '/tmp/probe-0260-write-test.txt';
  const prompt = `Please create the file ${probe0260File} with content "hello_probe_0260". Use the Write tool.`;
  console.log(`\n[probe] typing prompt: ${prompt}`);
  for (const ch of prompt) { pty.write(ch); await sleep(20); }
  await sleep(500);
  pty.write('\r');

  // Wait for the permission dialog. Claude shows a numbered menu like:
  //   "Do you want to create probe-0260-write-test.txt?"
  //   ❯ 1. Yes   2. Yes, allow all ...   3. No
  // Match on "Do you want" or "1. Yes" or "allow all edits".
  const permAppeared = await waitFor(
    /Do you want|allow all edits|1\.\s*Yes/i,
    90000, 'permission prompt dialog'
  );

  if (permAppeared) {
    // Wait 20s so the Notification:permission_prompt hook (which fires after a
    // delay when the dialog is open) has time to trigger and the emitter
    // subprocess completes its appendFileSync before we dismiss the dialog.
    await sleep(20000);
    // Press '1' + Enter to select "1. Yes" in the numbered permission dialog.
    console.log('\n[probe] selecting option 1 (Yes) in permission dialog');
    pty.write('1'); await sleep(200); pty.write('\r');
  } else {
    console.log('\n[probe] WARNING: permission dialog not detected; may have been auto-approved');
  }

  // Wait for the turn to complete (Stop hook fires here).
  await waitFor(/hello_probe_0260|probe-0260|\$\s*$|❯\s*$/, 90000, 'turn complete');
  await sleep(3000); // let Stop hook flush

  // Stay idle long enough for idle_prompt Notification to fire.
  console.log('\n[probe] sitting idle 90s to capture idle_prompt...');
  await sleep(90000);

  console.log('\n[probe] done waiting — killing PTY');
  pty.kill();
  await sleep(1000);
  reportCapture();
  process.exit(0);
}

run().catch(e => { console.error('probe failed:', e); process.exit(1); });

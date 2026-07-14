// scripts/probe-pty.mjs — one-shot research probe for the single-pipeline
// rewrite. Answers R1, R2, R4, R5, R11 from
// docs/notes/research-single-pipeline.md.
//
// Usage:
//   node scripts/probe-pty.mjs > docs/notes/probe-pty.log
//
// Uses a SHORT prompt (one round-trip) — minimizes API cost.

import { spawn as ptySpawn } from 'node-pty';
import { existsSync, readFileSync, statSync, watch as fsWatch } from 'node:fs';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const cwd = process.cwd();
const sessionId = randomUUID();

function encodeCwd(p) { return p.replace(/[^a-zA-Z0-9-]/g, '-'); }
const projectDir = join(homedir(), '.claude', 'projects', encodeCwd(cwd));
const sessionFile = join(projectDir, `${sessionId}.jsonl`);

const tStart = Date.now();
const events = [];
function log(label, extra = {}) {
  const ms = Date.now() - tStart;
  events.push({ ms, label, ...extra });
  console.log(`[+${String(ms).padStart(6, ' ')}ms] ${label}`, Object.keys(extra).length ? JSON.stringify(extra) : '');
}

log('start', { sessionId, projectDir, sessionFileExpected: sessionFile });

// Pre-spawn dir snapshot for sid drift detection
const beforeFiles = existsSync(projectDir)
  ? readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
  : [];
log('preSnapshot', { count: beforeFiles.length });

const args = [
  '--session-id', sessionId,
  '--add-dir', cwd,
  '--permission-mode', 'acceptEdits',
];
log('spawn', { args });

const pty = ptySpawn(CLAUDE_BIN, args, {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' },
});

let firstByteAt = null;
let bannerBuf = '';
pty.onData((chunk) => {
  if (firstByteAt === null) {
    firstByteAt = Date.now() - tStart;
    log('firstByte', { bytes: chunk.length });
  }
  bannerBuf += chunk;
});

let exited = false;
pty.onExit(({ exitCode, signal }) => {
  exited = true;
  log('exit', { exitCode, signal });
});

// Poll for JSONL file appearance
let jsonlFirstSeen = null;
let jsonlMintedSid = null;
const filePoll = setInterval(() => {
  if (jsonlFirstSeen === null) {
    if (existsSync(sessionFile)) {
      jsonlFirstSeen = Date.now() - tStart;
      log('jsonlAppeared', { path: sessionFile, fromHint: true });
    } else if (existsSync(projectDir)) {
      const now = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      const fresh = now.filter(f => !beforeFiles.includes(f));
      if (fresh.length) {
        jsonlFirstSeen = Date.now() - tStart;
        const sid = fresh[0].slice(0, -'.jsonl'.length);
        jsonlMintedSid = sid !== sessionId ? sid : null;
        log('jsonlAppeared', {
          path: join(projectDir, fresh[0]),
          fromHint: sid === sessionId,
          mintedSid: jsonlMintedSid,
        });
      }
    }
  }
}, 100);

// Watch for content writes once the file exists
let fsWatcher = null;
let lastFileSize = 0;
const watchPoll = setInterval(() => {
  const actualFile = jsonlMintedSid
    ? join(projectDir, `${jsonlMintedSid}.jsonl`)
    : sessionFile;
  if (jsonlFirstSeen && !fsWatcher && existsSync(actualFile)) {
    try {
      fsWatcher = fsWatch(actualFile, { persistent: false }, () => {
        try {
          const s = statSync(actualFile);
          if (s.size !== lastFileSize) {
            log('fsWatchFired', { newSize: s.size, delta: s.size - lastFileSize });
            lastFileSize = s.size;
          }
        } catch {}
      });
      log('fsWatchAttached', { path: actualFile });
    } catch (e) {
      log('fsWatchFailed', { error: e.message });
    }
  }
}, 100);

// Test sequence
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function typeText(text) {
  // Send character-by-character with small delays, in case claude
  // batches input that arrives all-at-once differently.
  for (const ch of text) {
    pty.write(ch);
    await sleep(15);
  }
}

async function run() {
  // R1: how long until claude is ready?
  await sleep(3500); // claude takes ~2-3s to warm up after first byte
  log('checkpoint', { phase: 'post-3.5s-wait', jsonlFirstSeen, firstByteAt });

  // R4: send a real prompt slowly + Enter as \r
  log('typing "say only the word pong, nothing else"');
  await typeText('say only the word pong, nothing else');
  await sleep(200);
  log('send Enter (\\r)');
  pty.write('\r');

  // R7: wait long enough for claude to respond + commit turn
  log('waiting 25s for turn to complete');
  await sleep(25000);

  // Scan ALL recent jsonl files across claude's projects dir to catch
  // anything written to an unexpected path.
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const allDirs = readdirSync(projectsRoot).filter(d => {
    try { return statSync(join(projectsRoot, d)).isDirectory(); } catch { return false; }
  });
  const recentFiles = [];
  for (const d of allDirs) {
    try {
      for (const f of readdirSync(join(projectsRoot, d))) {
        if (!f.endsWith('.jsonl')) continue;
        const full = join(projectsRoot, d, f);
        const s = statSync(full);
        if (s.mtimeMs >= tStart) {
          recentFiles.push({ path: full, mtimeMs: s.mtimeMs, size: s.size, sid: f.slice(0, -'.jsonl'.length) });
        }
      }
    } catch {}
  }
  log('recentFilesAcrossAllDirs', { count: recentFiles.length });
  for (const f of recentFiles) {
    console.log('  ', JSON.stringify(f));
  }

  // Read the JSONL file and emit a summary of what events landed
  const actualFile = jsonlMintedSid
    ? join(projectDir, `${jsonlMintedSid}.jsonl`)
    : sessionFile;
  if (existsSync(actualFile)) {
    const lines = readFileSync(actualFile, 'utf8').trim().split('\n');
    const typeCounts = {};
    const samples = {};
    for (const ln of lines) {
      try {
        const ev = JSON.parse(ln);
        typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;
        if (!samples[ev.type]) samples[ev.type] = ev;
      } catch {}
    }
    log('jsonlSummary', { totalLines: lines.length, typeCounts });
    console.log('--- jsonlSampleByType ---');
    for (const [t, ev] of Object.entries(samples)) {
      const shortened = { ...ev };
      if (shortened.message?.content) {
        if (typeof shortened.message.content === 'string') {
          shortened.message.content = shortened.message.content.slice(0, 80) + (shortened.message.content.length > 80 ? '…' : '');
        } else if (Array.isArray(shortened.message.content)) {
          shortened.message.content = `[${shortened.message.content.length} parts: ${shortened.message.content.map(p => p.type).join(',')}]`;
        }
      }
      console.log(`type=${t}:`, JSON.stringify(shortened).slice(0, 400));
    }
  }

  // Clean up
  log('killing pty');
  pty.kill();
  clearInterval(filePoll);
  clearInterval(watchPoll);
  if (fsWatcher) fsWatcher.close();
  await sleep(500);

  // Emit findings JSON
  console.log('\n--- findings ---');
  console.log(JSON.stringify({
    R1_firstByteMs: firstByteAt,
    R2_jsonlFirstSeenMs: jsonlFirstSeen,
    R3_sessionIdHonored: !jsonlMintedSid,
    R3_mintedSid: jsonlMintedSid,
    eventsCount: events.length,
    bannerPreview: bannerBuf.replace(/\x1b\[[\d;]*[A-Za-z]/g, '').slice(0, 400),
  }, null, 2));

  process.exit(0);
}

run().catch(e => { console.error('probe failed:', e); process.exit(1); });

// tests/real/claude.real.test.mjs — 0437: opt-in tests against the REAL claude.
//
// THESE SPEND THE OWNER'S TOKENS. They start the real `claude` binary, logged in
// as the owner, and send it real prompts. Kept as cheap as possible: the cheapest
// model (haiku; one case switches to sonnet), one-word / one-line prompts, and
// only the cases that need a reply send anything at all.
//
// Skipped unless MC_RUN_REAL=1, and always skipped under CI. Run:
//   MC_RUN_REAL=1 node scripts/run-tests.mjs tests/real/claude.real.test.mjs
//
// How the two homes are split. The runner (0436) gives this file a sandbox HOME
// and CLAUDE_BIN=/usr/bin/false. mc itself stays in that sandbox: hook runtime,
// status dir, config. Only the claude CHILD gets the real HOME (MC_REAL_HOME),
// because its login lives there, plus MC_STATUS_DIR pointing at the sandbox
// status dir so the hook emitter (which inherits claude's env) writes there too.
// The binary is the real claude from PATH (or MC_REAL_CLAUDE_BIN), passed to
// PtyAgent as argv[0] — never a shell string.
//
// claude writes the transcript under the REAL ~/.claude/projects/<encoded cwd>.
// mc reads it through claudeSessionPath(), which resolves against the sandbox
// home, so the sandbox gets a symlink for that ONE folder. After the run the
// real folder is deleted, and nothing else under the real home is touched by
// this file.
//
// cwd is a fresh git repo at a STABLE temp path (recreated each run). claude
// asks to trust any new folder; the test answers that dialog, and claude records
// the answer in the real ~/.claude.json. A stable path means one such entry ever,
// not one per run. That file is never edited here — live claudes rewrite it.
//
// Known failures (the point of 0437 is to show them on today's code):
//   - pause stops claude's CHILDREN too → fixed by 0442 (pause signals one pid)
//   - kill / restart leave no claude → 0441. Its measured trigger is a claude
//     that ignores SIGTERM; a well-behaved real claude exits on SIGTERM, so the
//     kill and restart cases here can pass on today's code.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, rmSync, existsSync, realpathSync, symlinkSync, unlinkSync,
  readdirSync, readFileSync, accessSync, lstatSync, constants as fsc,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, relative, isAbsolute, delimiter, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

const RUN = process.env.MC_RUN_REAL === '1' && !process.env.CI;
const SKIP = RUN ? false : 'opt-in: set MC_RUN_REAL=1 (never under CI) — spends real tokens';

const REAL_HOME = process.env.MC_REAL_HOME || '';
const CWD_NAME = 'mc-real-0437';
const MODEL = 'haiku-4.5';
const SWITCH_TO = 'sonnet-4.6';
const T_TEST = 150_000; // per test; the runner's default 30s is far too short
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

// The real claude: MC_REAL_CLAUDE_BIN, else the first executable `claude` on PATH.
function resolveClaudeBin() {
  const env = process.env.MC_REAL_CLAUDE_BIN;
  if (env) return env;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'claude');
    try { accessSync(p, fsc.X_OK); return p; } catch {}
  }
  return null;
}

// ── run state ───────────────────────────────────────────────────────────────
let PtyAgent, claudeProjectDir, STATUS_DIR;
let CLAUDE, CWD, LINK_DIR, REAL_PROJECT_DIR;
const agents = [];      // every agent this file started
const ourPids = new Map(); // pid → start time, for every claude pid and descendant we saw
const sids = new Set();  // every session id seen, for the status-file check

before(async () => {
  if (!RUN) return;
  // Must run under the hermetic runner: the sandbox HOME is what keeps mc's own
  // state out of the real home.
  assert.ok(REAL_HOME, 'MC_REAL_HOME missing — run through scripts/run-tests.mjs');
  assert.notEqual(realpathSync(homedir()), realpathSync(REAL_HOME), 'HOME is the real home — not sandboxed');
  CLAUDE = resolveClaudeBin();
  assert.ok(CLAUDE, 'no claude on PATH (or set MC_REAL_CLAUDE_BIN)');
  // When this file runs from inside a claude session (an agent running the
  // suite), claude's own session markers are in the env and the child inherits
  // them. claude then says "Transcript saving is off — inherited
  // CLAUDE_CODE_CHILD_SESSION marker" and writes no transcript, so resume and
  // :model have nothing to read. Drop them for this test process only.
  for (const k of Object.keys(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)$/.test(k)) delete process.env[k];
  }

  // Imported here, not at top level: ptyAgent copies the hook runtime into
  // homedir() at import, and that must only ever be the sandbox.
  ({ PtyAgent } = await import('../../server/ptyAgent.mjs'));
  ({ claudeProjectDir } = await import('../../server/sessionFileTailer.mjs'));
  ({ STATUS_DIR } = await import('../../server/statusFile.mjs'));
  assert.ok(inside(STATUS_DIR, homedir()), `status dir ${STATUS_DIR} is not in the sandbox`);

  const tmp = realpathSync(tmpdir());
  CWD = join(tmp, CWD_NAME);
  assert.ok(inside(CWD, tmp));
  rmSync(CWD, { recursive: true, force: true });
  mkdirSync(CWD);
  execFileSync('git', ['init', '-q'], { cwd: CWD });

  // claudeProjectDir() resolves against the sandbox home; the same relative
  // path under the real home is where claude writes.
  LINK_DIR = claudeProjectDir(CWD);
  REAL_PROJECT_DIR = join(REAL_HOME, relative(homedir(), LINK_DIR));
  const realProjects = join(REAL_HOME, '.claude', 'projects');
  assert.ok(inside(REAL_PROJECT_DIR, realProjects) && basename(REAL_PROJECT_DIR).includes(CWD_NAME));
  rmSync(REAL_PROJECT_DIR, { recursive: true, force: true }); // a previous aborted run
  mkdirSync(join(homedir(), '.claude', 'projects'), { recursive: true });
  symlinkSync(REAL_PROJECT_DIR, LINK_DIR); // dangling until claude creates it
});

after(async () => {
  if (!RUN) return;
  for (const a of agents) { try { a.kill(); } catch {} }
  await sleep(1500);
  for (const a of agents) { try { a.hardKill(); } catch {} }
  // Anything we started that is still alive (descendants included) goes now.
  // A pid can be reused once its process exits — kill only if it is still the
  // process we saw (same start time).
  for (const [pid, started] of ourPids) {
    if (alive(pid) && started && psStart(pid) === started) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  await sleep(500);
  try { if (LINK_DIR && lstatSync(LINK_DIR).isSymbolicLink()) unlinkSync(LINK_DIR); } catch {}
  const realProjects = join(REAL_HOME, '.claude', 'projects');
  if (REAL_PROJECT_DIR && inside(REAL_PROJECT_DIR, realProjects) && basename(REAL_PROJECT_DIR).includes(CWD_NAME)) {
    rmSync(REAL_PROJECT_DIR, { recursive: true, force: true });
  }
  if (CWD) rmSync(CWD, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function psComm(pid) {
  try { return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

function psStart(pid) {
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

function psStat(pid) {
  try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

// Every descendant pid of `pid` (pgrep -P, walked).
function descendants(pid) {
  const out = [];
  const queue = [pid];
  while (queue.length) {
    const p = queue.shift();
    let kids = [];
    try { kids = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch {}
    for (const k of kids) { out.push(k); queue.push(k); }
  }
  return out;
}

function track(agent) {
  const add = (pid) => { if (!ourPids.has(pid)) ourPids.set(pid, psStart(pid)); };
  if (agent.pty?.pid) add(agent.pty.pid);
  for (const d of agent.pty?.pid ? descendants(agent.pty.pid) : []) add(d);
}

function screen(agent) {
  const buf = agent.term?.buffer?.active;
  if (!buf) return '';
  const rows = [];
  for (let y = 0; y < buf.length; y++) rows.push(buf.getLine(y)?.translateToString(true) ?? '');
  return rows.join('\n');
}

function bottomScreen(agent) {
  const buf = agent.term?.buffer?.active;
  if (!buf) return '';
  const rows = [];
  for (let y = Math.max(0, buf.length - agent.rows); y < buf.length; y++) rows.push(buf.getLine(y)?.translateToString(true) ?? '');
  return rows.join('\n');
}

async function waitFor(fn, ms, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return fn();
}

function makeAgent(opts = {}) {
  const a = new PtyAgent({
    slot: 1,
    cwd: CWD,
    model: MODEL,
    permissionMode: 'acceptEdits',
    cols: 120,
    rows: 40,
    bin: CLAUDE,
    env: { HOME: REAL_HOME, MC_STATUS_DIR: STATUS_DIR },
    ...opts,
  });
  agents.push(a);
  return a;
}

// claude's folder-trust dialog comes up before the composer in a new folder.
// Answer it on the PTY directly (Down → "Yes, I trust this folder", Enter): a
// send() would type the prompt into the dialog and its CR picks "No, exit".
// Then wait for claude's footer, which means the composer is up.
const FOOTER_RX = /for shortcuts|mode on|accept edits|bypass permissions/i;
async function bootToComposer(agent, ms = 30_000) {
  const end = Date.now() + ms;
  let answered = false;
  while (Date.now() < end) {
    if (agent.pty?.pid) track(agent);
    const s = bottomScreen(agent);
    if (/trust this folder/i.test(s)) {
      if (!answered) {
        answered = true;
        agent.pty.write('\x1b[B');
        await sleep(300);
        agent.pty.write('\r');
      }
    } else if (FOOTER_RX.test(s)) {
      return true;
    }
    await sleep(250);
  }
  throw new Error(`composer never came up. Bottom of screen:\n${bottomScreen(agent)}`);
}

// All transcript records of the given session ids (claude may fork a new file
// on resume, so read every *.jsonl in the project folder).
function records(ids) {
  if (!REAL_PROJECT_DIR || !existsSync(REAL_PROJECT_DIR)) return [];
  const out = [];
  for (const f of readdirSync(REAL_PROJECT_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    let text = '';
    try { text = readFileSync(join(REAL_PROJECT_DIR, f), 'utf8'); } catch { continue; }
    const recs = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { recs.push(JSON.parse(line)); } catch {}
    }
    if (recs.some((r) => ids.has(r.sessionId))) out.push(...recs);
  }
  return out;
}

const userText = (r) => {
  const c = r?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
  return '';
};
const assistantText = (r) => (Array.isArray(r?.message?.content)
  ? r.message.content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
  : '');

// Wait for the turn that answers `prompt` to finish, and return its assistant
// text + model. "Finished" = an assistant record with stop_reason end_turn, or
// assistant text that has not grown for 3s.
async function waitForReply(agent, prompt, ms = 90_000) {
  const end = Date.now() + ms;
  let last = '', lastChange = Date.now();
  while (Date.now() < end) {
    try { agent.tailerTick(); } catch {}
    if (agent.pty?.pid) track(agent);
    // Per agent: the shared set would let a case read another case's turn.
    (agent._realSids ??= new Set()).add(agent.sessionId);
    sids.add(agent.sessionId);
    const recs = records(agent._realSids);
    const i = recs.findLastIndex((r) => r.type === 'user' && userText(r).includes(prompt));
    if (i >= 0) {
      const after = recs.slice(i + 1).filter((r) => r.type === 'assistant');
      const text = after.map(assistantText).join(' ').trim();
      const model = after.map((r) => r?.message?.model).filter(Boolean).at(-1) || null;
      const ended = after.some((r) => r?.message?.stop_reason === 'end_turn');
      if (text !== last) { last = text; lastChange = Date.now(); }
      if (text && (ended || Date.now() - lastChange > 3000)) return { text, model };
    }
    await sleep(500);
  }
  throw new Error(`no reply to ${JSON.stringify(prompt)} within ${ms}ms. Last text: ${JSON.stringify(last)}`);
}

async function stop(agent) {
  const pid = agent.pty?.pid;
  agent.kill();
  if (pid) {
    if (!(await waitFor(() => !alive(pid), 5000))) agent.hardKill();
    await waitFor(() => !alive(pid), 3000);
  }
}

// ── (1) the mode line is visible ───────────────────────────────────────────
// No prompt is sent, so the model costs nothing here. auto runs on sonnet:
// claude says "auto mode unavailable for this model" on haiku and falls back to
// manual (seen 2026-10-08, claude 2.1.294).
const MODE_TEXT = {
  acceptEdits: ['accept edits on', MODEL],
  plan: ['plan mode on', MODEL],
  auto: ['auto mode on', SWITCH_TO],
  default: ['manual mode on', MODEL],
};
for (const [mode, [text, model]] of Object.entries(MODE_TEXT)) {
  test(`real claude: mode line shows "${text}" for --permission-mode ${mode}`, { skip: SKIP, timeout: 60_000 }, async () => {
    const a = makeAgent({ permissionMode: mode, model });
    a.start();
    try {
      await bootToComposer(a);
      const seen = await waitFor(() => screen(a).toLowerCase().includes(text), 15_000, 250);
      assert.ok(seen, `"${text}" not on screen within 15s. Bottom of screen:\n${bottomScreen(a)}`);
    } finally {
      await stop(a);
    }
  });
}

// ── (2) resume keeps the conversation ──────────────────────────────────────
test('real claude: resume keeps the conversation', { skip: SKIP, timeout: T_TEST }, async () => {
  const a = makeAgent();
  a.start();
  await bootToComposer(a);
  a.send('Remember the word PINEAPPLE. Reply ok.');
  await waitForReply(a, 'Remember the word PINEAPPLE');
  const sid = a.sessionId;
  await stop(a);

  // What Fleet.resume → launch does: a new agent on the same id, resume:true.
  const b = makeAgent({ sessionId: sid, resume: true });
  b.start();
  try {
    assert.equal(b.resuming, true, 'buildSpawn fell back to --session-id: the transcript was not found');
    await bootToComposer(b);
    b.send('What word? One word.');
    const { text } = await waitForReply(b, 'What word? One word.');
    assert.match(text, /PINEAPPLE/i, `reply after resume: ${JSON.stringify(text)}`);
  } finally {
    await stop(b);
  }
});

// ── (3) :model keeps the conversation ──────────────────────────────────────
test('real claude: changeModel keeps the conversation', { skip: SKIP, timeout: T_TEST }, async () => {
  const a = makeAgent();
  a.start();
  try {
    await bootToComposer(a);
    a.send('Remember the word PINEAPPLE. Reply ok.');
    const first = await waitForReply(a, 'Remember the word PINEAPPLE');
    assert.match(String(first.model), /haiku/i);
    assert.equal(a.changeModel(SWITCH_TO), true);
    assert.equal(a.resuming, true, 'changeModel fell back to --session-id: the transcript was not found');
    await bootToComposer(a);
    a.send('What word? One word.');
    const { text, model } = await waitForReply(a, 'What word? One word.');
    assert.match(String(model), /sonnet/i, `answered by ${model}, not the switched-to model`);
    assert.match(text, /PINEAPPLE/i, `reply after :model: ${JSON.stringify(text)}`);
  } finally {
    await stop(a);
  }
});

// ── (4) pause stops claude ─────────────────────────────────────────────────
// The claude pid itself should pass today. Its children are not stopped:
// pause() signals one pid, not the process group — fixed by 0442.
test('real claude: pause stops claude and its children, resume wakes them', { skip: SKIP, timeout: 60_000 }, async (t) => {
  const a = makeAgent();
  a.start();
  try {
    await bootToComposer(a);
    const pid = a.pty.pid;
    track(a);
    const kids = descendants(pid);
    t.diagnostic(`claude pid ${pid}, children ${JSON.stringify(kids.map((k) => [k, psComm(k)]))}`);
    assert.equal(a.pause(), true);
    await sleep(500);
    const stat = psStat(pid);
    const kidStats = kids.map((k) => [k, psStat(k), psComm(k)]).filter(([, s]) => s);
    assert.equal(a.resume(), true);
    await sleep(500);
    const statAfter = psStat(pid);

    assert.match(stat, /^T/, `paused claude pid ${pid} state is ${JSON.stringify(stat)}, want T`);
    assert.doesNotMatch(statAfter, /^T/, `resumed claude pid ${pid} still ${JSON.stringify(statAfter)}`);
    // 0442: fails today — children keep running while the slot reads "paused".
    const running = kidStats.filter(([, s]) => !s.startsWith('T'));
    assert.deepEqual(running, [], `children not stopped by pause (0442): ${JSON.stringify(running)}`);
  } finally {
    await stop(a);
  }
});

// ── (5) kill leaves no claude ──────────────────────────────────────────────
// `pgrep -f claude` before and after: any pid that matches after the kill and
// did not before is a claude this case left behind. The other claudes on the
// machine (the owner's own sessions) are in both lists and drop out.
function pgrepClaude() {
  try { return new Set(execFileSync('pgrep', ['-f', 'claude'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)); } catch { return new Set(); }
}

test('real claude: kill leaves no claude process or child behind', { skip: SKIP, timeout: 60_000 }, async (t) => {
  const before = pgrepClaude();
  const a = makeAgent();
  a.start();
  await bootToComposer(a);
  await sleep(2000); // let claude start its MCP servers, so there are children to orphan
  const pid = a.pty.pid;
  track(a);
  const kids = descendants(pid);
  t.diagnostic(`claude pid ${pid}, children ${JSON.stringify(kids.map((k) => [k, psComm(k)]))}`);
  a.kill(); // mc's own kill — no hardKill here, that is what is under test
  await sleep(3000);
  const pidAlive = alive(pid);
  // 0441: fails if claude or its children outlive the kill.
  const orphans = kids.filter(alive).map((k) => [k, psStat(k), psComm(k)]);
  const left = [...pgrepClaude()].filter((p) => !before.has(p) && alive(p)).map((p) => [p, psComm(p)]);
  assert.equal(pidAlive, false, `claude pid ${pid} still alive 3s after kill (${psStat(pid)})`);
  assert.deepEqual(orphans, [], `children left behind after kill (0441): ${JSON.stringify(orphans)}`);
  assert.deepEqual(left, [], `new claude processes after kill (0441): ${JSON.stringify(left)}`);
});

// 0441's other path: a restart (:perm / :model) drops the old pty without
// escalating. No prompt is sent, so this costs nothing.
test('real claude: a :perm restart leaves no old claude behind', { skip: SKIP, timeout: 60_000 }, async (t) => {
  const a = makeAgent();
  a.start();
  try {
    await bootToComposer(a);
    await sleep(2000);
    const oldPid = a.pty.pid;
    track(a);
    const oldKids = descendants(oldPid);
    t.diagnostic(`old claude pid ${oldPid}, children ${JSON.stringify(oldKids.map((k) => [k, psComm(k)]))}`);
    assert.equal(a.changePermissionMode('plan'), true);
    track(a);
    await sleep(3000);
    assert.notEqual(a.pty?.pid, oldPid);
    const left = [oldPid, ...oldKids].filter(alive).map((p) => [p, psStat(p), psComm(p)]);
    assert.deepEqual(left, [], `old claude or its children alive 3s after restart (0441): ${JSON.stringify(left)}`);
  } finally {
    await stop(a);
  }
});

// ── mc state stayed in the sandbox ─────────────────────────────────────────
test('real claude: no mc status file landed in the real home', { skip: SKIP }, (t) => {
  const realStatus = join(REAL_HOME, '.local', 'state', 'claude-mc', 'status');
  for (const a of agents) sids.add(a.sessionId);
  t.diagnostic(`session ids: ${[...sids].join(' ')}`);
  const leaked = [...sids].filter((s) => existsSync(join(realStatus, `${s}.ndjson`)));
  assert.deepEqual(leaked, []);
  const inSandbox = [...sids].filter((s) => existsSync(join(STATUS_DIR, `${s}.ndjson`)));
  assert.ok(inSandbox.length > 0, `no hook status files in the sandbox ${STATUS_DIR} — hooks did not reach it`);
});

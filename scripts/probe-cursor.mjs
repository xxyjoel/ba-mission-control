// scripts/probe-cursor.mjs — task 0420 phase-0 spike: drive the interactive
// `cursor-agent` TUI in a PTY and record fixtures (raw PTY bytes, rendered
// screens, transcript + meta.json copies, a step/marker log).
//
// Usage (run from anywhere; sessions always run in the throwaway workspace):
//   node scripts/probe-cursor.mjs create-chat
//   node scripts/probe-cursor.mjs <scenario> [chatId]
//   CURSOR_AGENT_BIN=/path node scripts/probe-cursor.mjs boot
//
// Scenarios: create-chat | boot | turns | keys | resize-signals | term
// Output: $PROBE_OUT (default /tmp/mc-cursor-spike-out/<scenario>.*)
//
// NEVER point this at a real repo. The workspace is $PROBE_WS
// (default /tmp/mc-cursor-spike, must already be a git repo).

import { spawn as ptySpawn } from 'node-pty';
import xterm from '@xterm/headless';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { Terminal } = xterm;
// CURSOR_AGENT_BIN is user-controlled — argv[0] only, never a shell string.
const BIN = process.env.CURSOR_AGENT_BIN || 'cursor-agent';
const WS = process.env.PROBE_WS || '/tmp/mc-cursor-spike';
const OUT = process.env.PROBE_OUT || '/tmp/mc-cursor-spike-out';
const MODEL = process.env.PROBE_MODEL || 'composer-2.5';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args, opts = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  execFile(BIN, args, { cwd: WS, timeout: 30000, ...opts }, (err, stdout, stderr) => {
    resolve({ ms: Date.now() - t0, code: err ? (err.code ?? 1) : 0, stdout, stderr });
  });
});

function transcriptPath(chatId) {
  const root = join(homedir(), '.cursor', 'projects');
  if (!existsSync(root)) return null;
  for (const enc of readdirSync(root)) {
    const p = join(root, enc, 'agent-transcripts', chatId, `${chatId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}
function metaPath(chatId) {
  const chats = join(homedir(), '.cursor', 'chats');
  if (!existsSync(chats)) return null;
  for (const h of readdirSync(chats)) {
    const p = join(chats, h, chatId, 'meta.json');
    if (existsSync(p)) return p;
  }
  return null;
}

class Session {
  constructor(name, args, { cols = 120, rows = 32, env = {} } = {}) {
    this.name = name;
    this.t0 = Date.now();
    this.ptyFile = join(OUT, `${name}.pty.ndjson`);
    this.stepFile = join(OUT, `${name}.steps.ndjson`);
    writeFileSync(this.ptyFile, '');
    writeFileSync(this.stepFile, '');
    this.term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.lastDataAt = Date.now();
    this.bytes = 0;
    this.exited = null;
    this.step('spawn', { bin: BIN, args, cols, rows });
    this.pty = ptySpawn(BIN, args, {
      name: 'xterm-256color', cols, rows, cwd: WS,
      env: { ...process.env, TERM: 'xterm-256color', ...env },
    });
    this.pty.onData((d) => {
      const t = Date.now() - this.t0;
      this.lastDataAt = Date.now();
      this.bytes += Buffer.byteLength(d);
      appendFileSync(this.ptyFile, JSON.stringify({ t, dataB64: Buffer.from(d).toString('base64') }) + '\n');
      this.term.write(d);
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = { exitCode, signal };
      this.step('exit', { exitCode, signal });
    });
  }
  step(ev, extra = {}) {
    appendFileSync(this.stepFile, JSON.stringify({ t: Date.now() - this.t0, ev, ...extra }) + '\n');
    console.log(`[${this.name} +${Date.now() - this.t0}ms] ${ev}`, Object.keys(extra).length ? JSON.stringify(extra).slice(0, 300) : '');
  }
  flush() { return new Promise((r) => this.term.write('', r)); }
  screen() {
    const b = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < this.term.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }
  async snap(label) {
    await this.flush();
    const text = this.screen();
    writeFileSync(join(OUT, `${this.name}.${label}.screen.txt`), text + '\n');
    this.step('snap', { label, bracketedPaste: !!this.term.modes?.bracketedPasteMode, cursorY: this.term.buffer.active.cursorY });
    return text;
  }
  write(data, label) {
    this.step('write', { label: label ?? null, dataB64: Buffer.from(data).toString('base64') });
    this.pty.write(data);
  }
  async type(text) { for (const ch of text) { this.pty.write(ch); await sleep(15); } this.step('typed', { text }); }
  async waitFor(re, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await this.flush();
      if (re.test(this.screen())) { this.step('found', { label }); return true; }
      if (this.exited) break;
      await sleep(150);
    }
    this.step('timeout', { label });
    return false;
  }
  async settle(quietMs = 1500, maxMs = 20000) {
    const end = Date.now() + maxMs;
    while (Date.now() < end && Date.now() - this.lastDataAt < quietMs) await sleep(100);
    await this.flush();
  }
  /** Submit like PtyAgent: bracketed paste (if on) then CR on a separate tick. */
  async submit(text) {
    const bp = !!this.term.modes?.bracketedPasteMode;
    this.write(bp ? `\x1b[200~${text}\x1b[201~` : text, `paste bp=${bp}`);
    await new Promise((r) => setImmediate(r));
    this.write('\r', 'submit-cr');
  }
}

/** Samples transcript size/lines and meta.json updatedAtMs, logging changes. */
function watchChat(sess, chatId) {
  let last = '';
  const iv = setInterval(() => {
    const tp = transcriptPath(chatId);
    const mp = metaPath(chatId);
    let tr = null; let meta = null;
    if (tp) { const s = readFileSync(tp, 'utf8'); tr = { bytes: s.length, lines: s.split('\n').filter(Boolean).length }; }
    if (mp) { try { const m = JSON.parse(readFileSync(mp, 'utf8')); meta = { updatedAtMs: m.updatedAtMs, mtimeMs: Math.round(statSync(mp).mtimeMs) }; } catch {} }
    const key = JSON.stringify({ tr, meta });
    if (key !== last) { last = key; sess.step('chat-state', { tr, meta, tp, mp }); }
  }, 200);
  return () => clearInterval(iv);
}

function copyChatFiles(name, chatId) {
  const tp = transcriptPath(chatId);
  const mp = metaPath(chatId);
  if (tp) copyFileSync(tp, join(OUT, `${name}.transcript.jsonl`));
  if (mp) copyFileSync(mp, join(OUT, `${name}.meta.json`));
  console.log(`[copy] transcript=${tp} meta=${mp}`);
}

async function createChat() {
  const r = await run(['create-chat']);
  const id = r.stdout.trim().split(/\s+/).pop();
  console.log(`[create-chat] ${r.ms}ms code=${r.code} id=${id} stderr=${r.stderr.trim().slice(0, 200)}`);
  return { id, ...r };
}

const TRUST_RE = /trust/i;
const READY_RE = /(Plan, search, build anything|→ Add a follow-up|Add a follow-up)/;

async function bootTo(sess) {
  const got = await sess.waitFor(new RegExp(`${READY_RE.source}|${TRUST_RE.source}`, 'i'), 30000, 'first-screen');
  await sess.settle(1200, 8000);
  let screen = await sess.snap('first-screen');
  if (got && TRUST_RE.test(screen) && !READY_RE.test(screen)) {
    await sess.snap('trust-prompt');
    return 'trust';
  }
  return got ? 'ready' : 'unknown';
}

const scenarios = {
  async 'create-chat'() {
    const a = await createChat();
    const b = await createChat();
    // Offline: point the API endpoint at a closed local port.
    const off = await run(['create-chat'], { env: { ...process.env, CURSOR_API_ENDPOINT: 'https://127.0.0.1:9' } });
    const res = { online: [a, b].map(({ id, ms, code }) => ({ id, ms, code })), offline: { ms: off.ms, code: off.code, stdout: off.stdout.trim(), stderr: off.stderr.trim().slice(0, 400) } };
    res.transcriptAfterCreate = transcriptPath(a.id);
    res.metaAfterCreate = metaPath(a.id);
    writeFileSync(join(OUT, 'create-chat.json'), JSON.stringify(res, null, 2) + '\n');
    console.log(JSON.stringify(res, null, 2));
  },

  /** Exploratory: fresh chat, first run in the workspace, dump screens, exit. */
  async boot(chatId) {
    chatId ||= (await createChat()).id;
    const sess = new Session('boot', ['--resume', chatId, '--model', MODEL, '--workspace', WS], { env: { MC_SLOT_TOKEN: 'spike123' } });
    const stop = watchChat(sess, chatId);
    const state = await bootTo(sess);
    sess.step('boot-state', { state, chatId });
    await sleep(3000);
    await sess.snap('after-3s');
    stop();
    sess.pty.kill('SIGTERM');
    await sleep(1500);
    copyChatFiles('boot', chatId);
  },
};

/**
 * Manual exploration: `drive <name> <chatId> [extra cursor-agent args...]`.
 * Append JSON lines to $OUT/<name>.ctl, one op each:
 *   {op:'write', data} {op:'submit', text} {op:'snap', label}
 *   {op:'resize', cols, rows} {op:'signal', sig} {op:'type', text} {op:'quit'}
 * Escapes in `data` use JSON (\u0011 for Ctrl+Q, \u001b[Z for Shift+Tab).
 */
scenarios.drive = async function drive(name, chatId, ...extra) {
  const ctl = join(OUT, `${name}.ctl`);
  writeFileSync(ctl, '');
  // chatId '-' = plain launch without --resume (lets the CLI mint its own chat).
  const resume = chatId === '-' ? [] : ['--resume', chatId];
  const sess = new Session(name, [...resume, '--model', MODEL, '--workspace', WS, ...extra], { env: { MC_SLOT_TOKEN: 'spike123' } });
  const stop = chatId === '-' ? () => {} : watchChat(sess, chatId);
  let done = 0;
  const live = setInterval(() => { writeFileSync(join(OUT, `${name}.live.txt`), `${Date.now() - sess.t0}ms quietFor=${Date.now() - sess.lastDataAt}ms bp=${!!sess.term.modes?.bracketedPasteMode}\n${sess.screen()}\n`); }, 300);
  while (!sess.exited) {
    const lines = readFileSync(ctl, 'utf8').split('\n').filter(Boolean);
    for (; done < lines.length; done++) {
      let c;
      try { c = JSON.parse(lines[done]); } catch (e) { sess.step('ctl-parse-error', { line: lines[done], error: e.message }); continue; }
      sess.step('ctl', { op: c.op, label: c.label ?? null });
      if (c.op === 'write') sess.write(c.data, c.label);
      else if (c.op === 'type') await sess.type(c.text);
      else if (c.op === 'submit') await sess.submit(c.text);
      else if (c.op === 'snap') await sess.snap(c.label);
      else if (c.op === 'resize') { sess.pty.resize(c.cols, c.rows); sess.term.resize(c.cols, c.rows); sess.step('resize', { cols: c.cols, rows: c.rows, bytesBefore: sess.bytes }); }
      else if (c.op === 'signal') { process.kill(sess.pty.pid, c.sig); sess.step('signal', { sig: c.sig }); }
      else if (c.op === 'quit') sess.pty.kill('SIGTERM');
    }
    await sleep(100);
  }
  stop();
  clearInterval(live);
  await sess.snap('final');
  if (chatId !== '-') copyChatFiles(name, chatId);
};

/** Replace every string leaf with a type tag, keep numbers/bools as types. */
function shapeOf(v) {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]));
  return v === null ? 'null' : typeof v;
}
const REDACT_KEYS = /email|userid|user_id|owningUser|owningTeam|teamId|authId|requestId|id$/i;
function redact(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  if (typeof v === 'string' && /@/.test(v)) return 'user@example.com';
  if (REDACT_KEYS.test(key) && (typeof v === 'string' || typeof v === 'number')) return typeof v === 'number' ? 0 : `<${key}>`;
  return v;
}

/**
 * Dashboard usage feed (plan Q11-13). The access token is read with the same
 * argv the CLI itself uses (`/usr/bin/security find-generic-password`), whose
 * keychain ACL trusts /usr/bin/security with don't-require-password — no GUI
 * prompt. The token is held in memory only; never printed or written.
 */
scenarios.usage = async function usage(minutes = '30', startMs = '', endMs = '', pages = '1') {
  // PROBE_CHAT_IDS: comma-separated chat ids to classify events against
  // (recorded as a label only; raw ids are redacted from the fixture).
  const known = (process.env.PROBE_CHAT_IDS || '').split(',').filter(Boolean);
  const token = await new Promise((resolve) => execFile('/usr/bin/security',
    ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w'],
    { timeout: 5000 }, (err, out) => resolve(err ? null : out.trim())));
  if (!token) { console.log('[usage] token not readable non-interactively'); return; }
  let sub = null;
  try { sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; } catch {}
  const st = JSON.parse((await run(['status', '--format', 'json'])).stdout);
  const subTail = typeof sub === 'string' ? sub.split('|').pop() : null;
  console.log(`[usage] jwt sub shape=${sub ? sub.replace(/[A-Za-z0-9]/g, 'x') : null} status.userId type=${typeof st.userInfo?.userId}`);
  const end = endMs ? Number(endMs) : Date.now();
  const start = startMs ? Number(startMs) : end - Number(minutes) * 60000;
  const body = { teamId: 0, startDate: String(start), endDate: String(end), page: 1, pageSize: 20 };
  const attempts = [];
  for (const [label, uid] of [['jwt-sub-tail', subTail], ['status-userId', st.userInfo?.userId]]) {
    if (uid == null) continue;
    const res = await fetch('https://cursor.com/api/dashboard/get-filtered-usage-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://cursor.com', Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${uid}::${token}`)}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    attempts.push({ label, status: res.status });
    console.log(`[usage] ${label}: HTTP ${res.status} ${text.length}B`);
    if (!res.ok) continue;
    const json = JSON.parse(text);
    const events = [...(json.usageEventsDisplay ?? [])];
    for (let pg = 2; pg <= Number(pages) && events.length < json.totalUsageEventsCount; pg++) {
      const r2 = await fetch('https://cursor.com/api/dashboard/get-filtered-usage-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cursor.com', Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${uid}::${token}`)}` },
        body: JSON.stringify({ ...body, page: pg }),
      });
      if (!r2.ok) break;
      events.push(...((await r2.json()).usageEventsDisplay ?? []));
    }
    const conv = (e) => { const i = known.indexOf(e.conversationId); return i >= 0 ? `probe-chat-${i}` : (e.conversationId ? 'other' : 'none'); };
    writeFileSync(join(OUT, 'usage-events.sample.json'), JSON.stringify({
      _note: 'Redacted. Shape of POST /api/dashboard/get-filtered-usage-events (cookie built from CLI keychain token).',
      request: body, cookieUserIdForm: label, attempts,
      responseShape: shapeOf(json),
      topLevelKeys: Object.keys(json),
      totalUsageEventsCount: json.totalUsageEventsCount,
      eventTimestamps: events.map((e) => ({ conversation: conv(e), timestamp: e.timestamp, model: e.model, kind: e.kind, tokenUsage: e.tokenUsage ?? null, isHeadless: e.isHeadless, requestsCosts: e.requestsCosts, usageBasedCosts: e.usageBasedCosts })),
      sampleEvents: redact([...events.filter((e) => conv(e).startsWith('probe-chat')).slice(0, 2), ...events.filter((e) => conv(e) === 'other').slice(0, 1)]),
    }, null, 2) + '\n');
    return;
  }
  writeFileSync(join(OUT, 'usage-events.sample.json'), JSON.stringify({ attempts }, null, 2) + '\n');
};

const [name, ...rest] = process.argv.slice(2);
if (!scenarios[name]) { console.error(`unknown scenario: ${name}; have ${Object.keys(scenarios).join(', ')}`); process.exit(2); }
if (!existsSync(join(WS, '.git'))) { console.error(`workspace ${WS} must be a git repo (throwaway)`); process.exit(2); }
console.log(`[probe-cursor] ws=${WS} out=${OUT} md5(ws)=${createHash('md5').update(WS).digest('hex')}`);
await scenarios[name](...rest);
process.exit(0);

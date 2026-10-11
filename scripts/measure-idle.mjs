#!/usr/bin/env node
// scripts/measure-idle.mjs — reproducible idle-energy measurement for mc.
//
// Boots mc in a sandboxed pty (fresh HOME and XDG_STATE_HOME, a stub
// CLAUDE_BIN), optionally with N idle resumed agents, waits for boot noise to
// settle, then measures an idle window.
//
// 0466: the sandbox is HOME, not MC_CONFIG_DIR. MC_CONFIG_DIR makes
// isSandboxed() true, and that turns the `claude agents` poll off
// (fleet.mjs), so the old setup could never see the poll it was meant to
// count. The config dir is the default ~/.config/claude-mc under the sandbox
// HOME; settings.json turns syncModelsOnBoot off so boot makes no model probe.
//
// 0466: the old version read only mc's own cputime, so it missed every child
// process mc forks: the `claude agents --json` poll (fleet.mjs), `ps`
// (procStats.mjs) and `git`. It now counts the whole process tree:
//   total = mc self + reaped children of mc (the short-lived forks)
//         + live descendants (the stub claudes),
// as a delta between the start and the end of the window. The child time comes
// from proc_pid_rusage's ri_child_user/system_time (macOS, via python3 ctypes)
// or /proc/<pid>/stat cutime/cstime (Linux). Reaped time only appears once the
// fork has exited and mc has waited on it, which is why live descendants are
// read separately.
//
// The stub claude answers `--version`, `auth` and `rm` at once and idles for
// a session launch. For `agents` it runs the REAL claude (found on PATH, or
// MC_MEASURE_REAL_CLAUDE) under the sandboxed HOME, so the poll costs what the
// real ~140 MB binary costs, not what a shell `echo` costs. With no real
// claude it prints `[]` and the report says so.
//
// Usage (from the repo root):
//   node scripts/measure-idle.mjs [--agents N] [--subfiles M] [--window S] [--keep]
//     --agents N    resumed idle slots, each with a settled transcript (default 0)
//     --subfiles M  settled sub-agent files per slot (default 0; the review used 137)
//     --window S    idle window in seconds (default 240: two 120 s agents polls)
//     --keep        keep the sandbox dir instead of deleting it
//
// Baselines on the maintainer's machine (Apple Silicon):
//   pre  idle-energy batch (0377–0381): 1.07% of one core, ~216 B/s pty output
//   2026-10-08 review (mc self only, 40 s window): 0.37% of a core, 948 chars/s
//   0466: see tasks/0466 Result for the whole-tree before/after table.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, accessSync, constants as FS } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const pty = createRequire(join(REPO, 'package.json'))('node-pty');

// ── args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : def;
};
const N = Math.max(0, Math.min(64, opt('agents', 0) | 0));
const SUBFILES = Math.max(0, opt('subfiles', 0) | 0);
const WINDOW_S = Math.max(5, opt('window', 240));
const KEEP = argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── sandbox ──────────────────────────────────────────────────────────────
const box = mkdtempSync(join(tmpdir(), 'mc-energy-'));
const HOME = join(box, 'home');
const CFG = join(HOME, '.config', 'claude-mc');
const WORK = join(box, 'work');
for (const d of [CFG, WORK, join(box, 'bin')]) mkdirSync(d, { recursive: true });

// 0466: the real claude, for the `agents` poll only. Never this script's stub.
function findRealClaude() {
  const env = process.env.MC_MEASURE_REAL_CLAUDE;
  if (env) return env;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, 'claude');
    try { accessSync(p, FS.X_OK); return p; } catch {}
  }
  return null;
}
const REAL_CLAUDE = findRealClaude();
const AGENTS_LOG = join(box, 'agents-calls.log');
// A unique sleep length marks this run's idle stub claudes in `ps`.
const IDLE_SECS = String(800000 + Math.floor(Math.random() * 99999));
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // sh single-quote for the stub's fixed paths
const STUB = join(box, 'bin', 'claude');
writeFileSync(STUB, `#!/bin/sh
# 0466: stub claude for scripts/measure-idle.mjs
case "$1" in
  --version) echo "2.0.0 (Claude Code)"; exit 0;;
  auth|rm) exit 0;;
  agents)
    echo call >> ${q(AGENTS_LOG)}
    ${REAL_CLAUDE ? `exec ${q(REAL_CLAUDE)} "$@"` : 'echo "[]"; exit 0'};;
esac
printf 'stub claude ready\\r\\n> '
exec sleep ${IDLE_SECS}
`);
chmodSync(STUB, 0o755);

// ── seed N resumed slots ─────────────────────────────────────────────────
// 0466: same layout as the review's fleet harness (MODE=resumed): a settled
// transcript and an empty hook status file per session, distinct cwds
// (pruneSessions dedupes records by cwd), all marked live so auto-resume
// restores them. Sub-agent files settle 30 s after mc first sees them.
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9-]/g, '-'); // = sessionFileTailer.mjs
const settings = { syncModelsOnBoot: false };
if (N > 0) {
  const now = Date.now();
  const iso = new Date(now - 3600_000).toISOString();
  const bySlot = {};
  for (let i = 1; i <= N; i++) {
    const cwd = join(WORK, `slot${i}`);
    mkdirSync(cwd, { recursive: true });
    try { execFileSync('git', ['init', '-q', cwd], { stdio: 'ignore' }); } catch {}
    const sid = randomUUID();
    const pd = join(HOME, '.claude', 'projects', encodeCwd(cwd));
    mkdirSync(pd, { recursive: true });
    writeFileSync(join(pd, `${sid}.jsonl`), [
      { type: 'user', timestamp: iso, message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: iso, message: { role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'system', subtype: 'turn_duration', timestamp: iso, durationMs: 10 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const sd = join(HOME, '.local', 'state', 'claude-mc', 'status');
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, `${sid}.ndjson`), '');
    if (SUBFILES) {
      const sub = join(pd, sid, 'subagents');
      mkdirSync(sub, { recursive: true });
      const line = JSON.stringify({ type: 'assistant', timestamp: iso, message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n';
      for (let j = 0; j < SUBFILES; j++) writeFileSync(join(sub, `agent-${j}.jsonl`), line);
    }
    bySlot[i] = { sessionId: sid, cwd, branch: 'main', model: 'sonnet', name: `slot${i}`, live: true, lastSeen: now };
  }
  Object.assign(settings, { maxSlots: N, autoResumeOnStart: true });
  writeFileSync(join(CFG, 'sessions.json'), JSON.stringify({ version: 2, savedAt: now, bySlot, history: [], openSlots: [] }, null, 2));
}
writeFileSync(join(CFG, 'settings.json'), JSON.stringify(settings, null, 2));

// ── process-tree accounting ──────────────────────────────────────────────
// S7 (0408): argv-form ps / python3, never a shell string with interpolation.
function psTable() {
  const rows = new Map();
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.set(+m[1], { pid: +m[1], ppid: +m[2], rssKB: +m[3], cmd: m[4] });
  }
  return rows;
}
function descendants(rootPid, rows) {
  const kids = new Map();
  for (const r of rows.values()) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const out = [];
  const stack = [...(kids.get(rootPid) || [])];
  while (stack.length) { const r = stack.pop(); out.push(r); stack.push(...(kids.get(r.pid) || [])); }
  return out;
}

// proc_pid_rusage(RUSAGE_INFO_V2): u64 fields after the 16-byte uuid —
// 0 user, 1 system, 2 pkg_idle_wkups, 3 interrupt_wkups, 6 resident_size,
// 10 child_user, 11 child_system, 12 child_pkg_idle_wkups, 13 child_interrupt_wkups.
// Times are mach ticks; the timebase converts them to seconds.
const RUSAGE_PY = `
import ctypes, sys, json
lib = ctypes.CDLL('/usr/lib/libproc.dylib')
class TB(ctypes.Structure): _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]
tb = TB(); ctypes.CDLL('/usr/lib/libSystem.dylib').mach_timebase_info(ctypes.byref(tb))
s = lambda v: v * tb.numer / tb.denom / 1e9
out = {}
for pid in sys.argv[1:]:
    b = (ctypes.c_uint64 * 40)()
    if lib.proc_pid_rusage(int(pid), 2, b) != 0: continue
    f = lambda i: b[2 + i]
    out[pid] = {'self': s(f(0)) + s(f(1)), 'child': s(f(10)) + s(f(11)),
                'wk': f(2) + f(3), 'cwk': f(12) + f(13), 'rss': f(6)}
print(json.dumps(out))
`;
function rusage(pids) {
  if (!pids.length) return {};
  if (process.platform === 'darwin') {
    try {
      return JSON.parse(execFileSync('python3', ['-I', '-c', RUSAGE_PY, ...pids.map(String)], { encoding: 'utf8', timeout: 10_000 }));
    } catch { return null; }
  }
  // Linux: /proc/<pid>/stat fields 14–17 are utime, stime, cutime, cstime (ticks).
  const out = {};
  for (const pid of pids) {
    try {
      const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      const t = (i) => Number(f[i - 3]) / 100;
      out[pid] = { self: t(14) + t(15), child: t(16) + t(17), wk: NaN, cwk: NaN, rss: Number(f[24 - 3]) * 4096 };
    } catch {}
  }
  return out;
}
function agentsCalls() {
  try { return readFileSync(AGENTS_LOG, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}
function sampleTree(rootPid) {
  const rows = psTable();
  const desc = descendants(rootPid, rows);
  const ru = rusage([rootPid, ...desc.map((d) => d.pid)]);
  const mc = ru?.[rootPid];
  let liveCpu = 0, liveRssKB = 0;
  for (const d of desc) { liveRssKB += d.rssKB; if (ru?.[d.pid]) liveCpu += ru[d.pid].self + ru[d.pid].child; }
  return {
    at: Date.now(), ok: !!mc,
    self: mc?.self ?? NaN, child: mc?.child ?? NaN, wk: mc ? mc.wk + mc.cwk : NaN,
    live: liveCpu, mcRssKB: rows.get(rootPid)?.rssKB ?? NaN, liveRssKB,
    idle: desc.filter((d) => d.cmd === `sleep ${IDLE_SECS}`).map((d) => d.pid),
    descPids: desc.map((d) => d.pid), calls: agentsCalls(),
  };
}

// ── run ──────────────────────────────────────────────────────────────────
const env = { ...process.env, HOME, XDG_STATE_HOME: join(HOME, '.local', 'state'), CLAUDE_BIN: STUB, MC_NO_TRANSCRIPT: '1' };
delete env.NODE_ENV; // bin/mc.mjs defaults it to production, as for a user
for (const k of ['MC_CONFIG_DIR', 'MC_STATUS_DIR', 'MC_MOCK', 'NODE_TEST_CONTEXT']) delete env[k];
const child = pty.spawn(process.execPath, [join(REPO, 'bin', 'mc.mjs')], {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: REPO, env,
});
// 0466: bytes, not UTF-16 units — card borders are 3-byte box characters.
let ptyBytes = 0, ptyChars = 0, exited = false;
child.onData((d) => { ptyBytes += Buffer.byteLength(d); ptyChars += d.length; });
child.onExit(() => { exited = true; });

let lastSeen = [];
async function finish(code) {
  try { child.kill(); } catch {}
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  await sleep(500);
  // Stub claudes this run started that outlived mc (they should not).
  let stray = 0;
  try {
    const rows = psTable();
    for (const pid of lastSeen) {
      if (rows.get(pid)?.cmd === `sleep ${IDLE_SECS}`) { stray++; try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  } catch {}
  if (stray) console.log(`[measure] WARN: ${stray} stub claude(s) outlived mc; killed`);
  if (!KEEP) { try { rmSync(box, { recursive: true, force: true }); } catch {} }
  process.exit(code);
}

// mc's pid is the node running bin/mc.mjs (tsx registers in-process; no wrapper).
await sleep(1000);
const head = psTable().get(child.pid);
if (!head || !head.cmd.includes('mc.mjs')) {
  console.log(`[measure] ABORT: pid ${child.pid} is not mc (${head?.cmd ?? 'gone'})`);
  await finish(2);
}

// Warmup: boot noise (auth probe, model sync), then every slot alive, then the
// tailers' fast creation window (10 s) and sub-agent settle time (30 s).
await sleep(10_000);
if (N > 0) {
  const deadline = Date.now() + 120_000;
  let s;
  while (Date.now() < deadline) {
    s = sampleTree(child.pid);
    if (s.idle.length >= N) break;
    await sleep(1000);
  }
  if (s.idle.length !== N) {
    console.log(`[measure] ABORT: expected ${N} idle stub claudes, found ${s.idle.length}`);
    await finish(2);
  }
  await sleep(40_000);
}

const s0 = sampleTree(child.pid);
if (N > 0 && s0.idle.length !== N) {
  console.log(`[measure] ABORT: ${s0.idle.length}/${N} stub claudes alive at window start`);
  await finish(2);
}
lastSeen = s0.descPids;
ptyBytes = 0; ptyChars = 0;
await sleep(WINDOW_S * 1000);
const s1 = sampleTree(child.pid);
lastSeen = [...new Set([...lastSeen, ...s1.descPids])];
const wallS = (s1.at - s0.at) / 1000;

const pct = (dt) => (Number.isFinite(dt) ? +((dt / wallS) * 100).toFixed(3) : null);
const r = {
  repo: REPO, agents: N, subfiles: SUBFILES, windowS: +wallS.toFixed(1),
  realClaudeForAgentsPoll: REAL_CLAUDE || null,
  cpuPct: {
    mcSelf: pct(s1.self - s0.self),
    forks: pct(s1.child - s0.child),
    liveDescendants: pct(s1.live - s0.live),
    total: pct((s1.self + s1.child + s1.live) - (s0.self + s0.child + s0.live)),
  },
  agentsForks: s1.calls - s0.calls,
  ptyBytesPerS: +(ptyBytes / wallS).toFixed(1),
  ptyCharsPerS: +(ptyChars / wallS).toFixed(1),
  mcWakeupsPerS: Number.isFinite(s1.wk - s0.wk) ? +((s1.wk - s0.wk) / wallS).toFixed(1) : null,
  mcRssMB: +(s1.mcRssKB / 1024).toFixed(1),
  descendantsRssMB: +(s1.liveRssKB / 1024).toFixed(1),
  idleStubs: s1.idle.length,
};
const f = (x, u = '') => (x === null ? 'n/a' : `${x}${u}`);
console.log(`\n[measure] repo=${REPO} pid=${child.pid} sandbox=${box}${KEEP ? '' : ' (deleted)'}`);
console.log(`[measure] ${N} idle agents${SUBFILES ? ` x ${SUBFILES} settled sub-agent files` : ''}, ${wallS.toFixed(1)}s window; agents poll runs ${REAL_CLAUDE ? `real ${REAL_CLAUDE}` : 'a stub echo (no real claude found)'}`);
console.log(`[measure] cpu % of one core: total ${f(r.cpuPct.total)} = mc ${f(r.cpuPct.mcSelf)} + forks ${f(r.cpuPct.forks)} + live children ${f(r.cpuPct.liveDescendants)}`);
console.log(`[measure] claude agents forks in window: ${r.agentsForks}`);
console.log(`[measure] terminal output: ${r.ptyBytesPerS} B/s (${r.ptyCharsPerS} chars/s)`);
console.log(`[measure] mc wakeups: ${f(r.mcWakeupsPerS, '/s')}; RSS mc ${r.mcRssMB} MB, children ${r.descendantsRssMB} MB`);
if (!s1.ok) console.log('[measure] note: rusage unavailable (python3/libproc); forks are not counted');
console.log(`[measure-json] ${JSON.stringify(r)}`);
await finish(0);

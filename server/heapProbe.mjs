// server/heapProbe.mjs — opt-in memory instrumentation for the long-uptime OOM
// (issue #18). Pure JS, zero deps. Designed to be inert in normal use: only the
// on-demand SIGUSR2 snapshot is always armed (harmless), and periodic logging
// turns on solely with MC_HEAP_LOG set. Every fleet access is guarded so the
// probe can NEVER crash the app it is measuring.
//
// Usage:
//   MC_HEAP_LOG=1 mc        # logs rss/heap + per-structure counts every 60s
//   kill -USR2 <mc pid>     # writes a heap snapshot right now (any run)
//   NODE_OPTIONS='--heapsnapshot-near-heap-limit=2' mc   # auto-snapshot at the ceiling
//
// Output dir: ~/.local/state/claude-mc/heap/  (XDG_STATE_HOME honored)
import { writeHeapSnapshot, getHeapStatistics } from 'node:v8';
import { appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(
  process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'claude-mc', 'heap',
);

// 0700 dir: a heap snapshot is a dump of every live JS string (auth tokens,
// session content, env), so keep the whole heap dir owner-only.
function ensureDir() {
  // mode: on mkdir only applies at creation; chmod enforces 0700 on a pre-existing dir too.
  try { mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); } catch {}
  try { chmodSync(STATE_DIR, 0o700); } catch {}
}

// Sum a per-agent numeric probe across the live fleet. Every access is wrapped
// so a shape change (or a half-torn-down agent) can never throw into the timer.
export function fleetCounts(fleet) {
  let agents = 0, termLines = 0, pendingSub = 0, usageByMsg = 0, tail = 0;
  try {
    for (const a of fleet?.agents || []) {
      if (!a) continue;
      agents++;
      try { termLines  += a.term?.buffer?.active?.length || 0; } catch {}
      try { pendingSub += a.pendingSubagents?.size || 0; } catch {}
      try { usageByMsg += a._usageByMsg?.size || 0; } catch {}
      try { tail       += a.tail?.length || 0; } catch {}
    }
  } catch {}
  return { agents, termLines, pendingSub, usageByMsg, tail };
}

// Write a full v8 heap snapshot to the state dir. Returns the path (or null on
// failure). Safe to call at any time; the file can be opened in Chrome DevTools
// → Memory → Load to see the retained object graph.
export function dumpHeapSnapshot(tag = 'manual') {
  ensureDir();
  const p = join(STATE_DIR, `mc-${tag}-${process.pid}-${Date.now()}.heapsnapshot`);
  // writeHeapSnapshot has no mode arg — tighten to owner-only after write so the
  // secrets-at-rest snapshot isn't world-readable.
  try { writeHeapSnapshot(p); try { chmodSync(p, 0o600); } catch {} return p; } catch { return null; }
}

// Build one compact log record from the current process + fleet state. Pure so
// the test can assert its shape without a filesystem.
export function heapSample(fleet, t0 = 0) {
  const m = process.memoryUsage();
  const mb = (n) => +(n / 1e6).toFixed(1);
  return {
    t: Date.now(),
    upMin: t0 ? Math.round((Date.now() - t0) / 60000) : 0,
    rssMB: mb(m.rss), heapMB: mb(m.heapUsed), heapTotalMB: mb(m.heapTotal),
    extMB: mb(m.external), abMB: mb(m.arrayBuffers),
    ...fleetCounts(fleet),
  };
}

// startHeapProbe — arm the on-demand SIGUSR2 snapshot (always) and, when
// MC_HEAP_LOG is set, append a memory+counts NDJSON line every intervalMs.
// Returns a stop() fn. The interval is unref'd so it never keeps mc alive.
export function startHeapProbe(fleet, { intervalMs = 60_000, env = process.env, watchdogMs = 30_000, watchdogFrac = 0.72 } = {}) {
  try {
    process.on('SIGUSR2', () => {
      const p = dumpHeapSnapshot('sigusr2');
      if (p) { try { process.stderr.write(`\n[mc-heap] snapshot → ${p}\n`); } catch {} }
    });
  } catch {}

  // Watchdog (ALWAYS on, not gated on MC_HEAP_LOG): the long-uptime OOM (#18) is
  // slow and unroot-caused, so auto-capture ONE heap snapshot the first time
  // heapUsed crosses watchdogFrac of the V8 old-space limit — well before the
  // hard OOM, while a snapshot can still be written. That turns a blind crash
  // into a self-diagnosis (the retainer is named in the snapshot). Non-disruptive:
  // writes to the probe dir + debug log only, never the TUI/stdout. Fires once.
  let heapLimit = 0;
  try { heapLimit = getHeapStatistics().heap_size_limit || 0; } catch {}
  const threshold = heapLimit ? heapLimit * watchdogFrac : Infinity;
  let captured = false;
  const watchTimer = setInterval(() => {
    try {
      if (captured) return;
      if (process.memoryUsage().heapUsed >= threshold) {
        captured = true;
        const p = dumpHeapSnapshot('watchdog');
        try {
          appendFileSync(join(STATE_DIR, 'watchdog.log'),
            JSON.stringify({ t: Date.now(), heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1e6), limitMB: Math.round(heapLimit / 1e6), snapshot: p }) + '\n');
        } catch {}
      }
    } catch {}
  }, watchdogMs);
  try { watchTimer.unref?.(); } catch {}

  if (!env.MC_HEAP_LOG) return () => { try { clearInterval(watchTimer); } catch {} };

  ensureDir();
  const logPath = join(STATE_DIR, `mc-heap-${process.pid}.ndjson`);
  const t0 = Date.now();
  const tick = () => {
    try { appendFileSync(logPath, JSON.stringify(heapSample(fleet, t0)) + '\n'); } catch {}
  };
  tick(); // baseline immediately
  const timer = setInterval(tick, intervalMs);
  try { timer.unref?.(); } catch {}
  return () => { try { clearInterval(timer); } catch {} try { clearInterval(watchTimer); } catch {} };
}

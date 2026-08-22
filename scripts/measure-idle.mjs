#!/usr/bin/env node
// scripts/measure-idle.mjs — reproducible idle-energy measurement for mc.
//
// Boots mc in a sandboxed pty (fresh MC_CONFIG_DIR, empty fleet, no agents),
// waits 10s for boot noise (auth probe, model sync) to settle, then measures
// cumulative CPU time over a 40s idle window. The cputime slope is the honest
// number — instantaneous ps %cpu samples are shown for texture only.
//
// Usage: node scripts/measure-idle.mjs   (from the repo root)
//
// Baselines on the maintainer's machine (Apple Silicon, 2026-08):
//   pre  idle-energy batch (0377–0381): 1.07% of one core, ~216 B/s pty output
//   post — see tasks/0376 Result for the recorded number.
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const pty = createRequire(join(REPO, 'package.json'))('node-pty');
const cfg = mkdtempSync(join(tmpdir(), 'mc-energy-'));

const child = pty.spawn(process.execPath, [join(REPO, 'bin', 'mc.mjs')], {
  name: 'xterm-256color', cols: 120, rows: 40,
  cwd: REPO,
  env: { ...process.env, MC_CONFIG_DIR: cfg, MC_NO_TRANSCRIPT: '1' },
});
let ptyBytes = 0;
child.onData((d) => { ptyBytes += d.length; });

const cpuPct = (pid) => {
  try { return parseFloat(execSync(`ps -o %cpu= -p ${pid}`, { encoding: 'utf8' }).trim()); }
  catch { return NaN; }
};
const cpuTimeS = (pid) => {
  try {
    const t = execSync(`ps -o cputime= -p ${pid}`, { encoding: 'utf8' }).trim(); // mm:ss.cc
    const [m, s] = t.split(':');
    return parseFloat(m) * 60 + parseFloat(s);
  } catch { return NaN; }
};

await new Promise((r) => setTimeout(r, 10_000)); // warmup
const t0 = Date.now();
const c0 = cpuTimeS(child.pid);
ptyBytes = 0;
const samples = [];
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  samples.push(cpuPct(child.pid));
}
const wallS = (Date.now() - t0) / 1000;
const c1 = cpuTimeS(child.pid);
console.log(`\n[measure] pid=${child.pid} sandbox=${cfg}`);
console.log(`[measure] %cpu samples: ${samples.map((x) => x.toFixed(1)).join(' ')}`);
console.log(`[measure] cputime slope: ${(c1 - c0).toFixed(2)}s cpu over ${wallS.toFixed(1)}s wall = ${(((c1 - c0) / wallS) * 100).toFixed(2)}% of one core (idle, 0 agents)`);
console.log(`[measure] pty bytes emitted during idle window: ${ptyBytes} (${(ptyBytes / wallS).toFixed(0)} B/s)`);

child.kill();
process.exit(0);

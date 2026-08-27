// server/procStats.mjs — per-agent subprocess CPU% + RSS sampling.
//
// One `ps` invocation covers EVERY live agent pid (argv-form execFile — no
// shell, no interpolation; pids are numbers we minted from node-pty). Output
// format `pid=,pcpu=,rss=` is identical on macOS and Linux: rss in KiB,
// pcpu as ps's decaying average of one core.
//
// Driven from Fleet's shared tailer tick (0381) on a divided cadence — the
// fork cost of `ps` is real, so we sample at half the tailer rate (3s active
// / 6s idle fleet-wide) rather than adding an independent timer/wakeup.

import { execFile } from 'node:child_process';

// parsePsOutput — pure. `ps -o pid=,pcpu=,rss=` rows → Map(pid → stats).
// Tolerates ragged whitespace and skips malformed rows; a pid that exited
// between listing and sampling simply doesn't appear.
export function parsePsOutput(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().split(/\s+/);
    if (m.length !== 3) continue;
    const pid = Number(m[0]), cpu = Number(m[1]), rssKb = Number(m[2]);
    if (!Number.isInteger(pid) || !Number.isFinite(cpu) || !Number.isFinite(rssKb)) continue;
    out.set(pid, { cpu, rssKb });
  }
  return out;
}

/**
 * samplePids(pids) — resolve to Map(pid → { cpu, rssKb }). Resolves to an
 * empty Map on any failure (ps missing, all pids gone — `ps -p` exits 1
 * when no pid matches, which is data, not an error worth surfacing).
 */
export function samplePids(pids) {
  const list = (pids || []).filter((p) => Number.isInteger(p) && p > 0);
  if (!list.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,pcpu=,rss=', '-p', list.join(',')],
      { timeout: 4000 }, (err, stdout) => {
        resolve(parsePsOutput(stdout)); // partial stdout is still usable on err
      });
  });
}

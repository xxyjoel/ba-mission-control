// tui/lib/installWatch.js — notice a new CLI install without polling (0428).
//
// mc used to spawn `claude --version` every 60 s to catch an upgrade. That
// timer woke the machine every minute for an event that happens a few times a
// month. An install always changes something on disk, so watch that instead:
//
//   - the folder holding the `claude` found on PATH — `claude install` and
//     Homebrew repoint the link there (~/.local/bin/claude → versions/X);
//   - the folder holding the link's real target — `npm i -g` rewrites the
//     package in place and leaves the link alone.
//
// fs.watch is event-driven (FSEvents on macOS, inotify on Linux): no work at
// all until the folder changes. After each change the watch re-arms, because
// an install can delete the old target's folder.
//
// Not caught: a NEW claude appearing earlier on PATH than the one watched.
// Boot still checks the version, so that case is picked up on next launch.

import { watch as fsWatch, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

// resolveOnPath — the file a spawn of `bin` would run, or null. `bin` with a
// slash is taken as a path; a bare name is looked up on PATH like execvp.
export function resolveOnPath(bin, { pathEnv = process.env.PATH || '', exists = existsSync } = {}) {
  if (!bin || typeof bin !== 'string') return null;
  if (bin.includes('/')) return isAbsolute(bin) && exists(bin) ? bin : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try { if (exists(p) && statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

// watchInstall — call onChange (debounced) whenever the install behind `bin`
// may have changed. Returns stop(). Never throws: a folder that cannot be
// watched is skipped, and with nothing watchable the caller keeps its boot
// check only — never a poll.
export function watchInstall(bin, onChange, {
  debounceMs = 3000,
  watch = fsWatch,
  resolve = resolveOnPath,
  realpath = realpathSync,
} = {}) {
  let watchers = [];
  let timer = null;
  let stopped = false;

  const close = () => {
    for (const w of watchers) { try { w.close(); } catch { /* already gone */ } }
    watchers = [];
  };

  const arm = () => {
    close();
    if (stopped) return;
    const link = resolve(bin);
    if (!link) return;
    const dirs = new Set([dirname(link)]);
    try { dirs.add(dirname(realpath(link))); } catch { /* dangling mid-install */ }
    for (const dir of dirs) {
      try {
        const w = watch(dir, { persistent: false }, fire);
        w.on?.('error', () => { /* folder removed; re-armed on next fire */ });
        watchers.push(w);
      } catch { /* unwatchable folder: skip */ }
    }
  };

  function fire() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      arm();
      try { onChange(); } catch { /* caller's problem, never the watcher's */ }
    }, debounceMs);
    timer.unref?.();
  }

  arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
    close();
  };
}

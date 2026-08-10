#!/usr/bin/env node
// scripts/verify-pack.mjs — verify the PUBLISHED ARTIFACT, not the source tree.
//
// `npm test` runs the working tree; it cannot catch a file missing from
// package.json `files:`, a runtime dep that only resolves from your dev
// node_modules, or a node-pty spawn-helper that crashes on a fresh install.
// Those are exactly the bugs that turn a clean local run into a broken
// `npx @bluearch/mission-control`. This harness closes that gap by testing the
// same tarball npm would publish:
//
//   PACK      npm pack → the exact tgz that would ship (repo stays clean).
//   MANIFEST  cheap static check that the critical files are in the tarball.
//   INSTALL   install the tgz into a throwaway temp dir with EMPTY $HOME +
//             MC_CONFIG_DIR and --omit=dev (proves tsx/node-pty/ink resolve
//             from declared `dependencies`, and that mc boots with zero config).
//   BOOT      run `MC_SMOKE=1 mc` (tui/selfCheck.mjs): import graph resolves +
//             real pty.spawn works. This is the ground-truth pass.
//   NPX-SIM   reinstall with --ignore-scripts (npx skips postinstall) + break
//             the spawn-helper exec bit, then boot: the RUNTIME self-heal
//             (fixNodePty) must repair it and still pass.
//   NEGATIVE  same broken helper, but MC_SMOKE_NO_HEAL=1 disables the self-heal
//             — this MUST fail. If it passes, the verifier is hollow; we go red.
//             (Verify the verifier — a green-only harness proves nothing.)
//
// Exit 0 only if every stage is green (and the negative control went red as
// required). Writes a machine-readable summary to --report <path> for the
// launch-readiness artifact. Set MC_VERIFY_KEEP=1 to keep the temp dirs.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const PKG = 'bluearch-mission-control'; // scoped @bluearch/mission-control → tgz basename
const INSTALLED = '@bluearch/mission-control';

// Files that MUST be in the tarball — a fast, clear-message pre-filter. The BOOT
// stage is the real ground truth (it catches dynamic requires a static list can't),
// but this fails loudly and early on the obvious omissions.
const CRITICAL_FILES = [
  'bin/mc.mjs', 'tui/main.jsx', 'tui/selfCheck.mjs', 'tui/App.jsx',
  'server/fleet.mjs', 'scripts/fix-node-pty.mjs', 'README.md', 'LICENSE',
];

const results = [];
function record(stage, ok, detail) {
  results.push({ stage, ok, detail });
  const mark = ok ? '✓' : '✗';
  process.stdout.write(`  ${mark} ${stage}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

// Find every node-pty spawn-helper under an install (per-platform prebuild +
// any source build). Used to break/inspect the exec bit for the npx-sim path.
function spawnHelpers(installRoot) {
  const ptyRoot = join(installRoot, 'node_modules', 'node-pty');
  const out = [];
  const buildHelper = join(ptyRoot, 'build', 'Release', 'spawn-helper');
  if (existsSync(buildHelper)) out.push(buildHelper);
  const prebuilds = join(ptyRoot, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const d of readdirSync(prebuilds)) {
      const h = join(prebuilds, d, 'spawn-helper');
      if (existsSync(h)) out.push(h);
    }
  }
  return out;
}

// Install the tarball into a fresh temp consumer, return its dir. --omit=dev so
// only declared production deps resolve; extra npm args (e.g. --ignore-scripts)
// simulate the npx path that skips postinstall.
function installTo(label, tgz, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), `mc-verify-${label}-`));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `mc-verify-${label}`, private: true, version: '0.0.0' }));
  execFileSync('npm', ['install', tgz, '--omit=dev', '--no-audit', '--no-fund', '--silent', ...extraArgs],
    { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  return dir;
}

// Boot `MC_SMOKE=1 mc` from an install in a worst-case new-user env: empty HOME,
// dedicated empty config dir. Returns { ok, code, out }.
function boot(installDir, extraEnv = {}) {
  const bin = join(installDir, 'node_modules', INSTALLED, 'bin', 'mc.mjs');
  if (!existsSync(bin)) return { ok: false, code: -1, out: `bin not found at ${bin}` };
  const home = mkdtempSync(join(tmpdir(), 'mc-verify-home-'));
  const cfg = join(home, '.config', 'claude-mc');
  mkdirSync(cfg, { recursive: true });
  const r = spawnSync(NODE, [bin], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, MC_SMOKE: '1', MC_MOCK: 'verify', HOME: home, MC_CONFIG_DIR: cfg, ...extraEnv },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0 && /MC_SMOKE_OK/.test(out), code: r.status, out };
}

function cleanup(dirs) {
  if (process.env.MC_VERIFY_KEEP === '1') { console.log(`\n[kept] ${dirs.join('\n        ')}`); return; }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

async function main() {
  const reportIdx = process.argv.indexOf('--report');
  const reportPath = reportIdx >= 0 ? process.argv[reportIdx + 1] : null;
  const temps = [];
  process.stdout.write('verify-pack: testing the tarball npm would publish\n\n');

  // ── PACK ────────────────────────────────────────────────────────────────
  const packDir = mkdtempSync(join(tmpdir(), 'mc-verify-pack-'));
  temps.push(packDir);
  let tgz, fileList = [];
  try {
    const raw = execFileSync('npm', ['pack', '--json', '--pack-destination', packDir],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const meta = JSON.parse(raw)[0];
    tgz = join(packDir, meta.filename);
    fileList = (meta.files || []).map((f) => f.path);
    record('PACK', existsSync(tgz), `${meta.filename} · ${fileList.length} files · ${(meta.size / 1024).toFixed(0)}KB`);
  } catch (e) {
    record('PACK', false, e.message);
    return finish(temps, reportPath, false);
  }

  // ── MANIFEST ────────────────────────────────────────────────────────────
  const missing = CRITICAL_FILES.filter((f) => !fileList.includes(f));
  record('MANIFEST', missing.length === 0, missing.length ? `MISSING: ${missing.join(', ')}` : `all ${CRITICAL_FILES.length} critical files present`);

  // ── INSTALL + BOOT (postinstall ran) ─────────────────────────────────────
  let normalOk = false;
  try {
    const dir = installTo('normal', tgz);
    temps.push(dir);
    record('INSTALL', true, 'clean temp dir, --omit=dev, empty $HOME');
    const b = boot(dir);
    normalOk = record('BOOT', b.ok, b.ok ? b.out.match(/MC_SMOKE_OK.*/)?.[0] : `exit=${b.code} ${b.out.slice(0, 200)}`);
  } catch (e) {
    record('INSTALL', false, e.message.slice(0, 300));
  }

  // ── NPX self-heal + NEGATIVE control ─────────────────────────────────────
  // Simulate the fresh-install crash: a spawn-helper that lost its exec bit and
  // OUR postinstall never fixing it (the npx path). We install NORMALLY (not
  // --ignore-scripts) so node-pty's own binary is present on every platform —
  // on linux it has no bundled prebuild and must node-gyp-compile, which
  // --ignore-scripts would skip, yielding a false-red unrelated to the helper.
  // Breaking the exec bit AFTER install is a faithful stand-in for "our
  // postinstall didn't run": the negative control (self-heal off) MUST fail, and
  // the runtime self-heal MUST repair it.
  try {
    const dir = installTo('npx', tgz);
    temps.push(dir);
    const helpers = spawnHelpers(dir);
    if (helpers.length === 0) {
      record('NPX-SELFHEAL', false, 'no spawn-helper found post-install — cannot simulate the break (node-pty layout changed?)');
    } else {
      for (const h of helpers) chmodSync(h, 0o644); // break the exec bit (the posix_spawnp crash)
      const neg = boot(dir, { MC_SMOKE_NO_HEAL: '1' });
      // Negative control PASSES when the boot FAILED (broke as designed).
      record('NEGATIVE-CONTROL', !neg.ok, !neg.ok ? 'broken spawn-helper + no self-heal → boot failed as required' : 'HOLLOW: broken helper still booted — verifier would miss the real bug');

      // Re-break (the failed boot leaves the bit off) and boot WITH self-heal.
      for (const h of spawnHelpers(dir)) chmodSync(h, 0o644);
      const heal = boot(dir);
      record('NPX-SELFHEAL', heal.ok, heal.ok ? 'broken helper + our postinstall skipped → runtime fixNodePty repaired + booted' : `exit=${heal.code} ${heal.out.slice(0, 200)}`);
    }
  } catch (e) {
    record('NPX-SELFHEAL', false, e.message.slice(0, 300));
  }

  return finish(temps, reportPath);
}

function finish(temps, reportPath, forceFail) {
  const green = forceFail !== false && results.every((r) => r.ok);
  process.stdout.write(`\nverify-pack: ${green ? 'ALL GREEN — safe to publish' : 'RED — do NOT publish'}\n`);
  if (reportPath) {
    const summary = { ok: green, node: process.version, platform: process.platform, arch: process.arch, stages: results };
    try { writeFileSync(reportPath, JSON.stringify(summary, null, 2)); process.stdout.write(`verify-pack: report → ${reportPath}\n`); } catch {}
  }
  cleanup(temps);
  process.exit(green ? 0 : 1);
}

main().catch((e) => { console.error(`verify-pack: fatal ${e.stack || e.message}`); process.exit(1); });

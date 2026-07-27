#!/usr/bin/env node
// scripts/prepublish-guard.mjs — refuse to publish drift.
//
// Runs from the `prepublishOnly` npm lifecycle (fires on `npm publish`). It
// enforces the release invariant "published == a clean, tagged commit" so a
// stray local `npm publish` can never ship uncommitted or untagged code. CI's
// release.yml publishes from a checked-out tag (clean tree) and passes cleanly.
//
// Override for a deliberate exception: FORCE_PUBLISH=1 npm publish.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

if (process.env.FORCE_PUBLISH === '1') {
  console.log('prepublish-guard: FORCE_PUBLISH=1 — skipping drift checks.');
  process.exit(0);
}

let dirty, version, tagAtHead;
try {
  dirty = git(['status', '--porcelain']);
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  // Is there a tag vX.Y.Z pointing at HEAD?
  tagAtHead = git(['tag', '--points-at', 'HEAD']).split('\n').includes(`v${version}`);
} catch (e) {
  // No git (e.g. an exotic publish env): don't hard-block — warn and allow.
  console.warn(`prepublish-guard: git checks skipped (${e.message}).`);
  process.exit(0);
}

const problems = [];
if (dirty) problems.push('working tree has uncommitted changes');
if (!tagAtHead) problems.push(`HEAD is not tagged v${version} (releases are cut with \`npm version\`)`);

if (problems.length) {
  console.error('prepublish-guard: refusing to publish drift:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Fix: commit + `npm version <patch|minor|major>` on main, or FORCE_PUBLISH=1 to override.');
  process.exit(1);
}
console.log(`prepublish-guard: clean tree at tag v${version} — OK to publish.`);

// tests/readme.testPaths.test.mjs — 0467: every test file the README names
// must exist. The README once cited five test files that had been renamed or
// deleted (Zoom.chips, Zoom.input, recipes/zoom.recipes, Card.tier), so a
// reader looking for the proof of a claim found nothing.
//
// A plain path must exist. A glob path (contains `*`) must match at least one
// file under its fixed directory prefix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// `tests/**/*.test.*` → RegExp over a path relative to ROOT.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function citedTestPaths(text) {
  const found = new Set();
  for (const m of text.matchAll(/tests\/[A-Za-z0-9_.\/*-]+/g)) {
    found.add(m[0].replace(/[.,)`]+$/, ''));
  }
  return [...found];
}

test('0467: README cites at least one test path (the scan works)', () => {
  assert.ok(citedTestPaths(README).length > 5);
});

test('0467: every tests/… path named in README exists', () => {
  const missing = [];
  for (const p of citedTestPaths(README)) {
    if (p.includes('*')) {
      const fixed = p.slice(0, p.indexOf('*')).replace(/[^/]*$/, '');
      const base = join(ROOT, fixed);
      const re = globToRegExp(p);
      const hit = existsSync(base) && statSync(base).isDirectory()
        && walk(base).some((f) => re.test(f.slice(ROOT.length + 1)));
      if (!hit) missing.push(p);
    } else if (!existsSync(join(ROOT, p))) {
      missing.push(p);
    }
  }
  assert.deepEqual(missing, [], `README names test paths that do not exist: ${missing.join(', ')}`);
});

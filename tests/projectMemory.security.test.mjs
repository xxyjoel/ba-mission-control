// tests/projectMemory.security.test.mjs — S2 (0408): `.mc/MEMORY.md` hardening.
//
// The memory body is prepended to the session's first prompt, so it is
// attacker-reachable content in any cloned repo. Two holes closed:
//   • readProjectMemory followed symlinks (readFileSync) — a repo could ship
//     `.mc/MEMORY.md → ~/.ssh/id_ed25519` and the key landed in the prompt.
//   • no size cap — an unbounded file ballooned the paste silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectMemory, appendMemoryNote, MEMORY_MAX_BYTES } from '../tui/lib/projectMemory.js';

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'mc-mem-'));
  mkdirSync(join(repo, '.mc'), { recursive: true });
  return repo;
}

test('S2: a symlinked MEMORY.md is refused (never followed)', () => {
  const repo = makeRepo();
  try {
    const secret = join(repo, 'secret.txt');
    writeFileSync(secret, 'PRIVATE KEY MATERIAL');
    symlinkSync(secret, join(repo, '.mc', 'MEMORY.md'));
    assert.equal(readProjectMemory(repo), null, 'symlink must not be read into the prompt');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('S2: a directory at the MEMORY.md path is refused', () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, '.mc', 'MEMORY.md'));
    assert.equal(readProjectMemory(repo), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('S2: an oversized MEMORY.md is capped at MEMORY_MAX_BYTES', () => {
  const repo = makeRepo();
  try {
    const big = 'A'.repeat(MEMORY_MAX_BYTES + 4096);
    writeFileSync(join(repo, '.mc', 'MEMORY.md'), big);
    const body = readProjectMemory(repo);
    assert.ok(body, 'oversized file still yields a (truncated) body');
    assert.ok(body.length <= MEMORY_MAX_BYTES, `body capped: ${body.length} > ${MEMORY_MAX_BYTES}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('S2: a normal regular file still reads (existing contract holds)', () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, '.mc', 'MEMORY.md'), '- **2026-09-18** · a note\n');
    assert.equal(readProjectMemory(repo), '- **2026-09-18** · a note');
    // Round-trip through the writer too.
    const r = appendMemoryNote(repo, 'second note');
    assert.equal(r.ok, true);
    assert.match(readProjectMemory(repo), /second note/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('S2: missing file still maps to null (boot path unchanged)', () => {
  const repo = makeRepo();
  try {
    assert.equal(readProjectMemory(repo), null);
    assert.equal(readProjectMemory(null), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// tests/app/shellShutdown.test.mjs — pins 0318 acceptance criteria.
//
// Acceptance:
//   1. killShellSession() is called on every exit path in main.jsx:
//      shutdown(), process.on('exit', ...), and the clean-quit tail.
//   2. killShellSession() is imported from server/shellSession.mjs.
//
// main.jsx is an unimportable boot script (top-level `await app.waitUntilExit()`
// + Ink render that errors without a real TTY) — executing it in a test process
// would block indefinitely or crash. Source-level structural assertions are the
// correct approach for a boot file: they pin "killShellSession is called alongside
// fleet.killAll() at every exit path" without executing any of the runtime code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(__dirname, '../../tui/main.jsx'), 'utf8');

// ---------------------------------------------------------------------------
// Import assertion
// ---------------------------------------------------------------------------

test('main.jsx imports killShellSession from server/shellSession.mjs', () => {
  // Must have an import statement that brings in killShellSession.
  assert.match(
    mainSrc,
    /import\s*\{[^}]*killShellSession[^}]*\}\s*from\s*['"][^'"]*shellSession\.mjs['"]/,
    'killShellSession must be imported from shellSession.mjs',
  );
});

// ---------------------------------------------------------------------------
// Helpers — split source into the three exit segments
// ---------------------------------------------------------------------------

// Find all occurrences of killShellSession() call (not the import line).
function callIndices(src) {
  const re = /killShellSession\s*\(\s*\)/g;
  const indices = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    // Skip if this occurrence is inside an import statement.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lineText = src.slice(lineStart, src.indexOf('\n', m.index));
    if (!lineText.trim().startsWith('import')) {
      indices.push(m.index);
    }
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Path 1: shutdown() — signal-driven (SIGINT, SIGTERM, SIGHUP)
// ---------------------------------------------------------------------------

test('main.jsx calls killShellSession() inside the shutdown() function', () => {
  // Locate the shutdown function body.
  const shutdownStart = mainSrc.indexOf('const shutdown = () => {');
  assert.ok(shutdownStart !== -1, 'shutdown() function not found in main.jsx');

  // Find the closing brace of shutdown() — scan forward for the matching '}'.
  let depth = 0;
  let shutdownEnd = -1;
  for (let i = shutdownStart; i < mainSrc.length; i++) {
    if (mainSrc[i] === '{') depth++;
    else if (mainSrc[i] === '}') {
      depth--;
      if (depth === 0) { shutdownEnd = i; break; }
    }
  }
  assert.ok(shutdownEnd !== -1, 'Could not find end of shutdown() body');

  const shutdownBody = mainSrc.slice(shutdownStart, shutdownEnd + 1);
  assert.match(
    shutdownBody,
    /killShellSession\s*\(\s*\)/,
    'shutdown() must call killShellSession()',
  );
});

// ---------------------------------------------------------------------------
// Path 2: process.on('exit', ...) — final safety net
// ---------------------------------------------------------------------------

test("main.jsx calls killShellSession() inside the process.on('exit') handler", () => {
  // Locate process.on('exit' handler.
  const exitHandlerStart = mainSrc.indexOf("process.on('exit'");
  assert.ok(exitHandlerStart !== -1, "process.on('exit') handler not found in main.jsx");

  // Find the arrow function body for this handler.
  const arrowStart = mainSrc.indexOf('=>', exitHandlerStart);
  assert.ok(arrowStart !== -1, "Arrow function not found in process.on('exit') handler");

  const braceStart = mainSrc.indexOf('{', arrowStart);
  assert.ok(braceStart !== -1, "Opening brace not found in process.on('exit') body");

  // Find matching closing brace.
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < mainSrc.length; i++) {
    if (mainSrc[i] === '{') depth++;
    else if (mainSrc[i] === '}') {
      depth--;
      if (depth === 0) { braceEnd = i; break; }
    }
  }
  assert.ok(braceEnd !== -1, "Could not find end of process.on('exit') body");

  const exitBody = mainSrc.slice(braceStart, braceEnd + 1);
  assert.match(
    exitBody,
    /killShellSession\s*\(\s*\)/,
    "process.on('exit') must call killShellSession()",
  );
});

// ---------------------------------------------------------------------------
// Path 3: clean-quit tail — after await app.waitUntilExit()
// ---------------------------------------------------------------------------

test('main.jsx calls killShellSession() in the clean-quit tail after waitUntilExit()', () => {
  const waitIdx = mainSrc.lastIndexOf('await app.waitUntilExit()');
  assert.ok(waitIdx !== -1, 'await app.waitUntilExit() not found in main.jsx');

  // Everything after waitUntilExit() is the clean-quit tail.
  const tail = mainSrc.slice(waitIdx);
  assert.match(
    tail,
    /killShellSession\s*\(\s*\)/,
    'clean-quit tail (after waitUntilExit) must call killShellSession()',
  );
});

// ---------------------------------------------------------------------------
// Idempotency: killShellSession is called exactly 3 times (one per path)
// ---------------------------------------------------------------------------

test('main.jsx calls killShellSession() exactly 3 times (once per exit path)', () => {
  const calls = callIndices(mainSrc);
  assert.strictEqual(
    calls.length,
    3,
    `Expected 3 killShellSession() call sites; found ${calls.length}`,
  );
});

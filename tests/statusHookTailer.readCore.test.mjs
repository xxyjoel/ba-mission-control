// tests/statusHookTailer.readCore.test.mjs
//
// Paired tests for task 0264 — pin the read-core factory that task 0262 adds
// to server/statusHookTailer.mjs.
//
// Targeted API (0262 must match this exactly):
//   createReadCore(filePath: string) → { readNew(): Promise<object[]> }
//
//   - readNew() reads [currentOffset, fileSize) from filePath
//   - Buffers a trailing partial line (no \n yet); only completes it once a
//     newline arrives in a future readNew() call
//   - JSON.parses every COMPLETE line; silently skips malformed (non-JSON)
//     lines
//   - Advances the internal byte offset so re-calling readNew() when nothing
//     new has been written returns []
//   - Returns the array of parsed event objects for completed lines only
//
// Design is modelled on sessionFileTailer.mjs's offset/partial-line pattern.
// This module does NOT touch Agent state — pure (file → parsed events).
//
// These tests MUST fail until 0262 ships (createReadCore is not exported yet).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This import will throw / be undefined until task 0262 ships —
// which is the intended failing state for this test file.
import { createReadCore } from '../server/statusHookTailer.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

// Create a unique temp directory and a named file inside it. Returns the
// absolute file path; cleanup is registered via after().
function makeTempFile(dir) {
  const filePath = join(dir, 'status.ndjson');
  // Create the file empty so the read core can stat it immediately.
  writeFileSync(filePath, '');
  return filePath;
}

function validEvent(overrides = {}) {
  return {
    ts: Date.now(),
    session_id: 'c0264000-0264-0264-0264-c02640000264',
    event: 'PreToolUse',
    ...overrides,
  };
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('0264: createReadCore — byte-level NDJSON tailer', () => {
  // One shared temp dir for all tests in this suite; cleaned up after all.
  const tmpDir = mkdtempSync(join(tmpdir(), 'mc-readcore-'));
  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  // ── AC1: partial-line buffering — split across two appends ──────────────

  test('AC1: a line split across two appends is parsed exactly once, after the newline arrives', async () => {
    const filePath = join(tmpDir, 'ac1.ndjson');
    writeFileSync(filePath, '');
    const core = createReadCore(filePath);

    const ev = validEvent({ event: 'Stop' });
    const json = JSON.stringify(ev);

    // Append first half of the line — no newline yet
    const half = Math.floor(json.length / 2);
    appendFileSync(filePath, json.slice(0, half));

    // readNew() should see a partial line and return nothing
    const first = await core.readNew();
    assert.deepEqual(first, [], 'partial line (no newline) must yield no parsed events');

    // Append the second half plus the terminating newline
    appendFileSync(filePath, json.slice(half) + '\n');

    // Now readNew() must complete the buffered line and return exactly one event
    const second = await core.readNew();
    assert.equal(second.length, 1, 'one complete line must yield exactly one parsed event');
    assert.equal(second[0].event, 'Stop', 'the parsed event must match the original');

    // No double-parse: a third call with no new bytes returns []
    const third = await core.readNew();
    assert.deepEqual(third, [], 'no new bytes means no new events');
  });

  // ── AC2: malformed line between two valid lines ─────────────────────────

  test('AC2: malformed (non-JSON) line between two valid lines is skipped, both valid lines still returned', async () => {
    const filePath = join(tmpDir, 'ac2.ndjson');
    writeFileSync(filePath, '');
    const core = createReadCore(filePath);

    const ev1 = validEvent({ event: 'PreToolUse', seq: 1 });
    const ev2 = validEvent({ event: 'Stop', seq: 2 });

    // Write all three lines in one append so the read-core can't skip the bad
    // one by accident due to offset gaps.
    appendFileSync(
      filePath,
      JSON.stringify(ev1) + '\n' +
      'this is not valid JSON\n' +
      JSON.stringify(ev2) + '\n',
    );

    const events = await core.readNew();
    assert.equal(events.length, 2, 'two valid lines must yield two parsed events');
    assert.equal(events[0].event, 'PreToolUse', 'first valid event preserved');
    assert.equal(events[1].event, 'Stop',       'second valid event preserved');
  });

  // ── AC3: offset never re-reads already-consumed bytes ───────────────────

  test('AC3: second readNew() with no new bytes returns []', async () => {
    const filePath = join(tmpDir, 'ac3.ndjson');
    writeFileSync(filePath, '');
    const core = createReadCore(filePath);

    const ev = validEvent({ event: 'PreToolUse' });
    appendFileSync(filePath, JSON.stringify(ev) + '\n');

    const first = await core.readNew();
    assert.equal(first.length, 1, 'initial read returns one event');

    // No new bytes written — must not re-parse the already-consumed line
    const second = await core.readNew();
    assert.deepEqual(second, [], 'second readNew with no new bytes must return []');

    // A third call is also idempotent
    const third = await core.readNew();
    assert.deepEqual(third, [], 'third readNew still returns []');
  });

  // ── AC4: multiple complete lines in one append all parse ─────────────────

  test('AC4: multiple complete lines in a single append are all parsed', async () => {
    const filePath = join(tmpDir, 'ac4.ndjson');
    writeFileSync(filePath, '');
    const core = createReadCore(filePath);

    const events = [
      validEvent({ event: 'PreToolUse', seq: 1 }),
      validEvent({ event: 'Notification', notification_type: 'permission_prompt', seq: 2 }),
      validEvent({ event: 'Stop', seq: 3 }),
    ];

    // Single append with all three lines
    appendFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');

    const parsed = await core.readNew();
    assert.equal(parsed.length, 3, 'three complete lines must yield three parsed events');
    assert.equal(parsed[0].event, 'PreToolUse');
    assert.equal(parsed[1].event, 'Notification');
    assert.equal(parsed[2].event, 'Stop');
  });

  // ── AC5: blank lines in the NDJSON stream are skipped ───────────────────

  test('AC5: blank lines interspersed with valid NDJSON are skipped without error', async () => {
    const filePath = join(tmpDir, 'ac5.ndjson');
    writeFileSync(filePath, '');
    const core = createReadCore(filePath);

    const ev = validEvent({ event: 'Stop' });
    appendFileSync(filePath, '\n' + JSON.stringify(ev) + '\n\n');

    const parsed = await core.readNew();
    assert.equal(parsed.length, 1, 'blank lines do not count as parsed events');
    assert.equal(parsed[0].event, 'Stop');
  });
});

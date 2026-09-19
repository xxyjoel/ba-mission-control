// tests/bgSessions.test.mjs — paired tests for 0403 slice 1 (server/bgSessions.mjs).
// Fixtures mirror the labor-market-app project dir: a 16 KiB tail yields bg
// records for forks 31385158 / 93c118d4 and none for parents 9eed5575 /
// a9386068 / df4c967a. Rationale lives in the module; these pin the behaviour.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyTail, classifyTranscript, bgStatusFromEvents, aggregateBg,
  _resetKindCache, KIND_TAIL_BYTES, BG_SUB_ACTIVE_MS, BG_STALE_MS,
} from '../server/bgSessions.mjs';

const SID = (n) => `0403${String(n).padStart(4, '0')}-0403-4403-8403-040300000403`;
const rec = (o = {}) => JSON.stringify({ type: 'assistant', ...o });
const bgRec = (o = {}) => rec({ sessionKind: 'bg', ...o });
const ev = (o = {}) => ({ ts: Date.now(), session_id: SID(1), ...o });
const FRAG = '{"trunca'; // a byte-offset tail always starts mid-record
// Non-bg padding big enough that classifyTranscript must read a TRUNCATED tail.
const padNormal = (bytes) => {
  const line = rec({ pad: 'x'.repeat(200) }) + '\n';
  return line.repeat(Math.ceil(bytes / line.length));
};
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'mc-0403-'));
  process.on('exit', () => { try { rmSync(d, { recursive: true, force: true }); } catch {} });
  return d;
}

describe('0403: classifyTail', () => {
  test('ANY record carrying sessionKind:"bg" classifies the tail as bg', () => {
    assert.equal(classifyTail([FRAG, bgRec(), rec()].join('\n')), 'bg');
  });

  test('MEASURED SHAPE: the bg records lead and are NOT last', () => {
    // Real 16 KiB tail of fork 93c118d4 — a "check the last record" shortcut
    // calls this fork NORMAL and reopens 0403.
    const tail = [FRAG, bgRec({ type: 'attachment' }), bgRec({ type: 'attachment' }),
      rec({ type: 'last-prompt' }), rec({ type: 'ai-title' }), rec({ type: 'agent-name' }),
      rec({ type: 'mode' }), rec({ type: 'permission-mode' })].join('\n');
    assert.equal(classifyTail(tail), 'bg');
  });

  test('records with no sessionKind are normal (the three real parents)', () => {
    assert.equal(classifyTail([FRAG, rec({ type: 'user' }), rec()].join('\n')), 'normal');
  });

  test('the leading fragment is dropped, but only when told it is partial', () => {
    const whole = [bgRec(), rec()].join('\n');
    assert.equal(classifyTail(whole, { partialFirstLine: false }), 'bg');
    assert.equal(classifyTail(whole), 'normal');
  });

  test('SECURITY: the literal "sessionKind":"bg" inside content is not a match', () => {
    // Substring matching would mis-attribute any session that DISCUSSES forks.
    const poisoned = rec({ message: { text: 'the key is "sessionKind":"bg" here' } });
    assert.equal(classifyTail([FRAG, poisoned].join('\n')), 'normal');
  });

  test('malformed lines are skipped silently, never thrown', () => {
    assert.equal(classifyTail([FRAG, 'not json', '', '{"unclosed":', rec()].join('\n')), 'normal');
  });

  test('a nested sessionKind does not count — only the top-level field', () => {
    assert.equal(classifyTail([FRAG, rec({ meta: { sessionKind: 'bg' } })].join('\n')), 'normal');
  });
});

describe('0403: classifyTranscript', () => {
  beforeEach(() => _resetKindCache());

  test('TAIL not head: a bg record past 200 KiB is still found', () => {
    // Fork 31385158's first bg record sits at byte 161201, behind an inherited
    // non-bg prefix — a head read misses it by construction.
    const d = tmpDir(), p = join(d, `${SID(2)}.jsonl`);
    const pad = padNormal(200 * 1024);
    assert.ok(pad.length > KIND_TAIL_BYTES * 4);
    writeFileSync(p, pad + bgRec() + '\n');
    return classifyTranscript(p, SID(2)).then((k) => assert.equal(k, 'bg'));
  });

  test('GROWTH RE-CHECK: a negative cached during the inherited prefix is not permanent', async () => {
    const d = tmpDir(), p = join(d, `${SID(3)}.jsonl`);
    writeFileSync(p, rec() + '\n');
    assert.equal(await classifyTranscript(p, SID(3)), 'normal');
    appendFileSync(p, bgRec() + '\n');
    assert.equal(await classifyTranscript(p, SID(3)), 'bg');
  });

  test('an unchanged file answers from cache without reading disk', async () => {
    const d = tmpDir(), p = join(d, `${SID(4)}.jsonl`);
    writeFileSync(p, rec() + '\n');
    assert.equal(await classifyTranscript(p, SID(4)), 'normal');
    // Observe the cache rather than assert a value that a re-read would also
    // produce: swap the CONTENT for a bg record while holding the byte count
    // identical. A re-read would say 'bg'; the cache must still say 'normal'.
    const same = readFileSync(p, 'utf8');
    const swapped = bgRec() + '\n';
    writeFileSync(p, swapped.padEnd(same.length, ' ').slice(0, same.length));
    assert.equal(statSync(p).size, Buffer.byteLength(same), 'size must be unchanged');
    assert.equal(await classifyTranscript(p, SID(4)), 'normal', 'answered from cache');
  });

  test('NO CAP: a fork found only after many normal samples is still classified bg', async () => {
    // Measured 2026-09-16: bg records leave gaps wider than KIND_TAIL_BYTES (42
    // on fork 31385158, widest 919 KiB), so consecutive samples CAN legitimately
    // miss. An attempt cap would wedge such a fork into permanent invisibility —
    // 0403 again. A negative must stay provisional for the life of the process.
    const d = tmpDir(), p = join(d, `${SID(5)}.jsonl`);
    writeFileSync(p, rec() + '\n');
    for (let i = 0; i < 12; i++) {
      assert.equal(await classifyTranscript(p, SID(5)), 'normal');
      appendFileSync(p, rec({ i }) + '\n');
    }
    appendFileSync(p, bgRec() + '\n');
    assert.equal(await classifyTranscript(p, SID(5)), 'bg', 'still re-tested after 12 misses');
  });

  test('a SHRINKING file is re-tested, not pinned to a stale high-water mark', async () => {
    const d = tmpDir(), p = join(d, `${SID(9)}.jsonl`);
    writeFileSync(p, rec() + '\n' + rec({ pad: 'x'.repeat(200) }) + '\n');
    assert.equal(await classifyTranscript(p, SID(9)), 'normal');
    writeFileSync(p, bgRec() + '\n'); // replaced by a SMALLER file at the same path
    assert.equal(await classifyTranscript(p, SID(9)), 'bg');
  });

  test('a positive is permanent and costs zero I/O', async () => {
    const d = tmpDir(), p = join(d, `${SID(6)}.jsonl`);
    writeFileSync(p, bgRec() + '\n' + rec() + '\n');
    assert.equal(await classifyTranscript(p, SID(6)), 'bg');
    rmSync(p);
    assert.equal(await classifyTranscript(p, SID(6)), 'bg');
  });

  test('FAILS OPEN: an unreadable path is normal, does not throw, and is not cached', async () => {
    // Fail-open is load-bearing for slice 2 — rotation must still adopt a sid
    // it could not classify or 0187 /clear rotation regresses.
    const d = tmpDir(), p = join(d, `${SID(7)}.jsonl`);
    assert.equal(await classifyTranscript(p, SID(7)), 'normal');
    writeFileSync(p, bgRec() + '\n');
    assert.equal(await classifyTranscript(p, SID(7)), 'bg', 'the miss must not be cached');
  });

  test('an empty transcript is normal and does not throw', async () => {
    const d = tmpDir(), p = join(d, `${SID(8)}.jsonl`);
    writeFileSync(p, '');
    assert.equal(await classifyTranscript(p, SID(8)), 'normal');
  });
});

describe('0403: bgStatusFromEvents', () => {
  const now = 1_700_000_000_000;

  test('UserPromptSubmit and PreToolUse both read working', () => {
    assert.equal(bgStatusFromEvents([ev({ event: 'UserPromptSubmit' })], now), 'working');
    assert.equal(bgStatusFromEvents([ev({ event: 'PreToolUse' })], now), 'working');
  });

  test('LAST NON-NULL mapping wins, never the last event', () => {
    // mapEventToStatus(events.at(-1)) reads idle here and would blank the chip
    // in the middle of every tool call.
    assert.equal(bgStatusFromEvents([ev({ event: 'PreToolUse' }), ev({ event: 'PostToolUse' })], now), 'working');
  });

  test('a fork blocked on a permission prompt reads waiting', () => {
    assert.equal(bgStatusFromEvents(
      [ev({ event: 'PreToolUse' }), ev({ event: 'Notification', notification_type: 'permission_prompt' })], now,
    ), 'waiting');
  });

  test('0408-P3 parity: a main-thread PostToolUse after the prompt reads working (answered)', () => {
    // Mirrors doRead()'s one exception: the prompt was approved and the tool
    // already ran — 'waiting' would report an ask that no longer exists.
    assert.equal(bgStatusFromEvents(
      [ev({ event: 'Notification', notification_type: 'permission_prompt' }),
       ev({ event: 'PostToolUse', tool_name: 'Bash', ts: now - 1000 })], now,
    ), 'working');
  });

  test('0408-P3 parity: a SUB PostToolUse never lifts waiting (0395 gate)', () => {
    assert.equal(bgStatusFromEvents(
      [ev({ event: 'Notification', notification_type: 'permission_prompt' }),
       ev({ event: 'PostToolUse', tool_name: 'Bash', sub: true, ts: now - 1000 })], now,
    ), 'waiting');
  });

  test('the MEASURED finished tail — PostToolUse, Stop, idle_prompt — reads idle', () => {
    // 93c118d4 at 10:20. An mtime-freshness count would call this "1bg working".
    assert.equal(bgStatusFromEvents([ev({ event: 'PostToolUse', tool_name: 'Bash' }),
      ev({ event: 'Stop' }), ev({ event: 'Notification', notification_type: 'idle_prompt' })], now), 'idle');
  });

  test('0398 one level down: main thread Stopped, the fork’s OWN subagents live', () => {
    assert.equal(bgStatusFromEvents(
      [ev({ event: 'Stop' }), ev({ event: 'PreToolUse', sub: true, ts: now - 5000 })], now,
    ), 'working');
  });

  test('a sub event older than the liveness window reads idle', () => {
    assert.equal(bgStatusFromEvents(
      [ev({ event: 'Stop' }), ev({ event: 'PreToolUse', sub: true, ts: now - BG_SUB_ACTIVE_MS - 1000 })], now,
    ), 'idle');
  });

  test('a stale sub tool event never reaches the mapping and cannot pin working', () => {
    // If subs fed the mapping they would return working while bypassing
    // BG_SUB_ACTIVE_MS entirely, defeating the window.
    assert.equal(bgStatusFromEvents(
      [ev({ event: 'PreToolUse', sub: true, ts: now - BG_SUB_ACTIVE_MS - 1000 })], now,
    ), 'idle');
  });

  test('PostToolUse-only events with a stale sub clock read idle, never crash', () => {
    assert.equal(bgStatusFromEvents([ev({ event: 'PostToolUse' })], now), 'idle');
  });

  test('empty / garbage input is idle, not a throw', () => {
    assert.equal(bgStatusFromEvents([], now), 'idle');
    assert.equal(bgStatusFromEvents([null, 42, 'x'], now), 'idle');
    assert.equal(bgStatusFromEvents(undefined, now), 'idle');
  });
});

describe('0403: aggregateBg', () => {
  test('no records, and all-idle records, both yield no chip', () => {
    assert.deepEqual(aggregateBg([]), { count: 0, status: null });
    assert.deepEqual(aggregateBg([{ status: 'idle' }, { status: 'idle' }]), { count: 0, status: null });
  });

  test('two working forks read 2 / working', () => {
    assert.deepEqual(aggregateBg([{ status: 'working' }, { status: 'working' }]),
      { count: 2, status: 'working' });
  });

  test('waiting outranks working and idle is excluded from the count', () => {
    assert.deepEqual(aggregateBg([{ status: 'working' }, { status: 'waiting' }, { status: 'idle' }]),
      { count: 2, status: 'waiting' });
  });
});

describe('0403: module load order', () => {
  test('the cycle resolves with sessionFileTailer loaded FIRST, in a clean realm', async () => {
    // Slice 2 adds sessionFileTailer → bgSessions, and bgSessions →
    // statusHookTailer → sessionFileTailer already exists (creationPollDelay).
    // The graph cycles; it resolves only because nothing in it runs at
    // module-eval time. A plain `await import()` here proves nothing — this
    // file already static-imports bgSessions at line 12, so the whole graph is
    // resolved before the test body runs. Fork a fresh node with the OPPOSITE
    // load order so a future top-level call actually surfaces.
    const { execFileSync } = await import('node:child_process');
    const src = [
      "import('../server/sessionFileTailer.mjs')",
      "  .then(() => import('../server/bgSessions.mjs'))",
      "  .then((m) => { if (typeof m.classifyTranscript !== 'function') throw new Error('missing export'); process.stdout.write('ok'); })",
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(out.trim(), 'ok');
  });
});

describe('0403: tail budget', () => {
  test('KIND_TAIL_BYTES is large enough for a bg record behind a realistic prefix', () => {
    // Pins the constant. Mutation testing found 16*1024 → 1024 survived every
    // other case, so the module's central measured claim was unprotected.
    // Measured shape it must cover: fork 93c118d4's bg records sit behind an
    // inherited prefix and the nearest one to EOF is 529 bytes back, but the
    // record itself plus the undefined-kind trailer (last-prompt, ai-title,
    // agent-name, mode, permission-mode) spans multiple KiB.
    assert.ok(KIND_TAIL_BYTES >= 8 * 1024, 'a KiB-scale budget cannot span the trailer');
  });

  test('a bg record 8 KiB from EOF is still found; one past the budget is not', async () => {
    const d = tmpDir(), p = join(d, `${SID(10)}.jsonl`);
    // bg record, then 8 KiB of normal trailer — inside a 16 KiB tail.
    writeFileSync(p, padNormal(4096) + bgRec() + '\n' + padNormal(8 * 1024));
    assert.equal(await classifyTranscript(p, SID(10)), 'bg', 'within budget');
    // Same shape, trailer pushed past KIND_TAIL_BYTES — correctly missed, which
    // is exactly why a negative stays provisional and is re-tested on growth.
    const q = join(d, `${SID(11)}.jsonl`);
    writeFileSync(q, bgRec() + '\n' + padNormal(KIND_TAIL_BYTES + 8192));
    assert.equal(await classifyTranscript(q, SID(11)), 'normal', 'beyond budget');
  });
});

describe('0403: staleness', () => {
  test('a fork "awaiting input" for six days is idle, not waiting', () => {
    // The 2026-09-16 screenshot listed background conversations awaiting input
    // at 6d and 16d. Counting those pins a permanent chip on an idle card.
    const sixDays = 6 * 24 * 60 * 60_000;
    const now = Date.now();
    const events = [{ ts: now - sixDays, event: 'Notification', notification_type: 'permission_prompt', session_id: SID(1) }];
    assert.equal(bgStatusFromEvents(events, now), 'idle');
  });

  test('a working mapping older than BG_STALE_MS reads idle', () => {
    const now = Date.now();
    const stale = [{ ts: now - (BG_STALE_MS + 60_000), event: 'PreToolUse', session_id: SID(1) }];
    assert.equal(bgStatusFromEvents(stale, now), 'idle', 'wedged, not working');
    const fresh = [{ ts: now - 5_000, event: 'PreToolUse', session_id: SID(1) }];
    assert.equal(bgStatusFromEvents(fresh, now), 'working');
  });

  test('a fresh permission prompt still reads waiting', () => {
    const now = Date.now();
    const events = [{ ts: now - 30_000, event: 'Notification', notification_type: 'permission_prompt', session_id: SID(1) }];
    assert.equal(bgStatusFromEvents(events, now), 'waiting');
  });
});

// tests/jsonlConnector.test.mjs — coverage for server/jsonlConnector.mjs
// (the pure event parser + cost deriver that will replace
// stream-json's #handle() in the single-pipeline rewrite).
//
// Test strategy: build a minimal "agent-like" plain object, feed
// real-shape JSONL events through parseEvent, assert mutations.
// Cost tests use known token counts against the published pricing
// table in tui/lib/models.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent, deriveCost } from '../server/jsonlConnector.mjs';

function makeAgent(overrides = {}) {
  return {
    status: 'idle',
    activity: '',
    tail: [],
    todos: [],
    tokensIn: 0,
    tokensOut: 0,
    context: 0,
    costSession: 0,
    resolvedModel: null,
    permissionMode: 'acceptEdits',
    lastEventTs: 0,
    ...overrides,
  };
}

// ─── parseEvent: user events ──────────────────────────────────────

test('parseEvent: plain user prompt → tail (user) + activity + working', () => {
  const a = makeAgent();
  const changed = parseEvent({
    type: 'user',
    message: { role: 'user', content: 'hello claude' },
    sessionId: 's1',
  }, a);
  assert.equal(changed, true);
  assert.equal(a.tail.length, 1);
  assert.equal(a.tail[0].kind, 'user');
  assert.equal(a.tail[0].text, 'hello claude');
  assert.equal(a.activity, 'hello claude');
  assert.equal(a.status, 'working');
});

test('parseEvent: user with tool_result array → sys tail entry', () => {
  const a = makeAgent();
  const changed = parseEvent({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents here', is_error: false },
      ],
    },
  }, a);
  assert.equal(changed, true);
  assert.equal(a.tail.length, 1);
  assert.equal(a.tail[0].kind, 'sys');
  assert.match(a.tail[0].text, /tool_result/);
  assert.match(a.tail[0].text, /file contents here/);
});

test('parseEvent: tool_result clears stale waiting → working + drops awaitingPrompt', () => {
  // Regression: after AskUserQuestion the card is 'waiting' + has awaitingPrompt.
  // The user's answer arrives as a user/tool_result — it must flip off 'waiting'
  // immediately, not linger until claude's next assistant record (the ~14s
  // "INPUT shows after I already answered" lag).
  const a = makeAgent({
    status: 'waiting',
    awaitingPrompt: { kind: 'single-select', tool: 'AskUserQuestion' },
  });
  const changed = parseEvent({
    type: 'user',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_q', content: 'Option A', is_error: false },
    ] },
  }, a);
  assert.equal(changed, true);
  assert.equal(a.status, 'working');
  assert.equal(a.awaitingPrompt, null);
});

test('parseEvent: user with tool_result is_error=true → marked as error', () => {
  const a = makeAgent();
  parseEvent({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: 'EACCES', is_error: true }],
    },
  }, a);
  assert.match(a.tail[0].text, /\(error\)/);
});

test('parseEvent: empty user content → no change', () => {
  const a = makeAgent();
  const changed = parseEvent({ type: 'user', message: { content: '' } }, a);
  assert.equal(changed, false);
  assert.equal(a.tail.length, 0);
});

// ─── parseEvent: assistant events ─────────────────────────────────

test('parseEvent: assistant text → tail (asst) + activity + working', () => {
  const a = makeAgent();
  const changed = parseEvent({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 6, output_tokens: 6 },
    },
  }, a);
  assert.equal(changed, true);
  assert.equal(a.tail.length, 1);
  assert.equal(a.tail[0].kind, 'asst');
  assert.equal(a.tail[0].text, 'pong');
  assert.equal(a.activity, 'pong');
  assert.equal(a.resolvedModel, 'claude-opus-4-7');
  assert.equal(a.status, 'idle', 'stop_reason=end_turn → idle');
});

test('parseEvent: assistant tool_use → tail (tool) + working', () => {
  const a = makeAgent();
  parseEvent({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      ],
      stop_reason: 'tool_use',
    },
  }, a);
  assert.equal(a.tail.length, 1);
  assert.equal(a.tail[0].kind, 'tool');
  assert.equal(a.tail[0].tool, 'Bash');
  assert.equal(a.tail[0].text, 'ls -la');
  assert.match(a.activity, /Bash.*ls -la/);
  assert.equal(a.status, 'working', 'stop_reason=tool_use → still working');
});

test('parseEvent: AskUserQuestion tool_use → waiting + awaitingPrompt chips', () => {
  const a = makeAgent({ status: 'working' });
  parseEvent({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      content: [
        { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [
          { question: 'Which next?', header: 'Next', multiSelect: false, options: [
            { label: 'Phase E', description: '…' },
            { label: 'Fix #14', description: '…' },
          ] },
        ] } },
      ],
      stop_reason: 'tool_use',
    },
  }, a);
  // A human-blocking tool means claude is awaiting input, NOT computing.
  assert.equal(a.status, 'waiting', 'AskUserQuestion blocks on the user → waiting');
  assert.equal(a.awaitingPrompt.kind, 'single-select');
  assert.deepEqual(a.awaitingPrompt.options.map(o => o.text), ['Phase E', 'Fix #14']);
});

test('parseEvent: ExitPlanMode tool_use → waiting (approval gate)', () => {
  const a = makeAgent({ status: 'working' });
  parseEvent({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'do X' } }],
      stop_reason: 'tool_use',
    },
  }, a);
  assert.equal(a.status, 'waiting', 'plan approval blocks on the user → waiting');
  assert.equal(a.awaitingPrompt.kind, 'approval');
});

test('parseEvent: assistant TodoWrite → agent.todos snapshot', () => {
  const a = makeAgent();
  parseEvent({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      content: [
        { type: 'tool_use', name: 'TodoWrite', input: { todos: [
          { content: 'do A', status: 'completed', activeForm: 'doing A' },
          { content: 'do B', status: 'in_progress' },
          { content: 'do C', status: 'pending' },
        ] } },
      ],
    },
  }, a);
  assert.equal(a.todos.length, 3);
  assert.deepEqual(a.todos.map(t => t.status), ['completed', 'in_progress', 'pending']);
});

test('parseEvent: assistant thinking → tail (think)', () => {
  const a = makeAgent();
  parseEvent({
    type: 'assistant',
    message: {
      content: [{ type: 'thinking', thinking: 'let me think about this' }],
    },
  }, a);
  assert.equal(a.tail.length, 1);
  assert.equal(a.tail[0].kind, 'think');
});

test('parseEvent: assistant usage → tokens + cost accumulate', () => {
  const a = makeAgent();
  parseEvent({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'reply' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 1000,
        output_tokens: 50,
      },
    },
  }, a);
  // tokensIn is FRESH input only (input + cache_creation); cache reads are
  // broken out into tokensCacheRead so the headline isn't inflated by the
  // context re-read each turn. context (the live window) still counts all three.
  assert.equal(a.tokensIn, 100 + 200);
  assert.equal(a.tokensCacheRead, 1000);
  assert.equal(a.tokensOut, 50);
  assert.equal(a.context, 1300);
  assert.ok(a.costSession > 0, 'cost should be positive');
});

test('parseEvent: sidechain assistant → does NOT overwrite ctx, still counts tokens', () => {
  // A sub-agent (Task) turn carries isSidechain:true and its own, smaller usage.
  // It must not clobber the main-thread context gauge, but its tokens are real
  // spend and still accumulate.
  const a = makeAgent({ context: 150000, tokensIn: 150000, tokensCacheRead: 0 });
  parseEvent({
    type: 'assistant',
    isSidechain: true,
    message: {
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'sub-agent reply' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, cache_creation_input_tokens: 300, cache_read_input_tokens: 13000, output_tokens: 20 },
    },
  }, a);
  assert.equal(a.context, 150000, 'sidechain must not move the main-thread ctx gauge');
  assert.equal(a.tokensIn, 150000 + 1 + 300, 'sidechain fresh input still counts as spend');
  assert.equal(a.tokensCacheRead, 13000, 'sidechain cache reads counted separately');
  assert.equal(a.tokensOut, 20);
});

test('parseEvent: assistant without usage → no token change', () => {
  const a = makeAgent({ tokensIn: 5 });
  parseEvent({
    type: 'assistant',
    message: { model: 'claude-opus-4-7', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' },
  }, a);
  assert.equal(a.tokensIn, 5, 'tokens unchanged when usage absent');
});

// ─── parseEvent: system events ────────────────────────────────────

test('parseEvent: system turn_duration → status idle', () => {
  const a = makeAgent({ status: 'working' });
  const changed = parseEvent({ type: 'system', subtype: 'turn_duration' }, a);
  assert.equal(changed, true);
  assert.equal(a.status, 'idle');
});

test('parseEvent: system api_error mid-retry → tail (err) + stays working', () => {
  // Transient ECONNRESET-style error claude is still retrying (attempt < max):
  // the card must NOT go red — claude is alive and working. Regression guard
  // for the "errored while working" report (every transient retry flashed red).
  const a = makeAgent();
  const changed = parseEvent({
    type: 'system',
    subtype: 'api_error',
    error: { type: null, cause: { code: 'ECONNRESET' } },
    retryAttempt: 1,
    maxRetries: 10,
  }, a);
  assert.equal(changed, true);
  assert.equal(a.status, 'working');
  assert.equal(a.tail[0].kind, 'err');
  assert.match(a.tail[0].text, /ECONNRESET/);
  assert.match(a.tail[0].text, /retry 1\/10/);
  assert.match(a.activity, /retrying api/);
});

test('parseEvent: api_error increments apiErrorCount + stamps lastApiErrorTs', () => {
  // Fuels the fleet header's "N retrying (api)" heartbeat.
  const a = makeAgent();
  const t0 = Date.now();
  parseEvent({ type: 'system', subtype: 'api_error',
    error: { cause: { code: 'ECONNRESET' } }, retryAttempt: 1, maxRetries: 10 }, a);
  parseEvent({ type: 'system', subtype: 'api_error',
    error: { cause: { code: 'ECONNRESET' } }, retryAttempt: 2, maxRetries: 10 }, a);
  assert.equal(a.apiErrorCount, 2);
  assert.ok(a.lastApiErrorTs >= t0, 'lastApiErrorTs stamped');
});

test('parseEvent: system api_error retries exhausted → status error', () => {
  // attempt >= max means claude gave up — this one IS a terminal error.
  const a = makeAgent();
  const changed = parseEvent({
    type: 'system',
    subtype: 'api_error',
    error: { type: 'rate_limit' },
    retryAttempt: 5,
    maxRetries: 5,
  }, a);
  assert.equal(changed, true);
  assert.equal(a.status, 'error');
  assert.equal(a.tail[0].kind, 'err');
  assert.match(a.tail[0].text, /rate_limit/);
  assert.match(a.tail[0].text, /retry 5\/5/);
});

test('parseEvent: system local_command → sys tail entry', () => {
  const a = makeAgent();
  parseEvent({ type: 'system', subtype: 'local_command', content: 'npm test' }, a);
  assert.equal(a.tail.length, 1);
  assert.equal(a.tail[0].kind, 'sys');
  assert.match(a.tail[0].text, /! npm test/);
});

test('parseEvent: system compact_boundary → resets ctx gauge to 0', () => {
  const a = makeAgent({ context: 150000 });
  const changed = parseEvent({ type: 'system', subtype: 'compact_boundary',
    content: 'Conversation compacted', compactMetadata: { preTokens: 136176 } }, a);
  assert.equal(changed, true);
  assert.equal(a.context, 0, 'ctx reset immediately on /compact');
  assert.match(a.tail[0].text, /compacted/);
});

test('parseEvent: user /clear → resets ctx gauge AND consumption summaries to 0', () => {
  // Real claude shape: /clear arrives as a `type:"user"` message whose content
  // is wrapped in <command-name>/clear</command-name> — NOT a local_command
  // system event (that one's content is only the command's stdout).
  const a = makeAgent({ context: 150000, tokensIn: 200000, tokensCacheRead: 900000, tokensOut: 50000, costSession: 1.23 });
  const changed = parseEvent({ type: 'user', message: { role: 'user',
    content: '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>' } }, a);
  assert.equal(changed, true);
  assert.equal(a.context, 0, 'ctx reset immediately on /clear');
  assert.equal(a.tokensIn, 0, 'tokensIn reset on /clear');
  assert.equal(a.tokensCacheRead, 0, 'tokensCacheRead reset on /clear');
  assert.equal(a.tokensOut, 0, 'tokensOut reset on /clear');
  assert.equal(a.costSession, 0, 'costSession reset on /clear');
  assert.match(a.tail[0].text, /cleared/);
});

test('parseEvent: local_command non-clear leaves ctx untouched', () => {
  const a = makeAgent({ context: 150000 });
  parseEvent({ type: 'system', subtype: 'local_command', content: 'npm test' }, a);
  assert.equal(a.context, 150000, 'only /clear resets ctx');
});

test('parseEvent: system stop_hook_summary → ignored', () => {
  const a = makeAgent();
  const changed = parseEvent({ type: 'system', subtype: 'stop_hook_summary', hookCount: 2 }, a);
  assert.equal(changed, false);
  assert.equal(a.tail.length, 0);
});

// ─── parseEvent: permission-mode ──────────────────────────────────

test('parseEvent: permission-mode → updates agent.permissionMode', () => {
  const a = makeAgent();
  const changed = parseEvent({ type: 'permission-mode', permissionMode: 'plan' }, a);
  assert.equal(changed, true);
  assert.equal(a.permissionMode, 'plan');
  assert.equal(a.tail[0].kind, 'sys');
  assert.match(a.tail[0].text, /plan/);
});

test('parseEvent: permission-mode same as current → no change', () => {
  const a = makeAgent({ permissionMode: 'acceptEdits' });
  const changed = parseEvent({ type: 'permission-mode', permissionMode: 'acceptEdits' }, a);
  assert.equal(changed, false);
});

// ─── parseEvent: noise events ─────────────────────────────────────

test('parseEvent: ai-title → ignored (no-op)', () => {
  const a = makeAgent();
  const changed = parseEvent({ type: 'ai-title', aiTitle: 'My Session' }, a);
  assert.equal(changed, false);
});

test('parseEvent: attachment → ignored', () => {
  const a = makeAgent();
  const changed = parseEvent({ type: 'attachment', attachment: { type: 'deferred_tools_delta' } }, a);
  assert.equal(changed, false);
});

test('parseEvent: file-history-snapshot → ignored', () => {
  const a = makeAgent();
  const changed = parseEvent({ type: 'file-history-snapshot' }, a);
  assert.equal(changed, false);
});

test('parseEvent: unknown event type → false, no mutation', () => {
  const a = makeAgent();
  const beforeTail = a.tail.length;
  const changed = parseEvent({ type: 'something-new' }, a);
  assert.equal(changed, false);
  assert.equal(a.tail.length, beforeTail);
});

test('parseEvent: malformed event (no type) → false', () => {
  const a = makeAgent();
  assert.equal(parseEvent({}, a), false);
  assert.equal(parseEvent(null, a), false);
  assert.equal(parseEvent({ type: null }, a), false);
});

// ─── parseEvent: side-effects ─────────────────────────────────────

test('parseEvent: every event bumps lastEventTs', () => {
  const a = makeAgent({ lastEventTs: 0 });
  parseEvent({ type: 'ai-title' }, a); // noise event still bumps
  assert.ok(a.lastEventTs > 0);
});

test('parseEvent: tail respects TAIL_MAX (40 entries)', () => {
  const a = makeAgent();
  for (let i = 0; i < 50; i++) {
    parseEvent({ type: 'user', message: { content: `msg ${i}` } }, a);
  }
  assert.equal(a.tail.length, 40, 'oldest entries dropped');
  assert.equal(a.tail[0].text, 'msg 10', 'first surviving entry is the 11th');
});

// ─── deriveCost ────────────────────────────────────────────────────

test('deriveCost: pong-like turn (probe values, Opus 4.7)', () => {
  // Real values from scripts/probe-pty.mjs probe run.
  const cost = deriveCost({
    input_tokens: 6,
    cache_creation_input_tokens: 19400,
    cache_read_input_tokens: 15968,
    output_tokens: 6,
  }, 'claude-opus-4-7');
  // Hand-computed: (6*15 + 19400*18.75 + 15968*1.5 + 6*75) / 1e6
  //              = (90 + 363750 + 23952 + 450) / 1e6
  //              = 388242 / 1e6 = 0.388242 USD
  assert.ok(cost > 0.38 && cost < 0.40, `expected ~$0.39, got ${cost}`);
});

test('deriveCost: cache-heavy Sonnet turn', () => {
  const cost = deriveCost({
    input_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 10000,
    output_tokens: 500,
  }, 'sonnet-4.6');
  // (50*3 + 10000*0.3 + 500*15) / 1e6 = (150 + 3000 + 7500) / 1e6 = 0.01065
  assert.ok(Math.abs(cost - 0.01065) < 0.0001, `expected ~$0.0107, got ${cost}`);
});

test('deriveCost: output-heavy Haiku turn', () => {
  const cost = deriveCost({
    input_tokens: 100,
    output_tokens: 5000,
  }, 'haiku-4.5');
  // (100*1 + 5000*5) / 1e6 = 25100 / 1e6 = 0.0251
  assert.ok(Math.abs(cost - 0.0251) < 0.0001, `expected ~$0.025, got ${cost}`);
});

test('deriveCost: friendly id also works', () => {
  const cost = deriveCost({ input_tokens: 1000, output_tokens: 500 }, 'opus-4.7');
  // (1000*15 + 500*75) / 1e6 = 52500 / 1e6 = 0.0525
  assert.ok(Math.abs(cost - 0.0525) < 0.0001);
});

test('deriveCost: unknown model → 0 (no crash)', () => {
  assert.equal(deriveCost({ input_tokens: 100 }, 'made-up-model'), 0);
});

test('deriveCost: missing usage → 0', () => {
  assert.equal(deriveCost(null, 'opus-4.7'), 0);
  assert.equal(deriveCost(undefined, 'opus-4.7'), 0);
});

test('deriveCost: zero-token call → 0', () => {
  assert.equal(deriveCost({}, 'opus-4.7'), 0);
});

// ─── per-session metrics (#12) ──────────────────────────────────────

test('parseEvent: plain user prompt increments messageCount', () => {
  const a = makeAgent();
  parseEvent({ type: 'user', message: { role: 'user', content: 'hi' } }, a);
  assert.equal(a.messageCount, 1);
  parseEvent({ type: 'user', message: { role: 'user', content: 'again' } }, a);
  assert.equal(a.messageCount, 2);
});

test('parseEvent: tool_result user events do NOT increment messageCount', () => {
  const a = makeAgent();
  parseEvent({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  }, a);
  assert.equal(a.messageCount || 0, 0);
});

test('parseEvent: system turn_duration increments turnCount + flips status idle', () => {
  const a = makeAgent({ status: 'working' });
  parseEvent({ type: 'system', subtype: 'turn_duration', duration_ms: 1234 }, a);
  assert.equal(a.turnCount, 1);
  assert.equal(a.status, 'idle');
});

test('parseEvent: multiple turn_duration events accumulate turnCount', () => {
  const a = makeAgent({ status: 'working' });
  parseEvent({ type: 'system', subtype: 'turn_duration', duration_ms: 100 }, a);
  parseEvent({ type: 'system', subtype: 'turn_duration', duration_ms: 200 }, a);
  parseEvent({ type: 'system', subtype: 'turn_duration', duration_ms: 300 }, a);
  assert.equal(a.turnCount, 3);
});

// ── waiting / needs-input detection on the PTY path ─────────────────
// Previously this pipeline only produced working/idle/error and the
// 'waiting' state never appeared on a card. end_turn now splits into
// idle (answered) vs waiting (asked the user something).

test('parseEvent: end_turn with a question → status waiting + awaitingPrompt', () => {
  const a = makeAgent({ status: 'working' });
  parseEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'I can take either path. Should I proceed?' }],
      stop_reason: 'end_turn',
    },
  }, a);
  assert.equal(a.status, 'waiting');
  assert.ok(a.awaitingPrompt, 'awaitingPrompt populated so Zoom can render chips');
});

test('parseEvent: end_turn with an option list → status waiting (single-select)', () => {
  const a = makeAgent({ status: 'working' });
  parseEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Which approach do you prefer?\n1. Rebase\n2. Merge' }],
      stop_reason: 'end_turn',
    },
  }, a);
  assert.equal(a.status, 'waiting');
  assert.equal(a.awaitingPrompt.kind, 'single-select');
});

test('parseEvent: end_turn with a plain answer → status idle, no awaitingPrompt', () => {
  const a = makeAgent({ status: 'working' });
  parseEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done. The file has been updated.' }],
      stop_reason: 'end_turn',
    },
  }, a);
  assert.equal(a.status, 'idle');
  assert.equal(a.awaitingPrompt, null);
});

test('parseEvent: assistant tool_use (no end_turn) stays working, not waiting', () => {
  const a = makeAgent({ status: 'idle' });
  parseEvent({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
  }, a);
  assert.equal(a.status, 'working');
});

// ── tok/min sparkline on the PTY path (#26) ─────────────────────────
// The PTY pipeline used to never touch spark, pinning the fleet t/min
// readout at a constant ~8000/agent. Assistant usage now feeds updateSpark.

test('parseEvent: assistant usage updates the spark + lastTokRate', () => {
  const a = makeAgent({ lastTokSampleTs: 0 });
  parseEvent({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 8000, output_tokens: 0 },
    },
  }, a);
  assert.equal(a.spark.length, 15);
  assert.ok(a.lastTokRate > 0, 'rate derived from the usage token delta');
});

// ─── parseEvent: parallel sub-agent (Task/Workflow) tracking ──────────────────

function taskUse(id, input = {}) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Task', input }] } };
}
function toolResult(id) {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } };
}

test('subagents: Task tool_use adds a pending entry keyed by tool_use_id', () => {
  const a = makeAgent();
  parseEvent(taskUse('toolu_1', { description: 'deep research', subagent_type: 'Explore' }), a);
  assert.equal(a.pendingSubagents.size, 1);
  const e = a.pendingSubagents.get('toolu_1');
  assert.equal(e.label, 'deep research');
  assert.equal(e.type, 'Explore');
  assert.ok(e.startTs > 0);
});

test('subagents: matching tool_result removes the pending entry', () => {
  const a = makeAgent();
  parseEvent(taskUse('toolu_1'), a);
  parseEvent(toolResult('toolu_1'), a);
  assert.equal(a.pendingSubagents.size, 0);
});

test('subagents: parallel Task fan-out counts each concurrently; ends independently', () => {
  const a = makeAgent();
  parseEvent(taskUse('toolu_1', { description: 'a' }), a);
  parseEvent(taskUse('toolu_2', { description: 'b' }), a);
  parseEvent(taskUse('toolu_3', { description: 'c' }), a);
  assert.equal(a.pendingSubagents.size, 3);
  parseEvent(toolResult('toolu_2'), a);
  assert.equal(a.pendingSubagents.size, 2);
  assert.ok(a.pendingSubagents.has('toolu_1') && a.pendingSubagents.has('toolu_3'));
});

test('subagents: Workflow tool_use is tracked with a workflow label/type', () => {
  const a = makeAgent();
  parseEvent({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input: { name: 'review-changes' } },
  ] } }, a);
  const e = a.pendingSubagents.get('toolu_wf');
  assert.equal(e.label, 'review-changes');
  assert.equal(e.type, 'workflow');
});

test('subagents: non-fan-out tools (Bash, Read) are not tracked', () => {
  const a = makeAgent();
  parseEvent({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'ls' } },
  ] } }, a);
  assert.equal(a.pendingSubagents === undefined || a.pendingSubagents.size === 0, true);
});

test('subagents: /clear clears the pending map', () => {
  const a = makeAgent();
  parseEvent(taskUse('toolu_1'), a);
  assert.equal(a.pendingSubagents.size, 1);
  parseEvent({ type: 'user', message: { role: 'user',
    content: '<command-name>/clear</command-name>' } }, a);
  assert.equal(a.pendingSubagents.size, 0);
});

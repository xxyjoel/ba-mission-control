// tests/bgShellJobs.test.mjs — 0483: background shell jobs reach the card.
//
// outbound-orchestrator, 2026-11-12: two background Bash jobs ran for 36 and
// 26 minutes after claude's turn ended. The card read IDLE with nothing else,
// because mc counted background AGENTS only. These tests feed the record
// shapes claude writes (taken from that session's log, with made-up ids,
// labels and paths) through the real parser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEvent } from '../server/jsonlConnector.mjs';
import {
  jobIdFromStart, finishedJobs, jobsSnapshot, parseProcessRows, parseEtime,
  shellCandidates, parseShellArgs, matchShells, visibleJobs, sampleClaudeShells,
} from '../server/bgShellJobs.mjs';
import { startSessionTailer, claudeProjectDir } from '../server/sessionFileTailer.mjs';
import { PtyAgent } from '../server/ptyAgent.mjs';

const makeAgent = () => ({
  status: 'idle', activity: '', tail: [], todos: [], tokensIn: 0, tokensOut: 0,
  tokensCacheRead: 0, context: 0, costSession: 0, lastEventTs: 0, lastConnectorTs: 0,
});

// ── record shapes ─────────────────────────────────────────────────────────
const ts = () => new Date().toISOString();
const bashUse = (useId, input) => ({
  type: 'assistant', timestamp: ts(),
  message: { model: 'claude-opus-5-5', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: useId, name: 'Bash', input }] },
});
const toolUse = (useId, name, input) => ({
  type: 'assistant', timestamp: ts(),
  message: { model: 'claude-opus-5-5', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: useId, name, input }] },
});
const toolResult = (useId, text) => ({
  type: 'user', timestamp: ts(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: text }] },
});
const startReceipt = (jobId) =>
  `Command running in background with ID: ${jobId}. Output is being written to: /tmp/mc-test/tasks/${jobId}.output`;
const notice = (jobId, status = 'completed') => [
  '<task-notification>',
  `<task-id>${jobId}</task-id>`,
  '<tool-use-id>toolu_test0001</tool-use-id>',
  `<output-file>/tmp/mc-test/tasks/${jobId}.output</output-file>`,
  `<status>${status}</status>`,
  '<summary>Background command "Sync the sample rows" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n');
// claude idle: the notice is a user record and starts a turn.
const idleFinish = (jobId, status) => ({
  type: 'user', timestamp: ts(), message: { role: 'user', content: notice(jobId, status) },
});
// claude busy: the notice is queued, then repeated as an attachment.
const queuedFinish = (jobId, status) => ({
  type: 'queue-operation', operation: 'enqueue', timestamp: ts(), sessionId: 'sid', content: notice(jobId, status),
});
const attachmentFinish = (jobId, status) => ({
  type: 'attachment', timestamp: ts(),
  attachment: { type: 'queued_command', prompt: notice(jobId, status), commandMode: 'task-notification' },
});

function startJob(agent, useId, jobId, input = { command: 'python3 sync.py', description: 'Sync the sample rows', run_in_background: true }) {
  parseEvent(bashUse(useId, input), agent);
  parseEvent(toolResult(useId, startReceipt(jobId)), agent);
}

// ── parsers ───────────────────────────────────────────────────────────────
test('start receipts: all five wordings, anchored to the start of the text', () => {
  // 0485: the five templates in claude 2.1.322, read 2026-11-17.
  assert.equal(jobIdFromStart(startReceipt('bjob00001')), 'bjob00001');
  assert.equal(jobIdFromStart('Command was manually backgrounded by user with ID: bjob00002'), 'bjob00002');
  assert.equal(jobIdFromStart('Command was moved to the background (ID: bjob00004) after running for 180s. Output is being written to: /tmp/x'), 'bjob00004');
  assert.equal(jobIdFromStart('Command was moved to the background (ID: bjob00005) so that a message that arrived while it was running can reach you; it'), 'bjob00005');
  assert.equal(jobIdFromStart('Command did not complete within its 120s timeout and was moved to the background (ID: bjob00006). Output is being written to: /tmp/x'), 'bjob00006');
  assert.equal(jobIdFromStart('MCP tool "x" was moved to the background as task bjob00008'), null, 'an MCP task has no shell');
  assert.equal(jobIdFromStart(`log line\n${startReceipt('bjob00003')}`), null, 'a quote mid-text is not a start');
  assert.equal(jobIdFromStart(undefined), null);
});

test('finish notices: anchored, every block read, "running" is not a finish', () => {
  assert.deepEqual(finishedJobs(notice('bjob00001')), [{ id: 'bjob00001', status: 'completed' }]);
  assert.deepEqual(finishedJobs(`${notice('bjob00001', 'failed')}\n${notice('bjob00002', 'killed')}`),
    [{ id: 'bjob00001', status: 'failed' }, { id: 'bjob00002', status: 'killed' }]);
  assert.deepEqual(finishedJobs(notice('bjob00001', 'running')), []);
  assert.deepEqual(finishedJobs(`grep output:\n${notice('bjob00001')}`), [], 'a quote mid-text is not a finish');
});

// ── parseEvent ────────────────────────────────────────────────────────────
test('a background Bash call adds a job labelled with its description', () => {
  const a = makeAgent();
  startJob(a, 'toolu_a1', 'bjob00001');
  assert.equal(a.bgJobs.size, 1);
  assert.equal(a.bgJobs.get('bjob00001').label, 'Sync the sample rows');
});

test('the idle-shape notice ends the job and notes it in the fleet log', () => {
  const a = makeAgent();
  startJob(a, 'toolu_a1', 'bjob00001');
  parseEvent(idleFinish('bjob00001'), a);
  assert.equal(a.bgJobs.size, 0);
  assert.ok(a.tail.some((e) => e.kind === 'sys' && e.text === 'background job completed: Sync the sample rows'));
});

test('the busy-shape notice ends the job; the repeat is harmless; clocks do not move', () => {
  const a = makeAgent();
  startJob(a, 'toolu_a1', 'bjob00001');
  startJob(a, 'toolu_a2', 'bjob00002');
  a.lastEventTs = 111; a.lastConnectorTs = 222;
  const tailBefore = a.tail.length;
  assert.equal(parseEvent(queuedFinish('bjob00001'), a), true, 'a job ended: the card must redraw');
  assert.equal(parseEvent(attachmentFinish('bjob00001'), a), false, 'the same finish again changes nothing');
  assert.deepEqual([...a.bgJobs.keys()], ['bjob00002']);
  assert.equal(a.tail.length, tailBefore + 1, 'one fleet-log line, not two');
  // 0394: these record types must never look like transcript activity.
  assert.equal(a.lastEventTs, 111);
  assert.equal(a.lastConnectorTs, 222);
  parseEvent(attachmentFinish('bjob00002', 'failed'), a);
  assert.equal(a.bgJobs.size, 0, 'the attachment alone also ends a job');
});

test('quoted receipts and notices never start or end a job', () => {
  const a = makeAgent();
  // A foreground Bash call whose output quotes another session's log.
  parseEvent(bashUse('toolu_q1', { command: 'grep -r task-notification ~/.claude' }), a);
  parseEvent(toolResult('toolu_q1', `match: ${startReceipt('bjob09999')}\nmatch: ${notice('bjob09999')}`), a);
  assert.equal(a.bgJobs?.size ?? 0, 0, 'a quote mid-output is not a start');
  // A start receipt answering a call that was not Bash.
  parseEvent(toolUse('toolu_q2', 'Read', { file_path: '/tmp/x' }), a);
  parseEvent(toolResult('toolu_q2', startReceipt('bjob09998')), a);
  assert.equal(a.bgJobs?.size ?? 0, 0, 'only a Bash call can start a shell job');
  // A real job, then a tool_result and a reply that quote its finish notice.
  startJob(a, 'toolu_q3', 'bjob00001');
  parseEvent(bashUse('toolu_q4', { command: 'cat notes.txt' }), a);
  parseEvent(toolResult('toolu_q4', notice('bjob00001')), a);
  parseEvent({ type: 'assistant', timestamp: ts(), message: { model: 'claude-opus-5-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: notice('bjob00001') }] } }, a);
  assert.equal(a.bgJobs.size, 1, 'a tool result or a reply that quotes a notice does not end the job');
});

test('a "running" progress notice keeps the job', () => {
  const a = makeAgent();
  startJob(a, 'toolu_a1', 'bjob00001');
  parseEvent(queuedFinish('bjob00001', 'running'), a);
  assert.equal(a.bgJobs.size, 1);
});

test('TaskStop ends the job it names (a stop leaves no finish notice)', () => {
  const a = makeAgent();
  startJob(a, 'toolu_a1', 'bjob00001');
  parseEvent(toolUse('toolu_a2', 'TaskStop', { task_id: 'bjob00001' }), a);
  assert.equal(a.bgJobs.size, 0);
});

test('a command the user backgrounds by hand counts too', () => {
  const a = makeAgent();
  parseEvent(bashUse('toolu_a1', { command: 'npm test' }), a);
  parseEvent(toolResult('toolu_a1', 'Command was manually backgrounded by user with ID: bjob00007'), a);
  assert.equal(a.bgJobs.get('bjob00007')?.label, 'npm test', 'no description: the command is the label');
});

test('a job older than 30 minutes still shows', () => {
  const now = Date.now();
  const jobs = new Map([['bjob00001', { label: 'long sync', startTs: now - 40 * 60_000 }]]);
  assert.deepEqual(jobsSnapshot(jobs, now), [{ id: 'bjob00001', label: 'long sync', elapsedMs: 40 * 60_000 }]);
});

// ── start time (0485) ─────────────────────────────────────────────────────
test('a job starts at its Bash call, not at its receipt', () => {
  // The slot 3 shape: the command ran 180 s, then claude moved it to the
  // background. Its shell started with the call, 3 minutes before the receipt.
  const a = makeAgent();
  const use = bashUse('toolu_t1', { command: 'until grep -q stream run.log; do sleep 15; done', description: 'Wait for the probe' });
  use.timestamp = '2026-11-15T00:47:29.749Z';
  const res = toolResult('toolu_t1', 'Command was moved to the background (ID: bw4uzcp1y) after running for 180s. Output is being written to: /tmp/x');
  res.timestamp = '2026-11-15T00:50:30.307Z';
  parseEvent(use, a);
  parseEvent(res, a);
  const j = a.bgJobs.get('bw4uzcp1y');
  assert.equal(j.label, 'Wait for the probe');
  assert.equal(j.startTs, Date.parse('2026-11-15T00:47:29.749Z'));
  assert.equal(j.resultTs, Date.parse('2026-11-15T00:50:30.307Z'));
});

// ── process check (0484) ──────────────────────────────────────────────────
// Made-up pids and paths in the shape seen on 2026-11-17: claude 5000 with two
// Bash shells (one with a python job under it), an MCP server and caffeinate;
// a second claude 7000 whose only shell child is a hook's `bash <script>`.
const PS_ROWS = [
  '  100     1 40-14:20:22 node',
  ' 5000   100 07-21:31:00 claude',
  ' 5001  5000 02-18:12:45 /bin/zsh',
  ' 5002  5001 02-18:12:44 /usr/bin/python3',
  ' 5003  5000 02-18:11:03 /bin/zsh',
  ' 5005  5000 07-21:31:00 /Users/someone/.local/share/uv/tools/steward/bin/python',
  ' 5006  5000    01:10 caffeinate',
  ' 7000   100 07-21:30:58 claude',
  ' 7001  7000    00:23 bash',
  ' 6000   100    12:00 -zsh',
].join('\n');
const ARGS_ROWS = [
  " 5001 /bin/zsh -c source /Users/someone/.claude/shell-snapshots/snapshot-zsh-1794329299050-abc.sh 2>/dev/null || true && eval 'until grep -q stream run.log; do sleep 10; done' < /dev/null && pwd -P >| /tmp/claude-1-cwd",
  " 5003 /bin/zsh -c source /Users/someone/.claude/shell-snapshots/snapshot-zsh-1794329299050-abc.sh 2>/dev/null || true && eval 'until grep -q stream run.log; do sleep 15; done' < /dev/null && pwd -P >| /tmp/claude-2-cwd",
  ' 7001 bash /Users/someone/hooks/score-session.sh',
].join('\n');
const D = (s) => parseEtime(s);

test('ps elapsed time parses in all its forms', () => {
  assert.equal(parseEtime('02-18:12:45'), ((2 * 24 + 18) * 3600 + 12 * 60 + 45) * 1000);
  assert.equal(parseEtime('1:02:03'), 3723_000);
  assert.equal(parseEtime('00:42'), 42_000);
  assert.equal(parseEtime('junk'), null);
});

test('ps rows keep a command path that contains spaces', () => {
  const rows = parseProcessRows(' 7 1 01:00 /Applications/My App.app/Contents/MacOS/My App\n junk line\n');
  assert.deepEqual(rows, [{ pid: 7, ppid: 1, etimeMs: 60_000, comm: '/Applications/My App.app/Contents/MacOS/My App' }]);
});

test('only shells that are direct children of a claude are candidates', () => {
  const now = Date.now();
  const c = shellCandidates(parseProcessRows(PS_ROWS), [5000, 7000, 4242], now);
  assert.deepEqual(c.get(5000), [
    { pid: 5001, startTs: now - D('02-18:12:45') },
    { pid: 5003, startTs: now - D('02-18:11:03') },
  ], 'not the python under a shell, the MCP server, caffeinate or the login shell');
  assert.deepEqual(c.get(7000), [{ pid: 7001, startTs: now - 23_000 }]);
  assert.equal(c.has(4242), false, 'a claude missing from ps gets no entry: no evidence');
});

test("only claude's own Bash shells pass the argument test", () => {
  assert.deepEqual([...parseShellArgs(ARGS_ROWS)].sort(), [5001, 5003], "a hook's bash script is not a job");
});

test('sampleClaudeShells: two ps calls, names then arguments of the shells only', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return args[0] === '-A' ? PS_ROWS : ARGS_ROWS; };
  const got = await sampleClaudeShells([5000, 7000], run);
  assert.deepEqual(calls[1], ['-o', 'pid=,args=', '-p', '5001,5003,7001']);
  assert.deepEqual(got.get(5000).map((s) => s.pid), [5001, 5003]);
  assert.deepEqual(got.get(7000), []);
  assert.equal(await sampleClaudeShells([5000], async () => null), null, 'a failed ps changes nothing');
});

test('match: each tracked job keeps its own shell; leftovers are untracked', () => {
  const t0 = Date.parse('2026-11-15T00:45:47.037Z');
  const jobs = new Map([
    ['bepkse8ao', { label: 'Wait until the probe run reports back', startTs: t0, resultTs: t0 + 137 }],
    ['bw4uzcp1y', { label: 'Wait for the probe run', startTs: t0 + 102_712, resultTs: t0 + 283_270 }],
  ]);
  // ps start times are whole seconds, so up to 1 s after the real start.
  const shells = [{ pid: 5003, startTs: t0 + 102_963 }, { pid: 5001, startTs: t0 + 963 }, { pid: 5009, startTs: t0 + 50_000 }];
  const m = matchShells(jobs, shells, t0 + 3600_000);
  assert.deepEqual(m.ended, []);
  assert.deepEqual(m.untracked, [{ pid: 5009, startTs: t0 + 50_000 }]);
});

test('match: a job with no shell has ended, unless its receipt is newer than the check', () => {
  const sampleStart = Date.now();
  const jobs = new Map([
    ['stopped', { label: 'stopped from the task list', startTs: sampleStart - 60_000, resultTs: sampleStart - 59_900 }],
    ['fresh', { label: 'started while ps ran', startTs: sampleStart - 200, resultTs: sampleStart + 5 }],
  ]);
  assert.deepEqual(matchShells(jobs, [], sampleStart).ended, ['stopped']);
});

test('match: a shell is claimed once, by the job that started closest to it', () => {
  const t = 1_000_000;
  const jobs = new Map([
    ['a', { label: 'a', startTs: t, resultTs: t + 100 }],
    ['b', { label: 'b', startTs: t + 1500, resultTs: t + 1600 }],
  ]);
  const m = matchShells(jobs, [{ pid: 2, startTs: t + 2000 }, { pid: 1, startTs: t + 1000 }], t + 60_000);
  assert.deepEqual(m.ended, []);
  assert.deepEqual(m.untracked, []);
});

test('visible jobs: untracked shells show only when claude is done and old enough', () => {
  const now = Date.now();
  const tracked = [{ id: 'bjob00001', label: 'Sync the sample rows', elapsedMs: 120_000 }];
  const untracked = [{ pid: 5001, startTs: now - 600_000 }, { pid: 5003, startTs: now - 2000 }];
  assert.deepEqual(visibleJobs(tracked, untracked, { countUntracked: false, now }), tracked);
  assert.deepEqual(visibleJobs(tracked, untracked, { countUntracked: true, now }), [
    { id: 'pid:5001', label: null, elapsedMs: 600_000 },
    tracked[0],
  ], 'oldest first; a 2-second-old shell may be a turn just ending');
});

test('slot 3, 2026-11-17: two wait loops a finished sub-agent left show as 2 jobs', async () => {
  // The owner's screenshot: claude said "2 shells", mc said IDLE and nothing
  // else. The main log had 0 open jobs (86 started, 86 ended); both loops were
  // started by a sub-agent. Pids and elapsed times are the captured ones.
  const rows = [
    '52463     1 07-21:31:04 node',
    '52678 52463 07-21:31:00 claude',
    ' 6295 52678 02-18:12:45 /bin/zsh',
    '12876 52678 02-18:11:03 /bin/zsh',
    '53260 52678 07-21:30:58 /Users/someone/.local/share/uv/tools/steward/bin/python',
  ].join('\n');
  const args = ARGS_ROWS.replace(' 5001 ', ' 6295 ').replace(' 5003 ', '12876 ');
  const shells = await sampleClaudeShells([52678], async (a) => (a[0] === '-A' ? rows : args));
  const now = Date.now();
  const { ended, untracked } = matchShells(new Map(), shells.get(52678), now);
  assert.deepEqual(ended, []);
  const shown = visibleJobs([], untracked, { countUntracked: true, now });
  assert.equal(shown.length, 2);
  assert.ok(Math.abs(shown[0].elapsedMs - D('02-18:12:45')) < 5000, 'aged about 2 days 18 hours');
});

// ── agent ─────────────────────────────────────────────────────────────────
test('the agent reports its jobs, and a new claude process starts with none', () => {
  const a = new PtyAgent({
    slot: 4, id: 's4', name: 'repo', cwd: '/tmp/mc-bgjobs-repo', model: 'opus-5.5',
    permissionMode: 'auto', sessionId: '1b2c3d4e-0000-4000-8000-000000000483',
  });
  a.pty = { pid: 1234, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
  try {
    startJob(a, 'toolu_a1', 'bjob00001');
    // The turn ends: claude's Stop hook, newer than the last log record.
    a.hookStatus = 'idle';
    a.hookStatusTs = Date.now() + 1000;
    const j = a.toJSON();
    assert.equal(j.status, 'idle', 'jobs never change the status word (0418)');
    assert.equal(j.shellJobs.length, 1);
    assert.equal(j.shellJobs[0].label, 'Sync the sample rows');
    // 0484: a shell no job claims (a sub-agent's job) shows once the turn is over.
    a.untrackedShells = [{ pid: 6295, startTs: Date.now() - 60_000 }];
    const k = a.toJSON().shellJobs;
    assert.equal(k.length, 2);
    assert.deepEqual(k.map((x) => x.label), [null, 'Sync the sample rows'], 'oldest first; no name for the untracked one');
    a.hookStatus = 'working';
    a.hookStatusTs = Date.now() + 2000;
    assert.equal(a.toJSON().status, 'working');
    assert.equal(a.toJSON().shellJobs.length, 1, 'while claude works, an unclaimed shell may be its own foreground command');
    a.onSpawned({ modelArg: 'claude-opus-5-5' });
    assert.deepEqual(a.toJSON().shellJobs, [], 'jobs die with the process that started them');
    assert.deepEqual(a.untrackedShells, []);
  } finally {
    a.kill?.();
  }
});

// ── startup replay ────────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('the startup replay never brings back a previous process\'s jobs; new ones count', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mc-bgjobs-'));
  const sessionId = `0a1b2c3d-4e5f-6789-abcd-${Date.now().toString(16).padEnd(12, '0').slice(0, 12)}`;
  const dir = claudeProjectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${sessionId}.jsonl`);
  const write = (recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  // History: a job the previous claude started and never reported finished.
  writeFileSync(filePath, write([
    bashUse('toolu_old', { command: 'sleep 999', run_in_background: true }),
    toolResult('toolu_old', startReceipt('bjob00old')),
  ]));
  const agent = new EventEmitter();
  Object.assign(agent, makeAgent(), {
    cwd, sessionId, resolvedModel: null, spawnedAt: Date.now(),
    appendTail(e) { this.tail.push({ ...e, ts: e.ts ?? Date.now() }); },
  });
  let afterPrime;
  let afterLive;
  const tailer = startSessionTailer({ agent, statPollMs: 50 });
  try {
    await sleep(250);
    afterPrime = agent.bgJobs?.size ?? 0;
    appendFileSync(filePath, write([
      bashUse('toolu_new', { command: 'sleep 5', description: 'Wait five seconds', run_in_background: true }),
      toolResult('toolu_new', startReceipt('bjob00new')),
    ]));
    await sleep(400);
    afterLive = agent.bgJobs ? [...agent.bgJobs.keys()] : [];
  } finally {
    tailer.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
  assert.equal(afterPrime, 0, 'a replayed start is history, not a live job');
  assert.deepEqual(afterLive, ['bjob00new']);
});

// ── wrapped notices (2026-11-17) ──────────────────────────────────────────
// claude sometimes delivers a finish notice behind a fixed header paragraph.
// 142 such notices were counted in 30 days of local logs.
const WRAP = '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT interpret this as user acknowledgement.\n\n';

test('a notice behind the system-notification header ends the job; a quote of it does not', () => {
  assert.deepEqual(finishedJobs(WRAP + notice('bjob00001', 'stopped')), [{ id: 'bjob00001', status: 'stopped' }]);
  assert.deepEqual(finishedJobs(WRAP.trim()), [], 'a header with no block is nothing');
  assert.deepEqual(finishedJobs(`log:\n${WRAP}${notice('bjob00001')}`), [], 'the header must open the text');
  const a = makeAgent();
  startJob(a, 'toolu_w1', 'bjob00001');
  startJob(a, 'toolu_w2', 'bjob00002');
  parseEvent(bashUse('toolu_w3', { command: 'cat old.log' }), a);
  parseEvent(toolResult('toolu_w3', WRAP + notice('bjob00002')), a);
  assert.equal(a.bgJobs.size, 2, 'a tool result that quotes a wrapped notice ends nothing');
  parseEvent({ type: 'user', timestamp: ts(), message: { role: 'user', content: WRAP + notice('bjob00001', 'stopped') } }, a);
  assert.deepEqual([...a.bgJobs.keys()], ['bjob00002']);
});

test('sub-agent records: queued notices end jobs; request copies are ignored', async () => {
  const { trackSubagentJobs } = await import('../server/bgShellJobs.mjs');
  const a = { bgJobs: new Map([['bjob00001', { label: 'x', startTs: 1, resultTs: 2 }], ['bjob00002', { label: 'y', startTs: 1, resultTs: 2 }]]) };
  assert.equal(trackSubagentJobs(a, { type: 'api-request-blob', message: { content: [{ type: 'text', text: notice('bjob00002') }] } }), false);
  assert.equal(a.bgJobs.size, 2, 'a copy of the model request never ends a job');
  assert.equal(trackSubagentJobs(a, attachmentFinish('bjob00001')), true);
  assert.equal(trackSubagentJobs(a, { type: 'user', message: { role: 'user', content: WRAP + notice('bjob00002', 'stopped') } }), true);
  assert.equal(a.bgJobs.size, 0);
});

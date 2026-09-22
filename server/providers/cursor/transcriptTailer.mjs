// server/providers/cursor/transcriptTailer.mjs — Cursor agent-transcripts JSONL.
//
// Cursor writes a thin JSONL ({role, message.content}) under
//   ~/.cursor/projects/*/agent-transcripts/<chatId>/<chatId>.jsonl
// Resolve by chatId glob — NEVER re-derive the cwd encoding (plan 0420).
// Optional meta at ~/.cursor/chats/<md5(cwd)>/<chatId>/meta.json.
//
// drive:'external' — Fleet's shared tailerTick() calls tick(); no private timer.

import { createHash } from 'node:crypto';
import {
  existsSync, readdirSync, readFileSync, openSync, readSync, closeSync, fstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pushTail } from '../../jsonlConnector.mjs';
import { summarizeToolInput, SUBAGENT_TOOLS, subagentLabel } from '../../eventShapes.mjs';

const SUBAGENT_STALE_MS = 30 * 60 * 1000;
const PENDING_SUBAGENT_MAX = 32;

function md5(s) {
  return createHash('md5').update(String(s)).digest('hex');
}

// findTranscriptPath — walk ~/.cursor/projects/*/agent-transcripts/<id>/<id>.jsonl
export function findTranscriptPath(chatId, { homeDir = homedir() } = {}) {
  if (!chatId) return null;
  const root = join(homeDir, '.cursor', 'projects');
  if (!existsSync(root)) return null;
  let names;
  try { names = readdirSync(root); } catch { return null; }
  for (const enc of names) {
    const p = join(root, enc, 'agent-transcripts', chatId, `${chatId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

export function metaPath(cwd, chatId, { homeDir = homedir() } = {}) {
  if (!cwd || !chatId) return null;
  return join(homeDir, '.cursor', 'chats', md5(cwd), chatId, 'meta.json');
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const p of content) {
    if (typeof p === 'string') text += p;
    else if (p?.type === 'text' && typeof p.text === 'string') text += p.text;
  }
  text = text.trim();
  return text || null;
}

// Prefer the <user_query> body when present (Cursor wraps prompts that way).
function surfaceUserText(raw) {
  if (!raw) return null;
  const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(raw);
  const body = (m ? m[1] : raw).trim();
  return body || null;
}

function firstLine(text, maxLen = 200) {
  if (!text) return '';
  const line = text.split('\n').find((l) => l.trim()) || text;
  return line.slice(0, maxLen);
}

function isRedactedOnly(text) {
  return !text || /^\[REDACTED\]\s*$/i.test(text.trim());
}

// Resolve the effective tool name: CallDynamicTool → input.toolName, else name.
function effectiveTool(part) {
  if (!part || part.type !== 'tool_use' || typeof part.name !== 'string') return null;
  if (part.name === 'CallDynamicTool' && part.input?.toolName) {
    return {
      name: String(part.input.toolName),
      input: part.input.arguments || part.input.input || {},
      id: typeof part.id === 'string' ? part.id : null,
      via: 'CallDynamicTool',
    };
  }
  return { name: part.name, input: part.input || {}, id: typeof part.id === 'string' ? part.id : null };
}

function trackSubagent(agent, tool) {
  if (!SUBAGENT_TOOLS.has(tool.name) && tool.name !== 'Task') return;
  const map = (agent.pendingSubagents ??= new Map());
  const cutoff = Date.now() - SUBAGENT_STALE_MS;
  for (const [id, s] of map) if ((s?.startTs ?? 0) < cutoff) map.delete(id);
  const id = tool.id || `cursor-sub-${map.size}-${Date.now()}`;
  map.set(id, {
    label: subagentLabel(tool.name === 'Task' ? 'Task' : tool.name, tool.input),
    type: tool.input?.subagent_type || 'agent',
    startTs: Date.now(),
  });
  while (map.size > PENDING_SUBAGENT_MAX) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function applyTodos(agent, todos) {
  if (!Array.isArray(todos)) return;
  agent.todos = todos
    .filter((t) => t && typeof t.content === 'string')
    .map((t) => ({
      content: String(t.content).slice(0, 200),
      status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
      activeForm: typeof t.activeForm === 'string' ? t.activeForm.slice(0, 200) : '',
    }));
}

function appendFn(agent, entry) {
  if (typeof agent.appendTail === 'function') agent.appendTail(entry);
  else pushTail(agent, entry);
}

export function parseCursorLine(raw, agent) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return false; }
  if (!ev || typeof ev !== 'object') return false;

  if (ev.type === 'turn_ended') {
    agent.status = ev.status === 'error' ? 'error' : 'idle';
    agent.lastConnectorTs = Date.now();
    agent.lastEventTs = Date.now();
    return true;
  }

  const role = ev.role;
  if (role !== 'user' && role !== 'assistant') return false;
  const content = ev.message?.content;
  let changed = false;

  if (role === 'user') {
    const text = surfaceUserText(extractText(content));
    if (text && !isRedactedOnly(text)) {
      appendFn(agent, { kind: 'user', text: text.slice(0, 8000), preview: firstLine(text, 240) });
      agent.activity = firstLine(text, 200);
      agent.messageCount = (agent.messageCount || 0) + 1;
      agent.turnCount = (agent.turnCount || 0) + 1;
      agent.status = 'working';
      changed = true;
    }
  } else {
    // assistant: text + tool_use parts
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && !isRedactedOnly(part.text)) {
          const text = part.text.trim();
          if (!text) continue;
          appendFn(agent, { kind: 'asst', text: text.slice(0, 8000), preview: firstLine(text, 240) });
          agent.activity = firstLine(text, 200);
          agent.messageCount = (agent.messageCount || 0) + 1;
          changed = true;
        } else if (part?.type === 'tool_use') {
          const tool = effectiveTool(part);
          if (!tool) continue;
          const summary = summarizeToolInput(tool.name, tool.input);
          appendFn(agent, { kind: 'tool', tool: tool.name, text: summary });
          agent.activity = `${tool.name}: ${summary}`.slice(0, 200);
          agent.status = 'working';
          if (tool.name === 'TodoWrite' && Array.isArray(tool.input?.todos)) {
            applyTodos(agent, tool.input.todos);
          }
          if (SUBAGENT_TOOLS.has(tool.name) || tool.name === 'Task') {
            trackSubagent(agent, tool);
          }
          changed = true;
        }
      }
    } else {
      const text = extractText(content);
      if (text && !isRedactedOnly(text)) {
        appendFn(agent, { kind: 'asst', text: text.slice(0, 8000), preview: firstLine(text, 240) });
        agent.activity = firstLine(text, 200);
        changed = true;
      }
    }
  }

  if (changed) {
    agent.lastConnectorTs = Date.now();
    agent.lastEventTs = Date.now();
  }
  return changed;
}

function readMeta(agent, { homeDir }) {
  const p = metaPath(agent.cwd, agent.sessionId, { homeDir });
  if (!p || !existsSync(p)) return;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof j.createdAtMs === 'number' && agent.sessionStartedAt == null) {
      agent.sessionStartedAt = j.createdAtMs;
    }
    if (typeof j.title === 'string' && j.title && !agent.name) {
      agent.name = j.title.slice(0, 80);
    }
  } catch { /* meta is best-effort */ }
}

export function startCursorTranscriptTailer({
  agent,
  homeDir = homedir(),
  drive = 'external',
  pollMs = 1500,
} = {}) {
  if (!agent) throw new Error('cursorTranscriptTailer: agent is required');

  let stopped = false;
  let path = null;
  let offset = 0;
  let buffer = '';
  let fd = null;
  let pollTimer = null;

  function ensureOpen() {
    if (fd != null) return true;
    path = findTranscriptPath(agent.sessionId, { homeDir });
    if (!path) return false;
    try {
      fd = openSync(path, 'r');
      offset = 0;
      buffer = '';
      return true;
    } catch {
      fd = null;
      return false;
    }
  }

  function readNew() {
    readMeta(agent, { homeDir });
    if (!ensureOpen()) return false;
    let st;
    try { st = fstatSync(fd); } catch { return false; }
    if (st.size < offset) {
      // truncated / rotated — reopen from start
      try { closeSync(fd); } catch {}
      fd = null;
      if (!ensureOpen()) return false;
      try { st = fstatSync(fd); } catch { return false; }
    }
    if (st.size === offset) return false;
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    let got = 0;
    try { got = readSync(fd, buf, 0, len, offset); } catch { return false; }
    offset += got;
    buffer += buf.toString('utf8', 0, got);
    let changed = false;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      if (parseCursorLine(line, agent)) changed = true;
    }
    if (changed) {
      try { agent.emit?.('change'); } catch {}
    }
    return changed;
  }

  function tick() {
    if (stopped) return;
    try { readNew(); } catch {}
  }

  function stop() {
    stopped = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (fd != null) { try { closeSync(fd); } catch {} fd = null; }
  }

  // Prime once; external drive waits for Fleet tick, self owns an interval.
  tick();
  if (drive !== 'external') {
    pollTimer = setInterval(tick, pollMs);
    pollTimer.unref?.();
  }

  return { tick, stop, get path() { return path; } };
}

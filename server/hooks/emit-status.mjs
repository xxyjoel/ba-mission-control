#!/usr/bin/env node
// server/hooks/emit-status.mjs — claude hook script: append one NDJSON line per event.
//
// claude runs this synchronously per hook event. It MUST be fast and MUST
// exit 0 unconditionally — any failure would block the agent turn.
//
// stdin:  JSON hook payload from claude ({ hook_event_name, session_id, … })
// output: one NDJSON line appended to statusFilePath({sessionId})
// deps:   node builtins only + server/statusFile.mjs (no npm)

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { statusFilePath } from '../statusFile.mjs';

async function main() {
  // Read ALL of stdin before parsing — claude may write the payload in chunks.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();

  if (!raw) return; // empty stdin → nothing to write

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Malformed JSON → write nothing, exit 0.
    return;
  }

  const { hook_event_name: event, session_id, notification_type, tool_name, agent_id, agent_type } = payload;

  if (!session_id || !event) return; // missing required fields → write nothing

  let filePath;
  try {
    filePath = statusFilePath({ sessionId: session_id });
  } catch {
    // Non-UUID session_id — UUID guard threw; swallow and exit 0.
    return;
  }

  // Ensure the parent directory exists (first run, or new machine).
  mkdirSync(dirname(filePath), { recursive: true });

  const record = { ts: Date.now(), session_id, event };
  if (notification_type !== undefined) record.notification_type = notification_type;
  // Pre/PostToolUse carry the tool — the tailer needs it to clear a pending
  // ask the instant its PostToolUse (answer received) lands (0390).
  if (typeof tool_name === 'string') record.tool_name = tool_name.slice(0, 80);
  // 0395: SUBAGENT tool events carry agent_id/agent_type; main-thread events
  // don't (verified against live payloads 2026-08-29). Tag them so the tailer
  // can keep a busy subagent from masking the main thread's status — a
  // background agent's PreToolUse burst was overwriting 'waiting' back to
  // 'working' while a permission box sat on screen (focus-duck).
  if (agent_id !== undefined || agent_type !== undefined) record.sub = true;

  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

main().catch(() => {}).finally(() => process.exit(0));

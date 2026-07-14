// server/hookSettings.mjs — build the Claude Code hooks settings block.
//
// Returns a plain settings object wiring Notification, PreToolUse, and Stop
// to the MC hook emitter. The object is CONSTANT given emitterPath — no
// per-session data (session_id reaches the emitter via hook stdin, not here).
//
// Shape:
//   { hooks: { <Event>: [ { hooks: [ { type:"command", command, timeout } ] } ] } }

/**
 * Build the hooks settings block for injection into claude --settings.
 *
 * @param {{ emitterPath: string }} opts  absolute path to the hook emitter script
 * @returns {{ hooks: object }}           plain settings object, constant for this emitterPath
 */
export function buildHookSettings({ emitterPath }) {
  // Use the running node binary so no PATH lookup is needed at hook time.
  // process.execPath is an absolute path and always contains "node" in the name.
  // Quote both paths so a home/install dir containing spaces isn't shell-split
  // by claude's hook runner (which invokes `command` through a shell).
  const command = `"${process.execPath}" "${emitterPath}"`;

  // Single command hook entry reused across all three events.
  // timeout is in seconds; 5 is the max allowed by the test (range 1–5).
  const commandHook = { type: 'command', command, timeout: 5 };

  // Notification uses an empty matcher so it fires on all notification types.
  const notificationGroup = { matcher: '', hooks: [commandHook] };
  const defaultGroup = { hooks: [commandHook] };

  return {
    hooks: {
      Notification: [notificationGroup],
      // UserPromptSubmit flips the card to 'working' the instant a turn starts.
      // Without it, a thinking/text-only turn (no tool call → no PreToolUse) stays
      // parked on the prior Stop→idle until the JSONL connector catches a streamed
      // event, so an actively-working session reads 'idle' for seconds.
      UserPromptSubmit: [defaultGroup],
      PreToolUse: [defaultGroup],
      Stop: [defaultGroup],
    },
  };
}

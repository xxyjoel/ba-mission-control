// tui/lib/killTarget.js — resolve a `:kill` / `:kill!` command to a target.
//
// Fixes two release blockers in the command bar:
//  - B1 (destructive): an out-of-range / typo'd slot number must NEVER silently
//    retarget the FOCUSED session. The old inline parser fell back to the
//    focused agent for any n outside 1..slots, so `:kill !99` instantly killed
//    the focused session with no confirm. We reject out-of-range instead
//    (mirroring `:goto`).
//  - M3: the `:kill!` verb form (bang on the command word) — which the arm-toast
//    tells users to type — must be recognized as a force-kill, exactly like the
//    `:kill !n` (bang-on-arg) form.
//
// Rules:
//   :kill              → focused session, armed confirm      → { force:false, slot:focusedSlot }
//   :kill <n>          → slot n (1..slots), armed confirm    → { force:false, slot:n }
//   :kill! / :kill !   → force (skip confirm)                → { force:true,  ... }
//   :kill! <n> / :kill !<n> → force that slot                → { force:true,  slot:n }
//   out-of-range / non-numeric arg                           → { slot:null, error }
export function resolveKillTarget(cmd, arg, { focusedSlot, slots = 10 } = {}) {
  const raw = String(arg == null ? '' : arg).trim();
  const argBang = raw.startsWith('!');
  const force = cmd === 'kill!' || argBang;
  const slotStr = (argBang ? raw.slice(1) : raw).trim();
  if (slotStr === '') {
    // No slot given → operate on the focused session (the classic `:kill` / K).
    return { force, slot: focusedSlot ?? null, error: null };
  }
  const n = Number(slotStr);
  if (!Number.isInteger(n) || n < 1 || n > slots) {
    return {
      force,
      slot: null,
      error: `slot out of range — use :kill <1-${slots}> or :kill for the focused session`,
    };
  }
  return { force, slot: n, error: null };
}

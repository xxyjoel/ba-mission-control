// tui/lib/slots.js — where does a new session go?
//
// The grid renders live cards in slot order (App.jsx filters empties out and
// keeps the rest by slot index). Historically "new session" picked the
// LOWEST-indexed empty slot, so killing a middle slot left a hole that the
// next launch backfilled — the new card popped into the MIDDLE of the grid,
// not the bottom of the active set (user report, 2026-07-06).
//
// nextLaunchSlot appends instead: it returns the first empty slot ABOVE the
// highest occupied slot, so a launch lands at the bottom of the active cards
// in the common case. It falls back to the lowest empty slot only when there
// is no room to append (holes below a still-occupied top slot), so caps stay
// fully usable. Slot index still equals the digit hotkey (1-9,0) — we change
// WHICH empty slot we pick, not the render order.

export function nextLaunchSlot(agents) {
  const empties = (agents || [])
    .filter((a) => a.status === 'empty')
    .map((a) => a.slot)
    .sort((x, y) => x - y);
  if (empties.length === 0) return null;
  const occupied = (agents || [])
    .filter((a) => a.status !== 'empty')
    .map((a) => a.slot);
  const maxOccupied = occupied.length ? Math.max(...occupied) : 0;
  // Prefer appending below the last active session; else fill the lowest hole.
  const append = empties.find((s) => s > maxOccupied);
  return append ?? empties[0];
}

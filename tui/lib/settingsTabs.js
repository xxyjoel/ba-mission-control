// tui/lib/settingsTabs.js — which Settings tab labels fit in the strip.
//
// The strip is one nowrap row. At the default modal width (~92) nine titles
// cannot all fit, so Yoga used to clip mid-glyph ("NOTES" → "NOT"). Keep the
// active tab fully visible by sliding a window over the schema.

/** Display width of one tab chip including the trailing gap (except the last). */
export function tabChipWidth(schema, index) {
  const t = schema[index];
  if (!t) return 0;
  const label = `[${index + 1}] ${t.title}`;
  const gap = index < schema.length - 1 ? 2 : 0;
  return label.length + gap;
}

/**
 * Inclusive [lo, hi] window of tab indices that fits in `avail` cells and
 * always includes `activeIdx`. Grows toward the nearer end first so early
 * tabs stay put when the user is still on GENERAL…SAFETY.
 */
export function visibleTabRange(schema, activeIdx, avail) {
  const n = schema?.length || 0;
  if (n === 0) return { lo: 0, hi: -1 };
  const active = Math.max(0, Math.min(n - 1, activeIdx | 0));
  const budget = Math.max(1, avail | 0);

  let lo = active;
  let hi = active;
  let used = tabChipWidth(schema, active);
  // If the active chip alone is wider than the strip, still show only it.
  if (used > budget) return { lo: active, hi: active };

  const widthAt = (i) => tabChipWidth(schema, i);

  while (lo > 0 || hi < n - 1) {
    const leftW = lo > 0 ? widthAt(lo - 1) : Infinity;
    const rightW = hi < n - 1 ? widthAt(hi + 1) : Infinity;
    const canLeft = lo > 0 && used + leftW <= budget;
    const canRight = hi < n - 1 && used + rightW <= budget;
    if (!canLeft && !canRight) break;
    // Prefer expanding the side that keeps the window centered on active;
    // tie-break toward the end so NOTES/SUBSCRIPTIONS become reachable.
    const leftBias = active - (lo - 1);
    const rightBias = (hi + 1) - active;
    if (canRight && (!canLeft || rightBias <= leftBias)) {
      hi += 1;
      used += rightW;
    } else if (canLeft) {
      lo -= 1;
      used += leftW;
    } else {
      break;
    }
  }
  return { lo, hi };
}

// tui/lib/cursorUsage.js — live fleet ↔ Cursor dashboard usage poller.

import { createUsagePoller } from '../../server/providers/cursor/usageSync.mjs';
import { getCursorSessionToken } from '../../server/providers/cursor/auth.mjs';
import { updateSpark } from '../../server/spark.mjs';

function stripCursorModel(model) {
  if (typeof model !== 'string' || !model) return null;
  const s = model.replace(/^cursor:/, '');
  return s === 'auto' ? null : s;
}

function isLiveCursorAgent(agent) {
  return agent && agent.provider === 'cursor' && agent.sessionId && agent.status !== 'empty';
}

/** @returns {import('../../server/providers/cursor/usageSync.mjs').attribute slots} */
export function buildCursorUsageSlots(fleet) {
  const out = [];
  if (!fleet?.agents) return out;
  for (const agent of fleet.agents) {
    if (!isLiveCursorAgent(agent)) continue;
    const working = agent.status === 'working' || agent.status === 'waiting';
    const start = agent.sessionStartedAt ?? agent.spawnedAt;
    if (!Number.isFinite(start)) continue;
    const end = working ? null : (agent.stateSince ?? agent.lastEventTs ?? Date.now());
    out.push({
      slotId: agent.id,
      chatId: agent.sessionId,
      model: stripCursorModel(agent.model),
      windows: [{ start, end }],
      joinKeys: new Set([agent.sessionId]),
      launchTs: start,
    });
  }
  return out;
}

const TOKEN_FIELDS = ['tokensIn', 'tokensCacheRead', 'tokensOut', 'context', 'costSession'];

/** Apply cumulative usage totals onto live Cursor agents; returns whether anything changed. */
export function applyCursorUsageTotals(fleet, totalsMap, prevSnap = new Map()) {
  let changed = false;
  for (const [slotId, totals] of totalsMap ?? []) {
    const agent = fleet.agentById(slotId);
    if (!agent || agent.provider !== 'cursor') continue;
    let deltaTok = 0;
    for (const f of TOKEN_FIELDS) {
      const next = totals[f] ?? null;
      const prev = prevSnap.get(slotId)?.[f] ?? agent[f] ?? null;
      if (next !== agent[f]) {
        agent[f] = next;
        changed = true;
      }
      if (f !== 'context' && f !== 'costSession' && next != null && prev != null) {
        deltaTok += Math.max(0, next - prev);
      }
    }
    if (deltaTok > 0 && typeof updateSpark === 'function') updateSpark(agent, deltaTok);
    prevSnap.set(slotId, {
      tokensIn: totals.tokensIn,
      tokensCacheRead: totals.tokensCacheRead,
      tokensOut: totals.tokensOut,
      context: totals.context,
      costSession: totals.costSession,
    });
  }
  if (changed) fleet.emit('change');
  return changed;
}

/**
 * Start/stop a usage poller from App settings + fleet state.
 * @param {{ fleet, enabled, onError?, getSessionToken?, createPoller? }} opts
 */
export function wireCursorUsageSync({
  fleet,
  enabled,
  onError = () => {},
  getSessionToken = () => getCursorSessionToken(),
  createPoller = createUsagePoller,
} = {}) {
  const prevTotals = new Map();
  let poller = null;

  function shouldRun() {
    return enabled && buildCursorUsageSlots(fleet).length > 0;
  }

  function sync() {
    if (!shouldRun()) {
      if (poller) {
        poller.stop();
        poller = null;
      }
      return;
    }
    if (!poller) {
      poller = createPoller({
        getSessionToken,
        slotsProvider: () => buildCursorUsageSlots(fleet),
        joinKey: (raw) => (raw && raw.conversationId) || null,
        onTotals: (map) => { applyCursorUsageTotals(fleet, map, prevTotals); },
        onError,
      });
      poller.start();
    } else {
      poller.start();
    }
  }

  function stop() {
    if (poller) {
      poller.stop();
      poller = null;
    }
    prevTotals.clear();
  }

  return { sync, stop, getPoller: () => poller };
}

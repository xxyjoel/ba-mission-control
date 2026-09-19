// tests/lib/fakeFleet0408.js — shared FakeFleet for the 0408 regression
// tests. Mirrors the stand-in from tests/App.hotkeys.test.jsx /
// tests/App.dictation.test.jsx, plus call recording and per-agent action
// methods so hotkeys that reach fleet.agentById(id).pause() etc. are
// observable instead of throwing. Never spawns a real claude.
import { EventEmitter } from 'node:events';

export class FakeFleet extends EventEmitter {
  // `liveSlots` — array of slot numbers to fill, OR a map { slot: status }.
  constructor(liveSlots = []) {
    super();
    this.calls = [];
    this.slots = 10;
    const statusOf = Array.isArray(liveSlots)
      ? (i) => (liveSlots.includes(i) ? 'idle' : null)
      : (i) => liveSlots[i] || null;
    this._snap = { sessionStart: Date.now(), now: Date.now(), slots: 10, agents: [] };
    const fleet = this;
    for (let i = 1; i <= 10; i++) {
      const status = statusOf(i);
      if (status) {
        this._snap.agents.push({
          id: `s${i}-fake`, slot: i, status, name: `repo-${i}`, model: 'claude-sonnet-4-6',
          branch: 'main', cwd: '/tmp', context: 1000, tokensIn: 100, tokensOut: 50, costSession: 0.01,
          costWeek: 0, spark: [1, 1, 1], activity: '', tail: [], permissionMode: 'default', sessionId: `uuid-${i}`,
          pause() { fleet.calls.push(['pause', i]); },
          resume() { fleet.calls.push(['resume(SIGCONT)', i]); },
          approve() { fleet.calls.push(['approve', i]); },
          send(t) { fleet.calls.push(['send', i, t]); },
          changePermissionMode(m) { fleet.calls.push(['perm', i, m]); return true; },
          changeModel(m) { fleet.calls.push(['model', i, m]); return true; },
          appendTail() {}, addNote(t) { fleet.calls.push(['note', i, t]); },
        });
      } else {
        this._snap.agents.push({ id: `empty-${i}`, slot: i, status: 'empty', name: null, model: null });
      }
    }
  }
  snapshot() { return { ...this._snap, now: Date.now() }; }
  agentBySlot(s) { return this._snap.agents[s - 1]; }
  agentById(id) { return this._snap.agents.find(a => a.id === id) || null; }
  setCostCap() {} setSlots(n) { return n; } setViewport() { return 0; } killAll() {}
  launch(cfg) { this.calls.push(['launch', cfg]); }
  resume(cfg) { this.calls.push(['resumeFromRecord', cfg]); return null; }
  kill(id) { this.calls.push(['kill', id]); }
  broadcast(ids, text) { this.calls.push(['broadcast', ids, text]); return { sent: ids.length, skipped: 0 }; }
  setSlotCostCap() { return true; }
}

export const strip = (s) => (s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
export const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

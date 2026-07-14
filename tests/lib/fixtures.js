// tests/lib/fixtures.js — common test fixtures + helpers.
//
// Centralizes the most-used boilerplate so individual recipes don't have
// to redefine an agent shape or import a theme. Keep this file small;
// when a fixture needs heavy setup it belongs in the recipe itself.

import { THEMES } from '../../tui/lib/themes.js';

export const theme = THEMES['BlueArch'];

// Returns an agent snapshot shaped like what Fleet emits — used to feed
// the Zoom / Card render paths without standing up a real Fleet.
//
// Overrides are merged shallowly; pass `tail: [...]` to inject tail
// entries or `status: 'waiting'` to force a particular state.
export function makeAgent(overrides = {}) {
  return {
    slot: 1,
    id: 'test-1',
    name: 'test',
    model: 'sonnet-4.6',
    branch: 'main',
    cwd: '/tmp',
    dirty: 0,
    ahead: 0,
    behind: 0,
    status: 'working',
    context: 1000,
    tokensIn: 100,
    tokensOut: 50,
    costSession: 0.01,
    costWeek: 0,
    spark: [],
    activity: '',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    permissionMode: 'default',
    tail: [],
    ...overrides,
  };
}

// Build a tail with alternating user/asst entries — handy for scroll +
// history tests that need a "conversation past."
export function chatTail(turns = 5) {
  const tail = [];
  for (let i = 0; i < turns; i++) {
    tail.push({ kind: 'user', text: `user msg ${i}`, ts: i * 2 });
    tail.push({ kind: 'asst', text: `asst reply ${i}`, ts: i * 2 + 1 });
  }
  return tail;
}

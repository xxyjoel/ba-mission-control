// tui/lib/auth.js — probe the claude CLI for the current auth status.
//
// `claude auth status` prints JSON like:
//   {
//     "loggedIn": true,
//     "authMethod": "claude.ai",
//     "apiProvider": "firstParty",
//     "email": "user@example.com",
//     "orgId": "...",
//     "orgName": "...",
//     "subscriptionType": "max"
//   }
//
// We use execFile (argv form) so CLAUDE_BIN can't shell-inject. The probe
// is synchronous + bounded (3s timeout) because we run it once at preflight
// and on-demand for the `:whoami` command.

import { execFileSync } from 'node:child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

export function probeAuth({ timeout = 3000 } = {}) {
  try {
    const raw = execFileSync(CLAUDE_BIN, ['auth', 'status'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    }).toString().trim();
    const parsed = JSON.parse(raw);
    return {
      ok: !!parsed.loggedIn,
      method: parsed.authMethod || null,
      provider: parsed.apiProvider || null,
      email: parsed.email || null,
      orgName: parsed.orgName || null,
      subscription: parsed.subscriptionType || null,
      raw: parsed,
    };
  } catch (e) {
    // Older CLIs may not have `auth status`. Fall back to env-var detection.
    return {
      ok: !!process.env.ANTHROPIC_API_KEY,
      method: process.env.ANTHROPIC_API_KEY ? 'env (ANTHROPIC_API_KEY)' : null,
      provider: process.env.ANTHROPIC_API_KEY ? 'firstParty' : null,
      email: null,
      orgName: null,
      subscription: null,
      raw: null,
      error: e?.message || String(e),
    };
  }
}

// One-line summary suitable for a preflight banner or a feedback toast.
export function authSummary(probe) {
  if (!probe) return 'auth · unknown';
  if (!probe.ok) {
    if (probe.error) return `auth · NOT LOGGED IN (${probe.error.split('\n')[0].slice(0, 60)})`;
    return 'auth · NOT LOGGED IN — run `claude auth login`';
  }
  const parts = [];
  if (probe.email) parts.push(probe.email);
  if (probe.subscription) parts.push(`${probe.subscription} plan`);
  if (probe.method) parts.push(probe.method);
  return parts.length ? parts.join(' · ') : 'auth · ok';
}

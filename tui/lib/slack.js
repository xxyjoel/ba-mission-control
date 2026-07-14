// tui/lib/slack.js — post Mission Control feedback / customer requests
// to a Slack incoming-webhook URL.
//
// Webhook URL lives in settings (settings.slackWebhook) — set it via
// `:slack <url>` in the command bar, or by editing
// ~/.config/claude-mc/settings.json directly. We never log the URL.
//
// The message format is Slack's simplest "text-only" payload; that means
// the user only needs to configure an Incoming Webhook in their
// workspace (https://api.slack.com/messaging/webhooks). No bot tokens,
// no OAuth, no scopes.

// One-line summary of fleet state to include alongside the message body.
function contextLines({ auth, agents, usage }) {
  const lines = [];
  if (auth?.email) lines.push(`*from:* ${auth.email}${auth.subscription ? ` · ${auth.subscription} plan` : ''}`);
  if (agents) {
    const live = agents.filter(a => a.status !== 'empty');
    lines.push(`*fleet:* ${live.length} live session${live.length === 1 ? '' : 's'}`);
    for (const a of live.slice(0, 5)) {
      const branchClean = (a.dirty || 0) === 0;
      lines.push(`  • slot ${a.slot} \`${a.name || '—'}\` · ${a.model || '?'} · \`${a.branch || '?'}\`${branchClean ? '' : ` +${a.dirty}`} · status:${a.status}`);
    }
  }
  if (usage) {
    lines.push(`*plan usage:* 5h ${usage.fiveHour.usedPct.toFixed(0)}% · 7d ${usage.sevenDay.usedPct.toFixed(0)}%`);
  }
  return lines;
}

// Send a feedback / customer-request payload to Slack. Returns
// { ok, status, error } so the caller can toast the outcome.
//
// `kind` is purely cosmetic — we prepend it to the title line so a
// channel of mixed feedback is easy to scan.
//   :feedback         → "💬 feedback"
//   :request          → "📨 customer request"
//   custom            → "📌 <kind>"
export async function postSlack({ webhook, kind = 'feedback', text, context = {} }) {
  if (!webhook) return { ok: false, error: 'no slack webhook configured (set with :slack <url>)' };
  if (!text || !text.trim()) return { ok: false, error: 'empty message' };

  const title = kind === 'feedback'        ? '💬 *Mission Control · feedback*'
              : kind === 'request'         ? '📨 *Mission Control · customer request*'
              : `📌 *Mission Control · ${kind}*`;

  const ctx = contextLines(context);
  const body = [
    title,
    '',
    text.trim(),
    ...(ctx.length ? ['', '---', ...ctx] : []),
  ].join('\n');

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: errText.slice(0, 200) || `http ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// server/detectPrompt.mjs — classify an assistant message as a user-facing
// prompt (so the UI can flag a session as 'waiting' / render selectable
// chips). Extracted from agent.mjs so BOTH pipelines can share it without a
// circular import:
//   jsonlConnector.mjs → agent.mjs → sessionFileTailer.mjs → jsonlConnector
// would cycle; importing the pure detector from here breaks that.
//
// detectPrompt — classify an assistant text as one of:
//   { kind: 'binary' }                                       (yes/no)
//   { kind: 'single-select', options: [{num, text}, ...] }   (numbered list)
//   { kind: 'multi-select',  options: [{num, text}, ...] }   (- [ ] list)
//   null                                                      (regular answer)
//
// Stream-json doesn't expose a structured permission_request event in
// non-interactive (-p) mode, so when claude wants the user to choose
// something, the prompt arrives as plain assistant text. We pattern-match
// the shape so the Zoom modal can render selectable chips.
//
// Capped at 9 options (number keys 1..9 → 0). Beyond that, the user can
// still pick via the custom-reply path (Tab).
const MAX_OPTIONS = 9;
const SELECT_CUES = /\b(which|select|choose|pick|prefer|option)\b/i;

// Lettered-option patterns (Option A/B/C and friends). Tried per-line
// after numbered/checkbox parsing in detectPrompt(), in priority order
// — first match wins for that line.
//
// Group 1 always captures the letter; group 2 always captures the body
// text following the marker. Bold (`**`) wrappers are tolerated and
// stripped from the body downstream by cleanLetteredBody().
const OPTION_RX      = /^\s*\*{0,2}\s*Option\s+([A-Za-z])\b[\s\-—:.)]+(.+)$/i;
const BOLD_LETTER_RX = /^\s*\*\*([A-Za-z])[.):]?\*\*[\s\-—:.)]+(.+)$/;
const BARE_LETTER_RX = /^\s*\(?([A-Za-z])[.)]\s+(.+)$/;

function letterToNum(letter) {
  const code = letter.toUpperCase().charCodeAt(0);
  return code >= 65 && code <= 90 ? code - 64 : null;
}

function cleanLetteredBody(s) {
  // Strip paired bold markers (preserves single `*` italics inside) and
  // trim. The 100-char cap matches the numbered/checkbox bodies above.
  return s.replace(/\*\*/g, '').trim().slice(0, 100);
}

export function detectPrompt(text) {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;

  // Pass 1: look for adjacent list items in the message body. Scan all
  // lines (claude sometimes writes the question after the list).
  const lines = t.split('\n');
  const numbered = [];
  const checkboxes = [];
  const lettered = [];
  for (const raw of lines) {
    const numMatch = raw.match(/^\s*(\d+)[.)]\s+(.+)$/);
    const cbMatch  = raw.match(/^\s*[-*]\s*\[( |x|X)\]\s+(.+)$/);
    if (cbMatch) {
      checkboxes.push({
        num: checkboxes.length + 1,
        text: cbMatch[2].trim().slice(0, 100),
        // Whether claude pre-checked the option. The Zoom modal seeds the
        // multi-select's initial checked set from these defaults so the
        // user can accept claude's recommendation with one keystroke.
        preChecked: cbMatch[1] !== ' ',
      });
      continue;
    }
    if (numMatch) {
      numbered.push({ num: parseInt(numMatch[1], 10), text: numMatch[2].trim().slice(0, 100) });
      continue;
    }
    // Lettered patterns — Option-style first (most specific), then bold
    // standalone letter, then bare lettered. First match wins.
    const optMatch = raw.match(OPTION_RX) || raw.match(BOLD_LETTER_RX) || raw.match(BARE_LETTER_RX);
    if (optMatch) {
      const num = letterToNum(optMatch[1]);
      if (num) {
        const label = optMatch[1].toUpperCase();
        // Dedupe by label: same letter twice in the text counts once
        // (covers cases where the assistant restates options).
        if (!lettered.some(o => o.label === label)) {
          lettered.push({ num, label, text: cleanLetteredBody(optMatch[2]) });
        }
      }
    }
  }

  const hasQuestionMark = t.endsWith('?');
  const hasSelectCue = SELECT_CUES.test(t.slice(-600));

  // Multi-select wins if we see ≥2 checkboxes AND a question/select cue.
  if (checkboxes.length >= 2 && (hasQuestionMark || hasSelectCue)) {
    return { kind: 'multi-select', options: checkboxes.slice(0, MAX_OPTIONS), total: checkboxes.length };
  }

  // Single-select: ≥2 numbered items AND a question/select cue.
  if (numbered.length >= 2 && (hasQuestionMark || hasSelectCue)) {
    return { kind: 'single-select', options: numbered.slice(0, MAX_OPTIONS), total: numbered.length };
  }

  // Lettered fallback (Option A/B/C, bare A./B./C., bold **A:**) —
  // priority after numbered so an assistant that emits both lists picks
  // the more explicit convention. `label` is preserved on each option
  // so the Zoom modal can render [A]/[B]/[C] chips and dispatch on
  // letter keys.
  if (lettered.length >= 2 && (hasQuestionMark || hasSelectCue)) {
    return { kind: 'single-select', options: lettered.slice(0, MAX_OPTIONS), total: lettered.length };
  }

  // Binary fallback (original heuristic).
  if (hasQuestionMark) {
    const tail = t.slice(-400).toLowerCase();
    if (/\b(should i|shall i|would you like|want me to|do you want|proceed|continue|ok to|is that ok|confirm|y\/n|yes\/no)\b/.test(tail)) {
      return { kind: 'binary' };
    }
  }
  return null;
}

// promptFromToolUse — classify a tool_use block as a human-blocking prompt.
//
// detectPrompt (above) handles plain-text questions on `end_turn`. But some
// tools block on the user MID-turn: claude emits a tool_use (stop_reason
// 'tool_use', NOT 'end_turn') and will not proceed until the user answers.
// Without recognizing them, both pipelines pin the card on 'working' while
// it's really 'waiting' (needs input) — the exact symptom of a session that
// has popped an AskUserQuestion / plan-approval gate. We map the tool's
// structured input onto the same `awaitingPrompt` shape the UI already
// renders (Card.jsx chips, Zoom modal). Returns null for non-blocking tools
// (Bash, Read, Edit, …) so the caller keeps treating those as 'working'.
export function promptFromToolUse(name, input) {
  if (name === 'ExitPlanMode') {
    // Plan presented for approval — a yes/no gate. 'approval' is the kind
    // Card.jsx renders inline.
    return { kind: 'approval', tool: name };
  }
  if (name === 'AskUserQuestion') {
    // Surface the first question's options as selectable chips. Multi-question
    // asks still flip to 'waiting'; the Zoom modal can page the rest.
    const q = Array.isArray(input?.questions) ? input.questions[0] : null;
    const opts = Array.isArray(q?.options) ? q.options : [];
    if (!opts.length) return { kind: 'binary', tool: name };
    return {
      kind: q.multiSelect ? 'multi-select' : 'single-select',
      tool: name,
      question: typeof q.question === 'string' ? q.question.slice(0, 200) : '',
      options: opts.slice(0, MAX_OPTIONS).map((o, i) => ({
        num: i + 1,
        text: String(o?.label ?? '').slice(0, 100),
      })),
      total: opts.length,
    };
  }
  return null;
}

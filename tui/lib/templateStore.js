// tui/lib/templateStore.js — on-disk session templates.
//
// A "template" is a named bundle of session launches: N agents with
// pre-configured model / permission / initial prompt that get fired
// into the next N empty slots when the user runs `:template <name>`.
// Templates are the killer feature for repeat workflows — "PR review,"
// "parallel exploration," "spec then implement."
//
// Storage: ~/.config/claude-mc/templates.json (single file, easy to
// hand-edit). On first read we write the bundled defaults so users
// have working examples without needing docs.
//
// Schema (per template):
//   {
//     description: <one-liner shown by `:template` with no args>,
//     sessions: [
//       { model, permissionMode, prompt },
//       ...
//     ]
//   }
//
// Templates do NOT pin cwd / branch — those come from the caller
// (`:template <name> [cwd]`), so the same template launches against
// whatever working directory the user is in.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from './configDir.js';

const CONFIG_DIR  = getConfigDir();
const FILE        = join(CONFIG_DIR, 'templates.json');

// Defaults written on first read. Each session has a `prompt` that's
// generic enough to work in any repo but specific enough to deliver
// distinct value vs. just spawning N empty agents.
const DEFAULTS = {
  review: {
    description: '3 reviewers (opus architecture + 2 sonnets) — same repo, plan mode',
    sessions: [
      {
        model: 'opus-4.8',
        permissionMode: 'plan',
        prompt: 'You are doing an architecture review of this codebase. Identify the top 3 structural issues that would hurt maintainability as the project grows. Be specific (file paths, function names).',
      },
      {
        model: 'sonnet-4.6',
        permissionMode: 'plan',
        prompt: 'You are doing a test coverage review. Find the most important untested code paths (focus on logic that handles user input, external APIs, or error states). List them with file:line refs.',
      },
      {
        model: 'sonnet-4.6',
        permissionMode: 'plan',
        prompt: 'You are doing a documentation review. Identify the 3 biggest gaps where a new contributor would get stuck (missing docstrings, missing README sections, missing CLAUDE.md guidance). Be specific.',
      },
    ],
  },
  explore: {
    description: '2-session parallel exploration: opus deep + sonnet fast',
    sessions: [
      {
        model: 'opus-4.8',
        permissionMode: 'plan',
        prompt: 'Take the deeper-thinking path. What is the highest-leverage change you could make to this codebase in the next hour? Justify your pick.',
      },
      {
        model: 'sonnet-4.6',
        permissionMode: 'plan',
        prompt: 'Survey the codebase. Give me a one-paragraph map of what each top-level directory does. Note any directories that look unused or stale.',
      },
    ],
  },
  'spec-then-implement': {
    description: '2-session spec→impl: opus writes spec (plan), sonnet implements (acceptEdits)',
    sessions: [
      {
        model: 'opus-4.8',
        permissionMode: 'plan',
        prompt: 'I will describe a feature shortly. Your job is to produce a tight implementation spec — file paths, signatures, key data structures, edge cases. Do NOT write code; produce a spec the second slot will implement.',
      },
      {
        model: 'sonnet-4.6',
        permissionMode: 'acceptEdits',
        prompt: 'You will receive a spec from slot 1 (paste-forwarded by the user). Implement it. Ask for clarification only if a constraint is missing or ambiguous.',
      },
    ],
  },
};

function persist(obj) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(obj, null, 2));
  } catch {
    // best-effort
  }
}

export function loadTemplates() {
  try {
    if (!existsSync(FILE)) {
      persist(DEFAULTS);
      return DEFAULTS;
    }
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function getTemplate(name) {
  const all = loadTemplates();
  // Case-insensitive lookup so `:template Review` still works.
  const key = Object.keys(all).find(k => k.toLowerCase() === (name || '').toLowerCase());
  return key ? { name: key, ...all[key] } : null;
}

export function listTemplates() {
  const all = loadTemplates();
  return Object.entries(all).map(([name, t]) => ({
    name,
    description: t.description || '',
    count: Array.isArray(t.sessions) ? t.sessions.length : 0,
  }));
}

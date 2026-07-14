// tui/modals/NewSession.jsx — pick a directory and launch a claude session.
//
// One input: `path`. As you type, the dropdown blends two sources:
//   1. Recent repos whose name or tildified path contains the query
//      (case-insensitive substring).
//   2. Filesystem child directories of the typed path when it is
//      path-like (starts with `/` or `~`, or ends with `/`).
//
// Two ways to drive it:
//   • Type to fuzzy-narrow recents, ↑/↓ to pick, ↵ to launch.
//   • Ctrl+B to open the filesystem browser (familiar `cd`/`ls`-style
//     navigation): h/← up · l/→ descend · ↑↓ select · ↵ pick & launch
//     immediately.
//
// ←/→ cycles the model. `esc` cancels.
//
// Intentionally absent: mode toggle, create-new (mkdir + git init),
// resume banner, branch input, permission picker, initial prompt.
// Those are out of scope — the modal does one thing: pick a repo and
// launch. Permission mode is swappable mid-session and the prompt can
// be typed after attach.

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import TextField from '../lib/TextField.jsx';
import { MODEL_IDS, MODELS } from '../lib/models.js';
import RepoPicker from './RepoPicker.jsx';

const SUGGEST_VIEW = 8;          // visible suggestion rows
const RECENT_DEFAULT = 8;        // how many recents to show with empty query

const HOME = homedir();

function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}

function tildify(p) {
  if (!p) return p;
  if (p === HOME) return '~';
  if (p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length);
  return p;
}

function looksLikePath(q) {
  if (!q) return false;
  return q.startsWith('/') || q.startsWith('~') || q.includes('/');
}

async function listChildren(value) {
  if (!value) return [];
  const expanded = expandTilde(value);
  let dir, prefix;
  if (value === '~' || expanded === '/' || expanded.endsWith('/')) {
    dir = value === '~' ? HOME : expanded;
    prefix = '';
  } else {
    dir = dirname(expanded);
    prefix = basename(expanded);
  }
  try {
    const ents = await readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory()
        && !e.name.startsWith('.')
        && e.name !== 'node_modules'
        && e.name !== 'dist'
        && e.name !== 'build'
        && (!prefix || e.name.toLowerCase().startsWith(prefix.toLowerCase())))
      .map((e) => ({ name: e.name, abs: join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);
  } catch {
    return [];
  }
}

export default function NewSession({
  slot,
  repos,
  onLaunch,
  onClose,
  defaultModel,
  theme,
  width = 84,
}) {
  const [view, setView] = useState('main');  // 'main' | 'browse'
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const [model, setModel] = useState(defaultModel || 'sonnet-4.6');
  const [fsChildren, setFsChildren] = useState([]);
  const [error, setError] = useState(null);
  // Which field owns arrow keys. 'path' (default) → TextField gets ←/→
  // for cursor and the modal ignores arrows entirely. 'list' → modal
  // takes over: ↑/↓ walks the suggestion list, ←/→ cycles the model.
  // Tab toggles. Without this gate every arrow press would both move
  // the cursor (TextField) AND cycle the model (modal), because Ink
  // broadcasts useInput to every active handler.
  const [focus, setFocus] = useState('path');

  const recentHits = useMemo(() => {
    if (!repos || repos.length === 0) return [];
    if (!query) return repos.slice(0, RECENT_DEFAULT);
    const q = query.toLowerCase();
    return repos.filter(r => (
      (r.name || '').toLowerCase().includes(q) ||
      (r.path || '').toLowerCase().includes(q)
    ));
  }, [repos, query]);

  useEffect(() => {
    let cancelled = false;
    if (!looksLikePath(query)) { setFsChildren([]); return; }
    listChildren(query).then((items) => {
      if (cancelled) return;
      setFsChildren(items);
    });
    return () => { cancelled = true; };
  }, [query]);

  const suggestions = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const r of recentHits) {
      const abs = r.absPath || expandTilde(r.path || '');
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);
      out.push({ kind: 'repo', name: r.name, abs, display: tildify(abs), branch: r.defaultBranch || 'main', last: r.last });
    }
    for (const c of fsChildren) {
      if (seen.has(c.abs)) continue;
      seen.add(c.abs);
      out.push({ kind: 'dir', name: c.name, abs: c.abs, display: tildify(c.abs), branch: 'main' });
    }
    return out;
  }, [recentHits, fsChildren]);

  useEffect(() => {
    setIdx(0);
    setError(null);
  }, [query]);

  const launch = (chosenAbs, branch) => {
    onLaunch({
      slot,
      repoPath: chosenAbs,
      branch: branch || 'main',
      model,
    });
  };

  const submit = () => {
    if (suggestions.length > 0) {
      const sel = suggestions[idx] || suggestions[0];
      launch(sel.abs, sel.branch);
      return;
    }
    const abs = expandTilde(query.trim());
    if (!abs) { setError('type a path or pick a suggestion'); return; }
    if (!existsSync(abs)) { setError(`not a directory: ${abs}`); return; }
    launch(abs, 'main');
  };

  useInput((input, key) => {
    if (view === 'browse') return;  // RepoPicker owns input while open
    if (key.escape) { onClose(); return; }
    if (key.ctrl && (input === 'b' || input === 'B')) { setView('browse'); return; }
    if (key.tab) {
      setFocus(f => f === 'path' ? 'list' : 'path');
      return;
    }
    // ↑/↓ are safe to claim in either focus — TextField is single-line
    // here so its cursor never uses vertical arrows. Auto-switch to
    // list focus so the keypress that initiates list nav also moves
    // the selection, matching every other dropdown UX.
    if (key.upArrow) {
      if (focus !== 'list') setFocus('list');
      setIdx(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      if (focus !== 'list') setFocus('list');
      setIdx(i => Math.min(Math.max(0, suggestions.length - 1), i + 1));
      return;
    }
    // ←/→ are the conflict case — TextField uses them for cursor
    // movement. Only claim them while focus === 'list'.
    if (focus !== 'list') return;
    // Enter while in list focus → submit (launch). TextField is
    // inactive in this mode so it won't fire onSubmit itself.
    if (key.return) { submit(); return; }
    if (key.leftArrow || key.rightArrow) {
      const i = MODEL_IDS.indexOf(model);
      const dir = key.rightArrow ? 1 : -1;
      setModel(MODEL_IDS[(i + dir + MODEL_IDS.length) % MODEL_IDS.length]);
      return;
    }
  });

  if (view === 'browse') {
    return (
      <RepoPicker
        start={expandTilde(query) || undefined}
        current={[]}
        onPick={(abs) => {
          // Enter inside the picker means "accept and launch."
          // No round-trip back to the main view — the user already
          // chose the directory; making them confirm twice is friction.
          setView('main');
          launch(abs, 'main');
        }}
        onClose={() => setView('main')}
        theme={theme}
        width={width}
      />
    );
  }

  const visible = suggestions.slice(0, SUGGEST_VIEW);
  const hiddenBelow = Math.max(0, suggestions.length - SUGGEST_VIEW);
  const highlighted = suggestions[idx];

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderColor={theme.accent}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Box>
        <Text color={theme.accent}>━━ NEW SESSION </Text>
        <Text color={theme.dim}>· slot [{slot}]</Text>
        <Box flexGrow={1} />
        <Text color={theme.faint}>{suggestions.length} match{suggestions.length === 1 ? '' : 'es'}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={focus === 'path' ? theme.accent : theme.dim}>
          {focus === 'path' ? '▶ path  ' : '  path  '}
        </Text>
        <TextField
          value={query}
          onChange={setQuery}
          onSubmit={submit}
          focus={focus === 'path'}
          color={theme.fg}
          caretColor={theme.accent}
          placeholder="type a repo name or path · ~/some/folder"
        />
      </Box>

      <Box flexDirection="column" marginTop={1} height={SUGGEST_VIEW + 1}>
        {visible.length === 0 && (
          <Text color={theme.dim}>  (no matches — ↵ tries the typed path · ctrl+b to browse)</Text>
        )}
        {visible.map((s, i) => {
          const sel = i === idx;
          return (
            <Box key={s.abs}>
              <Text color={sel ? theme.accent : theme.faint}>{sel ? '▶ ' : '  '}</Text>
              <Text color={sel ? theme.fg : theme.fg} bold={sel}>{s.name}</Text>
              <Text color={theme.faint}>  · </Text>
              <Text color={theme.accent}>⎇ {s.branch}</Text>
              {s.last && (
                <>
                  <Text color={theme.faint}>  · </Text>
                  <Text color={theme.dim}>{s.last}</Text>
                </>
              )}
              <Text color={theme.faint}>  · </Text>
              <Text color={theme.faint} wrap="truncate-end">{s.display}</Text>
            </Box>
          );
        })}
        {hiddenBelow > 0 && (
          <Text color={theme.faint}>  ▼ {hiddenBelow} more</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.dim}>model </Text>
        <Text color={theme.accent}>◀ </Text>
        <Text color={theme.fg}>{MODELS[model]?.label || model}</Text>
        <Text color={theme.accent}> ▶</Text>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color={theme.red}>✕ {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.dim}>
          <Text color={theme.accent}>tab</Text> focus [{focus}]  ·  {focus === 'list'
            ? (<><Text color={theme.accent}>↑↓</Text> pick  ·  <Text color={theme.accent}>← →</Text> model  ·  </>)
            : (<><Text color={theme.faint}>arrows = cursor (tab for list)</Text>  ·  </>)
          }<Text color={theme.accent}>↵</Text> launch{highlighted ? ` ${highlighted.name}` : ''}  ·  <Text color={theme.accent}>ctrl+b</Text> browse  ·  <Text color={theme.accent}>esc</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}

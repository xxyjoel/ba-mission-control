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
// Subscriptions (0420): with two or more usable providers a
// `subscription ◀ … ▶` row appears above `model` and Tab gains a third stop
// (path → list → subscription). ←/→ there switches provider, which swaps the
// model list and resets the model to that provider's default. With one
// provider the modal is exactly the pre-0420 one.
//
// Intentionally absent: mode toggle, create-new (mkdir + git init),
// resume banner, branch input, permission picker, initial prompt.
// Those are out of scope — the modal does one thing: pick a repo and
// launch. Permission mode is swappable mid-session and the prompt can
// be typed after attach.

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import TextField from '../lib/TextField.jsx';
import { modelIds, MODELS, resolveModelId } from '../lib/models.js';
import RepoPicker from './RepoPicker.jsx';
import { getProvider } from '../../server/providers/index.mjs';

const SUGGEST_VIEW = 8;          // visible suggestion rows
const RECENT_DEFAULT = 8;        // how many recents to show with empty query
// Rows outside the suggestion list: border 2 + padding 2 + header 1 + path
// (margin + row) 2 + list margin 1 + model (margin + row) 2 + footer (margin +
// two wrapped rows) 3. The subscription row adds 1, an error 2.
const CHROME_ROWS = 13;

const DEFAULT_PROVIDERS = [getProvider('claude')];
const defaultModelsFor = () => modelIds(); // live catalog — includes probe-discovered models
const defaultModelLabel = (id) => MODELS[id]?.label || id;

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
  // Subscriptions: enabled + connected descriptors, in registry order.
  providers = DEFAULT_PROVIDERS,
  initialProvider,
  modelsFor = defaultModelsFor,
  defaultModelFor,
  modelLabel = defaultModelLabel,
  // Max rows the modal may take (App passes overlayHeight). Unset = no clamp.
  height,
}) {
  const [view, setView] = useState('main');  // 'main' | 'browse'
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const multi = providers.length >= 2;
  const pickProvider = (want) => (providers.find(p => p.id === want) || providers[0])?.id || 'claude';
  // 'auto' resolves to the newest discovered Opus at open time; ←/→ then
  // cycles concrete catalog ids from there.
  const defaultFor = (pid) => {
    if (defaultModelFor) return defaultModelFor(pid);
    if (pid === 'claude') return resolveModelId(defaultModel);
    return modelsFor(pid)[0] ?? null;
  };
  const [provider, setProvider] = useState(() => pickProvider(initialProvider));
  const [model, setModel] = useState(() => defaultFor(pickProvider(initialProvider)));
  // Until the user picks a provider or model, a provider that becomes
  // available after open (App's auth probe resolving) may take the preselect.
  const touchedRef = useRef(false);
  const providerIds = providers.map(p => p.id).join(',');
  useEffect(() => {
    const want = pickProvider(touchedRef.current ? provider : initialProvider);
    if (want !== provider) { setProvider(want); setModel(defaultFor(want)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerIds, initialProvider]);
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
      provider,
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
      if (multi) setFocus(f => (f === 'path' ? 'list' : f === 'list' ? 'subscription' : 'path'));
      else setFocus(f => f === 'path' ? 'list' : 'path');
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
    // movement. Only claim them outside path focus.
    if (focus === 'path') return;
    // Enter in list/subscription focus → submit (launch). TextField is
    // inactive in these modes so it won't fire onSubmit itself.
    if (key.return) { submit(); return; }
    if (!key.leftArrow && !key.rightArrow) return;
    const dir = key.rightArrow ? 1 : -1;
    touchedRef.current = true;
    if (focus === 'subscription') {
      const i = providers.findIndex(p => p.id === provider);
      const next = providers[(i + dir + providers.length) % providers.length].id;
      setProvider(next);
      setModel(defaultFor(next));
      return;
    }
    const ids = modelsFor(provider);
    if (!ids.length) return;
    const i = ids.indexOf(model);
    setModel(ids[(i + dir + ids.length) % ids.length]);
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

  // The list box is SUGGEST_VIEW rows + one "▼ N more" row. Only when the
  // modal would outgrow `height` does it shrink, and then it scrolls to keep
  // the highlight in view.
  const chrome = CHROME_ROWS + (multi ? 1 : 0) + (error ? 2 : 0);
  const listBox = height ? Math.max(2, Math.min(SUGGEST_VIEW + 1, height - chrome)) : SUGGEST_VIEW + 1;
  const viewRows = listBox - 1;
  const start = viewRows < SUGGEST_VIEW ? Math.max(0, Math.min(idx - viewRows + 1, suggestions.length - viewRows)) : 0;
  const visible = suggestions.slice(start, start + viewRows);
  const hiddenBelow = Math.max(0, suggestions.length - (start + viewRows));
  const highlighted = suggestions[idx];
  const providerLabel = providers.find(p => p.id === provider)?.label || provider;

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

      <Box flexDirection="column" marginTop={1} height={listBox}>
        {visible.length === 0 && (
          <Text color={theme.dim}>  (no matches — ↵ tries the typed path · ctrl+b to browse)</Text>
        )}
        {visible.map((s, i) => {
          const sel = start + i === idx;
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

      {multi && (
        <Box marginTop={1}>
          <Text color={focus === 'subscription' ? theme.accent : theme.dim}>
            {focus === 'subscription' ? '▶ subscription ' : '  subscription '}
          </Text>
          <Text color={theme.accent}>◀ </Text>
          <Text color={theme.fg}>{providerLabel}</Text>
          <Text color={theme.accent}> ▶</Text>
        </Box>
      )}

      <Box marginTop={multi ? 0 : 1}>
        <Text color={theme.dim}>{multi ? '  model ' : 'model '}</Text>
        <Text color={theme.accent}>◀ </Text>
        <Text color={theme.fg}>{modelLabel(model)}</Text>
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
            : focus === 'subscription'
              ? (<><Text color={theme.accent}>← →</Text> subscription  ·  </>)
              : (<><Text color={theme.faint}>arrows = cursor (tab for list)</Text>  ·  </>)
          }<Text color={theme.accent}>↵</Text> launch{highlighted ? ` ${highlighted.name}` : ''}  ·  <Text color={theme.accent}>ctrl+b</Text> browse  ·  <Text color={theme.accent}>esc</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}

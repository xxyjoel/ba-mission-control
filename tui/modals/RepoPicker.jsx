// tui/modals/RepoPicker.jsx — interactive filesystem browser for choosing
// where the New Session picker scans for git repos.
//
// Starts at $HOME and lists subdirectories. The user drills in/out and picks
// a directory as the repo scan root. The chosen path REPLACES the built-in
// defaults (persisted to settings.repoParents by App.jsx). This is the
// keyboard answer to "select a new folder location for where repos live".
//
//   ↑↓ / j k   move selection
//   → / l      enter the highlighted directory (descend)
//   ← / h      go up a level
//   ↵          pick the highlighted directory as the location
//   .          pick the folder you're currently browsing
//   esc        cancel

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';

const HOME = homedir();
const VIEW = 12;                          // visible rows in the dir list
const SKIP = new Set(['node_modules', 'dist', 'build']);

function tildify(p) {
  if (p === HOME) return '~';
  if (p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length);
  return p;
}

export default function RepoPicker({ start, current = [], onPick, onClose, theme, width = 84 }) {
  const [cwd, setCwd] = useState(() => start || HOME);
  const [entries, setEntries] = useState([]);  // child directory names
  const [idx, setIdx] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [err, setErr] = useState(null);

  const atRoot = dirname(cwd) === cwd;

  // Load child directories whenever the browse dir changes. Hidden dirs and
  // the usual build-artifact dirs are skipped to keep the list scannable.
  useEffect(() => {
    let cancelled = false;
    setErr(null);
    readdir(cwd, { withFileTypes: true })
      .then((ents) => {
        if (cancelled) return;
        const dirs = ents
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
        setEntries(dirs);
        setIdx(0);
        setScrollTop(0);
      })
      .catch((e) => {
        if (cancelled) return;
        setEntries([]);
        setErr(e?.code === 'EACCES' ? 'permission denied' : 'cannot read directory');
      });
    return () => { cancelled = true; };
  }, [cwd]);

  // Rendered rows: an optional ".." up-entry, then the child dirs.
  const rows = useMemo(() => {
    const r = atRoot ? [] : [{ kind: 'up' }];
    for (const name of entries) r.push({ kind: 'dir', name });
    return r;
  }, [entries, atRoot]);

  const goUp = () => { if (!atRoot) setCwd(dirname(cwd)); };

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }

    if (key.upArrow || input === 'k') { setIdx((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow || input === 'j') { setIdx((i) => Math.min(rows.length - 1, i + 1)); return; }

    if (key.leftArrow || input === 'h') { goUp(); return; }

    const row = rows[idx];

    if (key.rightArrow || input === 'l') {
      if (!row) return;
      if (row.kind === 'up') goUp();
      else setCwd(join(cwd, row.name));
      return;
    }

    if (key.return) {
      if (!row) return;
      if (row.kind === 'up') { goUp(); return; }
      onPick(join(cwd, row.name));
      return;
    }

    // '.' picks the folder currently being browsed (not a child).
    if (input === '.') { onPick(cwd); return; }
  });

  // Keep the selection inside the scroll window.
  useEffect(() => {
    if (idx < scrollTop) setScrollTop(idx);
    else if (idx >= scrollTop + VIEW) setScrollTop(idx - VIEW + 1);
  }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps

  const hiddenAbove = scrollTop;
  const hiddenBelow = Math.max(0, rows.length - scrollTop - VIEW);
  const visible = rows.slice(scrollTop, scrollTop + VIEW);

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
        <Text color={theme.accent}>━━ PICK REPO LOCATION </Text>
        <Box flexGrow={1} />
        <Text color={theme.faint}>{rows.length - (atRoot ? 0 : 1)} folders</Text>
      </Box>

      {/* Where we are now + the location currently configured. */}
      <Box marginTop={1}>
        <Text color={theme.dim}>browsing </Text>
        <Text color={theme.fg} wrap="truncate-start">{tildify(cwd)}</Text>
      </Box>
      <Box>
        <Text color={theme.faint}>current: </Text>
        <Text color={theme.faint} wrap="truncate-end">
          {current.length ? current.map(tildify).join('  ') : 'built-in defaults'}
        </Text>
      </Box>

      {/* Directory list — fixed viewport with hidden-count indicators. */}
      <Box flexDirection="column" marginY={1} height={VIEW + 2}>
        <Box>
          <Text color={theme.faint}>{hiddenAbove > 0 ? `  ▲ ${hiddenAbove} more above` : '  '}</Text>
        </Box>
        {err && <Text color={theme.red}>  ✕ {err}</Text>}
        {!err && rows.length === 0 && <Text color={theme.dim}>  (no subfolders — press . to pick this folder)</Text>}
        {visible.map((row, i) => {
          const absIdx = scrollTop + i;
          const sel = absIdx === idx;
          const marker = sel ? '▶ ' : '  ';
          if (row.kind === 'up') {
            return (
              <Box key="up">
                <Text color={sel ? theme.accent : theme.faint}>{marker}</Text>
                <Text color={sel ? theme.accent : theme.dim}>../  </Text>
                <Text color={theme.faint}>(up a level)</Text>
              </Box>
            );
          }
          return (
            <Box key={row.name}>
              <Text color={sel ? theme.accent : theme.faint}>{marker}</Text>
              <Text color={sel ? theme.fg : theme.fg} bold={sel}>{row.name}</Text>
              <Text color={theme.faint}>/</Text>
            </Box>
          );
        })}
        {Array.from({ length: Math.max(0, VIEW - visible.length) }).map((_, i) => (
          <Box key={`pad-${i}`}><Text> </Text></Box>
        ))}
        <Box>
          <Text color={theme.faint}>{hiddenBelow > 0 ? `  ▼ ${hiddenBelow} more below` : '  '}</Text>
        </Box>
      </Box>

      <Box>
        <Text color={theme.dim}>
          <Text color={theme.accent}>↑↓</Text> nav  ·  <Text color={theme.accent}>→</Text> enter dir  ·  <Text color={theme.accent}>←</Text> up  ·  <Text color={theme.accent}>↵</Text> pick folder  ·  <Text color={theme.accent}>.</Text> pick current  ·  <Text color={theme.accent}>esc</Text> cancel
        </Text>
      </Box>
    </Box>
  );
}

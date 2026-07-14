// tui/zoom/PtyPane.jsx — embed a real interactive `claude` PTY child
// inside the Zoom modal.
//
// Why this exists: the previous Zoom modal parsed claude's stream-json
// events and re-rendered them through Ink, which never matched Claude
// Code's own renderer (markdown, cursor, slash UI, scroll, syntax
// highlighting). PtyPane hands the body region over to a real claude
// resumed against the same session UUID — the user gets the exact
// Claude Code experience inside our fleet chrome.
//
// What this component does:
//   1. Spawns `claude --resume <sid>` via node-pty (server/zoomSession)
//   2. Feeds the PTY's stdout into an xterm-headless emulator
//   3. Renders the emulator's visible viewport as Ink <Text> rows
//   4. Captures every keystroke and forwards the corresponding raw
//      byte sequence to the PTY (with a few intercepts that the parent
//      Zoom modal owns — toggle tools, toggle stats, cycle perm, exit)

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import xterm from '@xterm/headless';
import { startZoomSession } from '../../server/zoomSession.mjs';
import { keyToBytes } from './ptyKeys.js';
import { classifyZoomKey } from './zoomKeys.js';
import { rowToRuns } from './ptyCells.js';
import { matchUpdateBanner } from './claudeBanner.js';

// Terminal constructor still imported for the legacy startZoomSession
// (stream-json Agent) fallback path — PtyAgent owns its own persistent
// term. When the agent comes from PtyAgent.attachZoomView, session.term
// is non-null and we use it directly.
const { Terminal } = xterm.default || xterm;

// Upper-bound frame cap on PTY blits. Render is driven by xterm's
// onWriteParsed/onScroll/onCursorMove events (event-driven, not
// polled), but we coalesce bursts so a flood of small writes doesn't
// force React to reconcile 100× per second. 16ms ≈ 60fps — matches
// what claude does natively in a bare terminal.
const RENDER_INTERVAL_MS = 16;

// Esc closes zoom on a single tap — matches every other modal in mc.
// Users who need to interrupt claude's streaming response use Ctrl+C
// (forwarded verbatim as 0x03). The previous double-tap design tried
// to overload Esc for both "interrupt claude" and "exit zoom" but
// users reported the single-tap "Esc forwards to claude, nothing
// happens" behavior as broken (smoke test, 2026-06-17).

// PtyPane — owns the PTY lifecycle for one zoomed agent.
//
// Props
//   agent              — the Agent instance to zoom into
//   width              — viewport columns (caller computes — sidebars eat width)
//   height             — viewport rows
//   focus              — whether keystrokes are routed to the PTY (default true)
//   onClose            — called when the user presses Ctrl+Q (zoom exit) OR
//                        when the PTY child exits on its own
//   onToggleTools      — Ctrl+K intercept (moved off Ctrl+T = claude's todos)
//   onToggleStats      — Ctrl+U intercept (moved off Ctrl+S = claude's stash)
//   onCyclePerm        — unused inside zoom (Shift+Tab forwards to
//                        claude now so its native perm cycler works);
//                        kept on the prop API for App.jsx symmetry.
//   theme              — for the spinner / error fallback
export default function PtyPane({
  agent, width, height,
  focus = true,
  onClose, onToggleTools, onToggleStats, onCyclePerm,
  theme,
  // When true (default), claude's own "update available" banner row is blanked
  // from the body and reported via onClaudeUpdate so the parent can show a
  // discrete indicator on the right of the header instead of letting it
  // encroach on the conversation. Toggled by the hideClaudeUpdateBanner setting.
  hideUpdateBanner = true,
  onClaudeUpdate,
}) {
  // PTY + emulator live across renders.
  const ptyRef  = useRef(null);
  const termRef = useRef(null);
  const cellRef = useRef(null);
  const disposeRef = useRef(null);
  const renderTimerRef = useRef(null);
  // True when the term is owned by PtyAgent (persistent across zoom
  // enter/exit). False when we built a local Terminal for the legacy
  // startZoomSession path. Controls whether unmount disposes the term.
  const termOwnedByAgentRef = useRef(false);
  // onData / onExit disposables. node-pty returns IDisposable from
  // each subscription — for the legacy startZoomSession path the PTY
  // is killed on unmount so leaks are harmless, but in the PtyAgent
  // attachZoomView path the PTY outlives the zoom view and we MUST
  // unsubscribe or every re-zoom adds another stale listener.
  const dataDisposeRef = useRef(null);
  const exitDisposeRef = useRef(null);
  // Render-trigger subscriptions on the term. Disposed on unmount.
  const writeSubRef  = useRef(null);
  const scrollSubRef = useRef(null);
  const cursorSubRef = useRef(null);

  // Lazy tick that forces a re-render after PTY data lands. We coalesce
  // into ~30fps frames so a fast stream doesn't pin the event loop.
  const [tick, setTick] = useState(0);
  const [error, setError] = useState(null);
  const [exited, setExited] = useState(false);

  // Scroll mode. Activated by Ctrl+Y (0x19 — Ink-reliable, unused by claude).
  // While active, `w` / `s` scroll up / down by one line, `b` / `f`
  // by half a page, `g` / `G` jump to top / bottom. `Esc` or any
  // other key exits scroll mode and re-enables claude input. We
  // can't use plain w/s outside of scroll mode because they're
  // typed text letters — see docs/HOTKEYS.md §7.
  const [scrollMode, setScrollMode] = useState(false);
  // scrollOffset is rows above the live cursor row. 0 = follow live
  // output. > 0 = pinned back in history. Capped at the buffer's
  // actual scrollback size in the render path.
  const [scrollOffset, setScrollOffset] = useState(0);

  // Clamp width/height to sensible minimums. xterm-headless requires
  // cols ≥ 1, rows ≥ 1; claude's UI looks broken below ~30 cols.
  const cols = Math.max(20, Math.floor(width  || 80));
  const rows = Math.max(5,  Math.floor(height || 24));

  // ── PTY lifecycle ─────────────────────────────────────────────
  // Spawn on mount; tear down on unmount. We do NOT re-spawn on
  // size changes — just resize the existing PTY.
  useEffect(() => {
    let cancelled = false;
    try {
      // PtyAgent (single-pipeline) exposes attachZoomView: bind the
      // viewer to the agent's already-running claude PTY AND its
      // persistent xterm-headless emulator. The agent owns the term
      // — its buffer survives zoom enter/exit so re-zoom shows the
      // full conversation. Legacy Agent doesn't have attachZoomView
      // — fall back to the spawn-a-sibling path and build a local
      // ephemeral Terminal for that case.
      const session = typeof agent?.attachZoomView === 'function'
        ? agent.attachZoomView({ cols, rows })
        : startZoomSession(agent, { cols, rows });
      let term, cell;
      if (session.term && session.cell) {
        // Persistent term from PtyAgent. Do NOT dispose on unmount.
        term = session.term;
        cell = session.cell;
        termOwnedByAgentRef.current = true;
      } else {
        // Legacy path — build a local Terminal that lives for this
        // zoom session only. Dispose on unmount (and pipe pty data
        // through it ourselves since the agent doesn't).
        term = new Terminal({
          cols, rows,
          allowProposedApi: true,
          scrollback: 5000,
        });
        cell = term.buffer.active.getNullCell();
        termOwnedByAgentRef.current = false;
      }
      termRef.current = term;
      cellRef.current = cell;
      ptyRef.current = session.pty;
      disposeRef.current = session.dispose;

      // Frame scheduler. Driven by xterm's own buffer-change events
      // below (onWriteParsed fires after the parser commits a write;
      // onScroll/onCursorMove cover viewport changes that don't write
      // new cells). The setTimeout coalesces a burst of events into
      // one React render at up to RENDER_INTERVAL_MS cadence.
      const scheduleRender = () => {
        if (renderTimerRef.current) return;
        renderTimerRef.current = setTimeout(() => {
          renderTimerRef.current = null;
          if (!cancelled) setTick(n => (n + 1) | 0);
        }, RENDER_INTERVAL_MS);
      };

      // PTY data pump: only own this on the LEGACY path. With
      // PtyAgent the agent already pipes pty.onData into its
      // persistent term — subscribing again here would double-write
      // every byte (visible as garbled rendering).
      if (!termOwnedByAgentRef.current) {
        dataDisposeRef.current = session.pty.onData((chunk) => {
          try { term.write(chunk); } catch {}
        });
      }
      exitDisposeRef.current = session.pty.onExit(() => {
        if (cancelled) return;
        setExited(true);
        // Defer onClose so React finishes the current render first.
        setTimeout(() => onClose?.(), 0);
      });

      // Event-driven repaints — fires only when xterm-headless has a
      // real change to surface. Three streams cover every state
      // transition the user can see:
      //   onWriteParsed — new cells / SGR / cursor placement
      //   onScroll      — buffer scrolled (e.g. claude alt-screen)
      //   onCursorMove  — cursor moved without writing (CSI cup, etc.)
      try { writeSubRef.current  = term.onWriteParsed(() => scheduleRender()); } catch {}
      try { scrollSubRef.current = term.onScroll(()      => scheduleRender()); } catch {}
      try { cursorSubRef.current = term.onCursorMove(()  => scheduleRender()); } catch {}

      // OSC 52 (clipboard) + bell forwarding live on the agent's
      // term for the PtyAgent path (registered in PtyAgent.start).
      // For the legacy path, register them here on the local term so
      // behavior matches.
      if (!termOwnedByAgentRef.current) {
        try {
          term.parser.registerOscHandler(52, (data) => {
            try { process.stdout.write(`\x1b]52;${data}\x07`); } catch {}
            return false;
          });
        } catch {}
        try {
          term.onBell(() => {
            try { process.stdout.write('\x07'); } catch {}
          });
        } catch {}
      }

      // Initial paint as soon as claude prints its banner.
      scheduleRender();

      // Session-file tailing is owned by server/zoomSession.mjs now
      // (it has to outlive PtyPane so the quiet-wait at zoom exit
      // can still forward in-flight events into agent.tail). Nothing
      // to start here.
    } catch (e) {
      setError(e.message || String(e));
    }

    return () => {
      cancelled = true;
      if (renderTimerRef.current) {
        clearTimeout(renderTimerRef.current);
        renderTimerRef.current = null;
      }
      // Unsubscribe the PTY listeners FIRST — otherwise in the
      // attachZoomView path they'd keep firing into a disposed xterm
      // and leak per-zoom listeners across re-zooms.
      try { dataDisposeRef.current?.dispose?.(); } catch {}
      try { exitDisposeRef.current?.dispose?.(); } catch {}
      dataDisposeRef.current = null;
      exitDisposeRef.current = null;
      // Render-trigger subscriptions are PER-MOUNT — always dispose.
      // (For PtyAgent's persistent term, the next zoom mount will
      // re-subscribe; for the legacy path, term itself is disposed
      // below, which makes these moot.)
      try { writeSubRef.current?.dispose?.(); } catch {}
      try { scrollSubRef.current?.dispose?.(); } catch {}
      try { cursorSubRef.current?.dispose?.(); } catch {}
      writeSubRef.current = null;
      scrollSubRef.current = null;
      cursorSubRef.current = null;
      try { disposeRef.current?.(); } catch {}
      // Only dispose the term on the LEGACY path. The PtyAgent path
      // keeps the term alive for the agent's lifetime — that's what
      // gives the user the full scrollback on re-zoom.
      if (!termOwnedByAgentRef.current) {
        try { termRef.current?.dispose?.(); } catch {}
      }
      termRef.current = null;
      cellRef.current = null;
      ptyRef.current = null;
      disposeRef.current = null;
      termOwnedByAgentRef.current = false;
    };
    // We intentionally only run this once per mount — size changes are
    // handled by the resize effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id]);

  // Tailer reattach on sid rotation is now handled inside
  // server/zoomSession.mjs (it owns the tailer's lifecycle so it can
  // outlive PtyPane during the quiet-wait at zoom exit).

  // ── Resize: forward to PTY + emulator when our viewport changes ─
  // tui/App.jsx already subscribes to process.stdout 'resize' and
  // mirrors new dimensions into state — that re-renders Zoom, which
  // recomputes bodyCols/bodyRows, which lands here as new cols/rows
  // props. We forward to both xterm-headless (visible buffer reflow)
  // and node-pty (kernel ioctl → claude sees SIGWINCH and repaints).
  // scrollToBottom is a defensive nudge: on a mid-stream resize the
  // viewport can drift above the live cursor row; snapping back to
  // bottom keeps the cursor visible without prodding claude.
  useEffect(() => {
    const pty = ptyRef.current, term = termRef.current;
    if (!pty || !term) return;
    try { term.resize(cols, rows); } catch {}
    try { pty.resize(cols, rows); } catch {}
    try { term.scrollToBottom(); } catch {}
    setTick(n => (n + 1) | 0);
  }, [cols, rows]);

  // ── Key forwarding ──────────────────────────────────────────────
  // PtyPane is the single useInput handler while focused. We translate
  // Ink key events into raw byte sequences and write them to the PTY,
  // EXCEPT for a few intercepts that the Mission Control chrome owns.
  useInput((input, key) => {
    if (!focus) return;
    const pty = ptyRef.current;
    if (!pty) return;

    // ── Scroll mode ────────────────────────────────────────────
    // While scroll mode is active, w/s/b/f/g/G drive the viewport
    // and nothing is forwarded to claude. Esc exits scroll mode.
    // Any other printable key also exits and re-enters claude input
    // (the keystroke is dropped — typing immediately after scrolling
    // requires one extra tap to "wake up," which is the standard
    // less / vim convention).
    if (scrollMode) {
      const term = termRef.current;
      const maxOffset = term ? Math.max(0, term.buffer.active.length - rows) : 0;
      const halfPage = Math.max(1, Math.floor(rows / 2));
      if (key.escape) { setScrollMode(false); setScrollOffset(0); return; }
      if (input === 'w') { setScrollOffset(o => Math.min(maxOffset, o + 1)); return; }
      if (input === 's') { setScrollOffset(o => Math.max(0, o - 1)); return; }
      if (input === 'b') { setScrollOffset(o => Math.min(maxOffset, o + halfPage)); return; }
      if (input === 'f') { setScrollOffset(o => Math.max(0, o - halfPage)); return; }
      if (input === 'g') { setScrollOffset(maxOffset); return; }
      if (input === 'G') { setScrollOffset(0); return; }
      // Anything else — exit scroll mode and drop the key. The user
      // is signaling "I'm done scrolling"; next keystroke goes to
      // claude as normal.
      setScrollMode(false);
      setScrollOffset(0);
      return;
    }

    // ── mc chrome keys ─────────────────────────────────────────
    // Single source of truth: tui/zoom/zoomKeys.js, verified end-to-end by
    // tests/zoom/zoomKeys.realparser.test.jsx (drives the real bytes through
    // Ink's real parser). Everything NOT matched here falls through to
    // keyToBytes and is forwarded to claude — including Esc (claude cancel /
    // menu back-out), Ctrl+T (claude todos), Ctrl+S (claude stash), Shift+Tab
    // (claude perm-mode cycle), and Ctrl+C (interrupt).
    //
    // Keys are Ctrl+Q/Y/K/U — all in Ink's reliably-parsed 0x01-0x1a range and
    // all unused by claude-code. We do NOT use Ctrl+] / Ctrl+\ : those are
    // 0x1d/0x1c, which Ink delivers as raw bytes with ctrl:false, so a
    // `key.ctrl && input===']'` test is unreachable (the old silent-dead bug).
    const action = classifyZoomKey(input, key);
    if (action === 'SCROLL') { setScrollMode(true); return; }
    if (action === 'TOOLS')  { onToggleTools?.(); return; }
    if (action === 'STATS')  { onToggleStats?.(); return; }
    if (action === 'EXIT')   { onClose?.(); return; }
    if (action === 'NEWLINE') {
      // Insert a newline WITHOUT submitting. Wrapped in bracketed paste when
      // claude has the mode on so it's treated as content, not another submit.
      const term = termRef.current;
      try {
        if (term?.modes?.bracketedPasteMode) pty.write('\x1b[200~\n\x1b[201~');
        else pty.write('\n');
      } catch {}
      return;
    }

    // ── Bracketed paste ────────────────────────────────────────
    // Ink delivers a multi-character paste as a single `input` chunk.
    // Forwarded verbatim, an embedded newline looks identical to a
    // deliberate `↵` (submit) — so pasting a code block submitted
    // line-by-line. When claude has enabled bracketed paste mode
    // (it writes ESC[?2004h; xterm-headless flips term.modes
    // .bracketedPasteMode), wrap multi-char input in CSI 200~ /
    // 201~ so claude treats it as paste rather than typing.
    if (
      input && input.length > 1 &&
      !key.ctrl && !key.meta && !key.shift &&
      !key.return && !key.escape && !key.tab &&
      !key.backspace && !key.delete &&
      !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow &&
      !key.home && !key.end && !key.pageUp && !key.pageDown
    ) {
      const term = termRef.current;
      if (term?.modes?.bracketedPasteMode) {
        try { pty.write('\x1b[200~' + input + '\x1b[201~'); } catch {}
        return;
      }
    }

    const bytes = keyToBytes(input, key);
    if (bytes != null) {
      try { pty.write(bytes); } catch {}
      // Flip status to 'working' the instant the user submits a
      // prompt — otherwise the card sits on 'idle' for the 200-800ms
      // it takes claude to commit the JSONL user event. PtyAgent
      // exposes markUserSubmitted; legacy Agent doesn't (its send()
      // path is the only way prompts reach it, so this issue is
      // PtyAgent-specific). key.return fires for the Enter key.
      if (key.return && typeof agent?.markUserSubmitted === 'function') {
        try { agent.markUserSubmitted(); } catch {}
      }
    }
  }, { isActive: focus });

  // ── Render the visible viewport ─────────────────────────────────
  const term = termRef.current;
  const cell = cellRef.current;
  // Hard-painted cursor: a bright accent block that survives any theme
  // and any underlying cell content. We don't trust Ink's `inverse` for
  // whitespace cells — terminals are inconsistent about painting the
  // inverse background when there's no glyph to invert.
  const cursorStyle = useMemo(() => ({
    backgroundColor: theme?.accent || 'cyan',
    color: theme?.bg || 'black',
  }), [theme?.accent, theme?.bg]);
  const view = useMemo(() => {
    if (!term || !cell) return null;
    const buf = term.buffer.active;
    const cursorY = buf.cursorY;
    const cursorX = buf.cursorX;
    // When scrolled back in history, read from above the live viewport.
    // Clamp so we never go below row 0 of xterm's buffer (which includes
    // scrollback). The cursor only paints when the live viewport is on
    // screen — scrolled-back history shows no cursor.
    const offset = Math.max(0, Math.min(scrollOffset, buf.length - rows));
    const startY = buf.viewportY - offset;
    const cursorInView = offset === 0 && (
      Number.isInteger(cursorY) && cursorY >= 0 && cursorY < rows &&
      Number.isInteger(cursorX) && cursorX >= 0 && cursorX < cols
    );
    const out = [];
    let banner = null;
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(startY + y);
      const cxForRow = (cursorInView && y === cursorY) ? cursorX : -1;
      const runs = rowToRuns(line, cell, cols, cxForRow, cursorStyle);
      // Claude prints its own "update available" notice into this body region.
      // When suppression is on, recognise that row (never the cursor/input
      // row), blank it here, and surface it as `banner` so the parent can show
      // a discrete indicator on the right instead of letting it encroach.
      if (hideUpdateBanner && cxForRow < 0) {
        const hit = matchUpdateBanner(runs.map(r => r.text).join(''));
        if (hit) { banner = hit; out.push([]); continue; }
      }
      out.push(runs);
    }
    return { rows: out, banner };
    // tick drives re-renders; cols/rows already trigger via resize effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, cols, rows, cursorStyle, scrollOffset, hideUpdateBanner]);

  // Report claude's update banner upward (outside render) so Zoom can show a
  // discrete chip. Keyed on the banner text so it only fires when it changes.
  useEffect(() => {
    if (view?.banner) onClaudeUpdate?.(view.banner);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.banner?.text]);

  if (error) {
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <Text color={theme?.red || 'red'}>PTY failed: {error}</Text>
        <Text color={theme?.dim || 'gray'}>press Ctrl+Q to close</Text>
      </Box>
    );
  }

  if (!view) {
    return (
      <Box width={cols} height={rows} flexDirection="column">
        <Text color={theme?.dim || 'gray'}>(launching claude…)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
      {view.rows.map((runs, y) => (
        // Each row is one terminal line — pin its height to 1 and
        // disable text wrapping so claude's "thinking" animation
        // (rapid cursor + style cycling) cannot transiently push a
        // row to two lines and shove every row below it down. Without
        // this, run-count changes during animation cause cascading
        // re-layout and the text "bounces."
        <Text key={y} wrap="truncate">
          {runs.length === 0 ? ' ' : runs.map((r, i) => (
            <Text
              key={i}
              color={r.props.color}
              backgroundColor={r.props.backgroundColor}
              bold={r.props.bold}
              italic={r.props.italic}
              underline={r.props.underline}
              dimColor={r.props.dimColor}
              inverse={r.props.inverse}
              strikethrough={r.props.strikethrough}
            >{r.text}</Text>
          ))}
        </Text>
      ))}
      {scrollMode && (
        <Text>
          <Text color={theme?.accent || 'cyan'} bold>▲ SCROLL </Text>
          <Text color={theme?.fg || 'white'}>{scrollOffset} </Text>
          <Text color={theme?.dim || 'gray'}>· w/s line · b/f half-page · g/G top/bottom · Esc resume claude</Text>
        </Text>
      )}
      {exited && (
        <Text color={theme?.dim || 'gray'}>(claude exited)</Text>
      )}
    </Box>
  );
}

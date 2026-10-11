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
//   1. Binds to the agent's running session via agent.attachZoomView()
//      (0444: it never spawns a claude of its own)
//   2. Reads the agent-owned xterm-headless emulator fed by that session
//   3. Renders the emulator's visible viewport as Ink <Text> rows
//   4. Captures every keystroke and forwards the corresponding raw
//      byte sequence to the PTY (with a few intercepts that the parent
//      Zoom modal owns — toggle tools, toggle stats, cycle perm, exit)

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { clampPtyDims } from '../lib/zoomGeometry.js';
import { Box, Text, useInput } from 'ink';
import { keyToBytes } from './ptyKeys.js';
import { classifyZoomKey } from './zoomKeys.js';
import { rowToRuns, safeLinkUrl } from './ptyCells.js';
import { throttleDecision } from '../lib/leadingThrottle.js';
import { matchUpdateBanner, composerSpan, footerStart } from './claudeBanner.js';
import { dlog } from '../lib/debugLog.js';

// traceKey — MC_DEBUG-gated stdin trace for the zoom exit investigation.
// Logs which keystroke reached the pane and how it was classified, so a repro
// of "Ctrl+Q didn't exit" shows whether the byte arrived at all (missing line →
// not delivered / event-loop starved), classified as EXIT (→ onClose path), or
// was swallowed (e.g. scroll mode). Privacy: the literal `input` is recorded
// ONLY for control/chord keys (ctrl/meta/escape) — never plain typed prompt
// text. No-op unless MC_DEBUG=1 (dlog short-circuits). See tui/lib/debugLog.js.
function traceKey(where, input, key, extra) {
  const chord = !!(key.ctrl || key.meta || key.escape);
  dlog('zoomkey', where, {
    ctrl: !!key.ctrl, meta: !!key.meta, shift: !!key.shift,
    escape: !!key.escape, return: !!key.return, tab: !!key.tab,
    len: input ? input.length : 0,
    input: chord ? input : undefined,   // control/chord only; never typed text
    ...extra,
  });
}

// Upper-bound frame cap on PTY blits. Render is driven by xterm's
// onWriteParsed/onScroll/onCursorMove events (event-driven, not
// polled), but we coalesce bursts so a flood of small writes doesn't
// force React to reconcile 100× per second. 33ms ≈ 30fps: a streaming
// claude response is text, not animation — 30fps is indistinguishable
// from 60fps to the reader but halves the React reconcile + terminal
// blit work (and battery) during a heavy stream.
const RENDER_INTERVAL_MS = 33;

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
  // Timestamp of the last committed paint — drives leading-edge scheduling so a
  // keystroke's echo isn't delayed the full frame interval (see scheduleRender).
  const renderLastRef = useRef(0);
  // onData / onExit disposables. node-pty returns IDisposable from
  // each subscription. The agent's PTY outlives the zoom view, so we MUST
  // unsubscribe or every re-zoom adds another stale listener.
  const dataDisposeRef = useRef(null);
  const exitDisposeRef = useRef(null);
  // 0446: unsubscribes the agent 'change' listener that waits for the
  // successor pty after a changeModel/changePermissionMode respawn.
  const followOffRef = useRef(null);
  // Rows of the emulator's viewport the render window is currently skipping
  // (see the view memo). Read by the scroll-mode key handler so its maximum
  // offset matches the window the user is actually looking at.
  const skipRef = useRef(0);
  // Rows of the CONTENT-ANCHOR skip the reader has walked back through. The
  // pane is often shorter than the emulator, so the nearest history is not in
  // the scrollback at all — it is the rows this window skips to stay pinned to
  // claude's last written line. Scrolling up consumes these first, then the
  // emulator's scrollback.
  const skipBackRef = useRef(0);
  // Render-trigger subscriptions on the term. Disposed on unmount.
  const writeSubRef  = useRef(null);
  const scrollSubRef = useRef(null);
  const cursorSubRef = useRef(null);

  // Lazy tick that forces a re-render after PTY data lands. We coalesce
  // into ~30fps frames so a fast stream doesn't pin the event loop.
  const [tick, setTick] = useState(0);
  const [error, setError] = useState(null);
  const [exited, setExited] = useState(false);
  // 0446: the cap refusal text from agent.capMessage(), shown as a footer
  // notice after zoom refused an Enter or a paste. Cleared on the next
  // accepted submit/paste.
  const [capNotice, setCapNotice] = useState(null);

  // Scroll mode. Activated by Ctrl+F (0x06). Not Ctrl+Y (Cursor chat picker)
  // and not Ctrl+B (New Session filesystem browse).
  // While active, `w` / `s` scroll up / down by one line, `f` / `b`
  // half a page up / down (0392), `g` / `G` jump to top / bottom. `Esc` or any
  // other key exits scroll mode and re-enables claude input. We
  // can't use plain w/s outside of scroll mode because they're
  // typed text letters — see docs/HOTKEYS.md §7.
  const [scrollMode, setScrollMode] = useState(false);
  // scrollOffset is rows above the live cursor row. 0 = follow live
  // output. > 0 = pinned back in history. Capped at the buffer's
  // actual scrollback size in the render path.
  const [scrollOffset, setScrollOffset] = useState(0);
  // 0413: scrolling is the EMULATOR's job, not ours. This pane used to compute
  // its own window as `viewportY - offset`, and viewportY advances one row for
  // every row claude prints — so a reader parked twenty rows back was dragged
  // to the bottom by the output itself while the indicator still claimed
  // twenty. Measured: parked at L062-L080, twenty lines later L082-L100.
  //
  // An absolute row number does not fix it either: once the scrollback is full
  // old lines are evicted and every row number shifts. Measured: parked at
  // L162, forty lines later the same row number held L183.
  //
  // xterm already solves both. `term.scrollLines()` moves its viewport, and it
  // deliberately does NOT snap to the bottom on new output while the user is
  // scrolled back. Verified against the real emulator: parked on L161, forty
  // lines later still L161 (its viewportY moved 161 -> 140 to compensate for
  // the eviction). So we drive its viewport and render whatever it shows.

  // Clamp width/height to sensible minimums. xterm-headless requires
  // cols ≥ 1, rows ≥ 1; claude's UI looks broken below ~30 cols.
  const { cols, rows } = clampPtyDims(Math.floor(width || 80), Math.floor(height || 24));

  // 0404: the scroll-mode hint and the "(claude exited)" notice are children of
  // the SAME fixed-height box as the terminal rows. Rendering `rows` rows plus
  // a footer gives Ink rows+1 children for a height=rows box, and Ink resolves
  // the overflow by dropping lines from the MIDDLE of the view — text goes
  // missing mid-screen the moment you press Ctrl+F (the "misshapen rows while
  // scrolling" half of the duplicated/misshapen-zoom-text report). Reserve the
  // footer's row instead, and keep the hint to exactly one row (truncated).
  // 0446: the cap notice shows only while the cap still holds — after :cap
  // is raised it drops on the next render instead of waiting for a submit.
  const capShown = capNotice && (typeof agent?.capMessage === 'function'
    ? agent.capMessage()
    : capNotice);
  const footerRows = (scrollMode ? 1 : 0) + (exited ? 1 : 0) + (capShown ? 1 : 0);
  const viewRows = Math.max(1, rows - footerRows);

  // ── PTY lifecycle ─────────────────────────────────────────────
  // Attach to the agent's zoom view on mount; detach on unmount. Nothing is
  // spawned here (0444), and size changes come from Fleet.setViewport.
  useEffect(() => {
    let cancelled = false;
    try {
      // PtyAgent and MockAgent expose attachZoomView: bind the viewer to
      // the agent's session AND its persistent xterm-headless emulator. The
      // agent owns the term — its buffer survives zoom enter/exit so re-zoom
      // shows the full conversation.
      // 0444: there is no fallback. The old one called startZoomSession,
      // which spawned a second real claude (with acceptEdits) for any agent
      // without attachZoomView — MockAgent included, so mock mode ran a real
      // claude. An agent without a zoom view (legacy stream-json Agent,
      // FLEET_USE_PTY=0) now gets the "PTY failed" message instead.
      if (typeof agent?.attachZoomView !== 'function') {
        throw new Error('zoom is not supported for this session (no attachZoomView)');
      }
      const session = agent.attachZoomView({ cols, rows });
      if (!session?.term || !session?.cell) {
        throw new Error('zoom view has no terminal');
      }
      // Persistent term from the agent. Do NOT dispose on unmount.
      const term = session.term;
      const cell = session.cell;
      termRef.current = term;
      cellRef.current = cell;
      ptyRef.current = session.pty;
      disposeRef.current = session.dispose;

      // Frame scheduler. Driven by xterm's own buffer-change events below
      // (onWriteParsed fires after the parser commits a write; onScroll/
      // onCursorMove cover viewport changes that don't write new cells).
      // Leading-edge + trailing-coalesce: the FIRST change after an idle gap
      // paints immediately (so a keystroke's echo isn't delayed the full frame
      // interval — the reported zoom typing lag), while a burst of streaming
      // output still coalesces to <=1 render per RENDER_INTERVAL_MS.
      const paint = () => {
        renderLastRef.current = Date.now();
        if (!cancelled) setTick(n => (n + 1) | 0);
      };
      const scheduleRender = () => {
        if (cancelled || renderTimerRef.current) return;
        const { paintNow, scheduleIn } = throttleDecision(Date.now(), renderLastRef.current, RENDER_INTERVAL_MS);
        if (paintNow) { paint(); return; }
        renderTimerRef.current = setTimeout(() => {
          renderTimerRef.current = null;
          paint();
        }, scheduleIn);
      };

      // No PTY data pump here: the agent already pipes its output into its
      // persistent term — subscribing again would double-write every byte
      // (visible as garbled rendering).
      // 0337: attachZoomView now revives a null-pty agent instead of
      // throwing, but guard anyway — a null/absent session.pty (failed
      // revive, or a future caller shape) must fall through to the
      // error banner below, not an unguarded crash here.
      // 0446: the exit listener follows the agent's pty. A changeModel /
      // changePermissionMode respawn stops the mount-time pty on purpose; its
      // exit used to run setExited + onClose and close zoom under the user.
      // An exit from a pty the agent replaced (agent.replacedByRestart) now
      // re-binds to the successor once it is spawned; any other exit still
      // closes zoom as before.
      const bindExit = (pty) => {
        exitDisposeRef.current = pty?.onExit?.(() => {
          if (cancelled) return;
          if (agent?.replacedByRestart?.(pty)) { followSuccessor(pty); return; }
          setExited(true);
          // Defer onClose so React finishes the current render first.
          setTimeout(() => onClose?.(), 0);
        });
      };
      const followSuccessor = (oldPty) => {
        try { exitDisposeRef.current?.dispose?.(); } catch {}
        exitDisposeRef.current = null;
        const tryBind = () => {
          if (cancelled) return true;
          if (agent.killed) {
            setExited(true);
            setTimeout(() => onClose?.(), 0);
            return true;
          }
          if (!agent.pty || agent.pty === oldPty) return false;
          ptyRef.current = agent.pty;
          bindExit(agent.pty);
          return true;
        };
        if (tryBind() || typeof agent?.on !== 'function') return;
        const onChange = () => {
          if (!tryBind()) return;
          agent.off?.('change', onChange);
          followOffRef.current = null;
        };
        agent.on('change', onChange);
        followOffRef.current = () => agent.off?.('change', onChange);
      };
      bindExit(session.pty);

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
      // term (registered in PtyAgent.start).

      // Initial paint as soon as claude prints its banner.
      scheduleRender();
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
      try { followOffRef.current?.(); } catch {}
      followOffRef.current = null;
      dataDisposeRef.current = null;
      exitDisposeRef.current = null;
      // Render-trigger subscriptions are PER-MOUNT — always dispose.
      // The agent's persistent term outlives us; the next zoom mount
      // re-subscribes.
      try { writeSubRef.current?.dispose?.(); } catch {}
      try { scrollSubRef.current?.dispose?.(); } catch {}
      try { cursorSubRef.current?.dispose?.(); } catch {}
      writeSubRef.current = null;
      scrollSubRef.current = null;
      cursorSubRef.current = null;
      try { disposeRef.current?.(); } catch {}
      // Never dispose the term: the agent keeps it alive for its lifetime —
      // that's what gives the user the full scrollback on re-zoom.
      termRef.current = null;
      cellRef.current = null;
      ptyRef.current = null;
      disposeRef.current = null;
    };
    // We intentionally only run this once per mount — size changes are
    // handled by the resize effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id]);

  // ── Resize ──────────────────────────────────────────────────────
  // 0404: an AGENT-OWNED emulator's geometry belongs to the fleet viewport
  // (Fleet.setViewport ← tui/lib/zoomGeometry.js), NOT to this pane's Ink box.
  // Resizing a live claude is never free: it reprints its whole frame at the
  // new width and the pre-resize copy stays in the scrollback, so the
  // conversation appeared twice — once narrow, once full width (measured: one
  // extra copy per widening resize, claude 2.1.220). Our Ink box shrinks every
  // time a toast lands or the stats/todos panel opens, which used to forward
  // straight into pty.resize. It no longer does; the view memo renders the
  // bottom slice of a taller emulator instead.
  //
  // scrollToBottom is a defensive nudge for a reader who is NOT scrolling: on a
  // mid-stream size change the viewport can drift above the live cursor row,
  // and snapping back keeps the cursor visible without prodding claude.
  //
  // 0416: it used to run unconditionally, which threw a scrolled-back reader to
  // the bottom — and `rows` moves in normal use, since Zoom recomputes bodyRows
  // whenever a toast lands or the stats/todos panel opens. xterm's own reflow
  // already holds the offset across a resize (measured: parked at viewportY 256
  // with baseY 278, a 30->29 height change left it at 257/279), so this call was
  // the only thing destroying the position. Skip it in scroll mode; when it does
  // run, reset all three of view, skipBack and scrollOffset the way toBottom()
  // does, so the indicator can't claim an offset the window isn't showing.
  useEffect(() => {
    const pty = ptyRef.current, term = termRef.current;
    if (!pty || !term) return;
    if (!scrollMode) {
      try { term.scrollToBottom(); } catch {}
      skipBackRef.current = 0;
      setScrollOffset(0);
    }
    // The repaint is NOT part of that branch: a parked reader still needs the
    // window redrawn at the new height.
    setTick(n => (n + 1) | 0);
    // scrollMode is read, not tracked — this effect is the RESIZE path, and
    // entering or leaving scroll mode must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, rows]);

  // ── Key forwarding ──────────────────────────────────────────────
  // PtyPane is the single useInput handler while focused. We translate
  // Ink key events into raw byte sequences and write them to the PTY,
  // EXCEPT for a few intercepts that the Mission Control chrome owns.
  useInput((input, key) => {
    // Trace FIRST — before any early-return — so the log shows the keystroke
    // even when it's dropped for lack of focus/pty or swallowed by scroll mode.
    traceKey('ptypane', input, key, {
      focus, hasPty: !!ptyRef.current, scrollMode,
      action: classifyZoomKey(input, key),
    });
    if (!focus) return;
    const pty = ptyRef.current;
    if (!pty) return;
    // 0446: every write goes through the agent's guarded input path. The
    // cached ptyRef is the pty from MOUNT time; after a changeModel /
    // changePermissionMode respawn it is dead, and writing to it also skipped
    // the cost cap. agent.writeInput writes to the current pty and refuses
    // submit/paste once capped. The raw pty.write fallback is only for an
    // agent without it (0444: every runtime agent with a zoom view has it).
    const write = (bytes, opts = {}) => {
      if (typeof agent?.writeInput === 'function') {
        const ok = agent.writeInput(bytes, opts) !== false;
        if (opts.submit || opts.paste) {
          const capText = ok ? null : (agent.capMessage?.() || null);
          setCapNotice(capText);
        }
        return ok;
      }
      try { pty.write(bytes); return true; } catch { return false; }
    };

    // ── Scroll mode ────────────────────────────────────────────
    // While scroll mode is active, w/s/b/f/g/G drive the viewport
    // and nothing is forwarded to claude. Esc exits scroll mode.
    // Any other printable key also exits and re-enters claude input
    // (the keystroke is dropped — typing immediately after scrolling
    // requires one extra tap to "wake up," which is the standard
    // less / vim convention).
    if (scrollMode) {
      const term = termRef.current;
      // Matches the view memo's clamp exactly: baseY + the rows the window is
      // currently skipping is the offset at which startY reaches buffer row 0.
      const halfPage = Math.max(1, Math.floor(viewRows / 2));
      const readOffset = () => {
        const b = term.buffer.active;
        return Math.max(0, b.baseY - b.viewportY) + (skipBackRef.current || 0);
      };
      // Negative moves up. Going up, walk back through the skipped viewport
      // rows first, then into the emulator's scrollback. Coming down, undo them
      // in the opposite order. The emulator clamps its own end; we clamp ours.
      const moveBy = (lines) => {
        if (!term) return;
        // 0419: movement must obey the same two rules the renderer does, or a
        // keypress is spent on a region the window is not showing.
        //
        // 0416 stopped the resize effect resetting the view while the reader is
        // scrolling — correct, it was throwing them to the bottom — but that
        // left skipBackRef carrying a value denominated in the OLD geometry.
        // `skip` is recomputed from the pane height on every render (:561), so
        // shrinking the pane by N rows RAISES skip by N and opens N units of
        // phantom `room` below. moveBy spends that room first and only calls
        // scrollLines with the remainder, while the view memo refuses to apply
        // the skip at all once the emulator is scrolled back (:590,
        // `scrolledBack > 0 ? 0 : effSkip`). So N presses moved the SCROLL
        // counter and zero rendered rows. Measured at HEAD, parked at back=19
        // with the pane going 20->12: eight presses all rendered the same top
        // row while the footer counted 41 through 48.
        //
        // In the app the trigger needs no keystroke: App.jsx:2111 recomputes
        // the zoom height from the toast count, and Zoom.jsx:214 subtracts the
        // todo panel, so a toast landing or claude editing its todo list
        // resizes the pane under a parked reader.
        //
        // Do NOT fix this by restoring the unconditional reset — that brings
        // back the snap-to-bottom 0416 removed.
        const bNow = term.buffer.active;
        const backNow = Math.max(0, bNow.baseY - bNow.viewportY);
        // Rule 1: skipBack can never exceed the skip region that exists now.
        // Covers the mirror case, where the pane GAINS rows and skip falls
        // below a surviving skipBack, stranding the downward path.
        skipBackRef.current = Math.min(skipBackRef.current || 0, skipRef.current || 0);
        let n = Math.abs(lines);
        if (lines < 0) {
          // Rule 2: while scrolled back the renderer ignores the skip, so there
          // is no skip room to spend — every press must reach the emulator.
          const room = backNow > 0
            ? 0
            : Math.max(0, (skipRef.current || 0) - (skipBackRef.current || 0));
          const take = Math.min(room, n);
          if (take > 0) { skipBackRef.current = (skipBackRef.current || 0) + take; n -= take; }
          if (n > 0) term.scrollLines(-n);
        } else if (lines > 0) {
          const b = term.buffer.active;
          const inScrollback = Math.max(0, b.baseY - b.viewportY);
          const take = Math.min(inScrollback, n);
          if (take > 0) { term.scrollLines(take); n -= take; }
          if (n > 0) skipBackRef.current = Math.max(0, (skipBackRef.current || 0) - n);
        }
        setScrollOffset(readOffset());
      };
      const toBottom = () => {
        if (!term) return;
        term.scrollToBottom();
        skipBackRef.current = 0;
        setScrollOffset(0);
      };
      if (key.escape) { setScrollMode(false); toBottom(); return; }
      // Ignore Ctrl/Meta chords here — Ctrl+F enters scroll mode (0420) and Ink
      // still sets input==='f' with ctrl:true; without this gate Ctrl+F while
      // scrolling would half-page up (bare `f`). Same for bare `g` / `b`.
      if (key.ctrl || key.meta) return;
      if (input === 'w') { moveBy(-1); return; }
      if (input === 's') { moveBy(1); return; }
      // 0392: f = half-page UP, b = half-page DOWN (toward bottom) — swapped
      // from the less-style b-back/f-forward on user request so f pairs with
      // w (up) and b pairs with s (down).
      if (input === 'f') { moveBy(-halfPage); return; }
      if (input === 'b') { moveBy(halfPage); return; }
      if (input === 'g') { if (term) { skipBackRef.current = skipRef.current || 0; term.scrollToTop(); setScrollOffset(readOffset()); } return; }
      if (input === 'G') { toBottom(); return; }
      // Anything else — exit scroll mode and drop the key. The user
      // is signaling "I'm done scrolling"; next keystroke goes to
      // claude as normal.
      setScrollMode(false);
      toBottom();
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
    // Keys are Ctrl+Q/B/K/U — all in Ink's reliably-parsed 0x01-0x1a range and
    // all unused by claude-code. We do NOT use Ctrl+] / Ctrl+\ : those are
    // 0x1d/0x1c, which Ink delivers as raw bytes with ctrl:false, so a
    // `key.ctrl && input===']'` test is unreachable (the old silent-dead bug).
    const action = classifyZoomKey(input, key);
    if (action === 'SCROLL') { setScrollMode(true); return; }
    if (action === 'TOOLS')  { onToggleTools?.(); return; }
    if (action === 'STATS')  { onToggleStats?.(); return; }
    if (action === 'EXIT')   { dlog('zoomkey', 'exit→onClose', { from: 'ptypane' }); onClose?.(); return; }
    if (action === 'NEWLINE') {
      // Insert a newline WITHOUT submitting. Wrapped in bracketed paste when
      // claude has the mode on so it's treated as content, not another submit.
      const term = termRef.current;
      if (term?.modes?.bracketedPasteMode) write('\x1b[200~\n\x1b[201~');
      else write('\n');
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
    // 0446: isPaste is computed once and also flags the paste-mode-OFF case
    // below — a multi-char chunk forwarded raw through keyToBytes is still a
    // paste for the cost cap.
    const isPaste = !!(
      // 0446: count code points, not UTF-16 units — one emoji is a key, not
      // a paste the cost cap would refuse.
      input && Array.from(input).length > 1 &&
      !key.ctrl && !key.meta && !key.shift &&
      !key.return && !key.escape && !key.tab &&
      !key.backspace && !key.delete &&
      !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow &&
      !key.home && !key.end && !key.pageUp && !key.pageDown
    );
    if (isPaste) {
      const term = termRef.current;
      if (term?.modes?.bracketedPasteMode) {
        write('\x1b[200~' + input + '\x1b[201~', { paste: true });
        return;
      }
    }

    const bytes = keyToBytes(input, key);
    if (bytes != null) {
      const accepted = write(bytes, { submit: !!key.return, paste: isPaste });
      // 0446: a refused Enter (cost cap) must not flip the card to working.
      if (!accepted) return;
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
  //
  // Cursor CLI already draws its own caret in the PTY — painting ours on
  // top yields two cursors (0420 product note). Claude's TUI often needs
  // the hard paint; only skip it when the agent says so.
  const paintHardCursor = agent?.paintHardCursor !== false;
  const cursorStyle = useMemo(() => ({
    backgroundColor: theme?.accent || 'cyan',
    color: theme?.bg || 'black',
  }), [theme?.accent, theme?.bg]);
  const view = useMemo(() => {
    if (!term || !cell) return null;
    const buf = term.buffer.active;
    const cursorY = buf.cursorY;
    const cursorX = buf.cursorX;
    // 0404: the emulator can be TALLER than our Ink box — its geometry is
    // fixed for the agent's life (see the resize effect), while this box loses
    // rows to toasts and the optional stats/todos panels. So we render a
    // window into claude's viewport and skip some of its rows.
    //
    // Anchor that window on claude's LAST WRITTEN row, not on the emulator's
    // last row. claude renders inline: below its composer sit however many
    // blank rows the transcript hasn't reached yet. Measured on a real session
    // at 40 rows: 9 trailing blanks. Skipping from the bottom would have
    // rendered those blanks and dropped 9 rows of real content off the TOP —
    // worst on a short or just-cleared transcript. The anchor is whichever sits
    // FURTHER DOWN: the last non-blank row, or the cursor row (an empty
    // composer line holds the cursor and no glyphs). skip stays 0 whenever
    // claude's content already fits in the window.
    const maxSkip = Math.max(0, (term.rows || viewRows) - viewRows);
    let skip = 0;
    if (maxSkip > 0) {
      let lastContent = 0;
      for (let y = (term.rows || viewRows) - 1; y >= 0; y--) {
        const l = buf.getLine(buf.viewportY + y);
        if (l && l.translateToString(true).trim() !== '') { lastContent = y; break; }
      }
      const anchor = Math.max(lastContent, Number.isInteger(cursorY) ? cursorY : 0);
      skip = Math.min(maxSkip, Math.max(0, anchor - viewRows + 1));
    }
    skipRef.current = skip;
    // Same guard horizontally: never read past the emulator's last column.
    const readCols = Math.min(cols, term.cols || cols);
    // When scrolled back in history, read from above the live viewport.
    // baseY + skip is exactly the offset at which startY reaches row 0 of
    // xterm's buffer (which includes scrollback), so it is the real maximum —
    // clamping on buf.length - viewRows instead would allow offsets that just
    // sit at the top and make the last few scroll steps do nothing. The cursor
    // only paints when the live viewport is on screen — scrolled-back history
    // shows no cursor.
    // The emulator owns the scroll position, so render its viewport as-is.
    // `skip` only exists to anchor the LIVE view on claude's last written row;
    // applying it while scrolled back would stop the reader ever reaching the
    // first row of history, which an existing test catches.
    const scrolledBack = Math.max(0, buf.baseY - buf.viewportY);
    // Walking back through the skipped rows moves the window up inside the
    // viewport; once they are used up, the emulator's own scroll takes over.
    const effSkip = Math.max(0, skip - (skipBackRef.current || 0));
    const startY = Math.max(0, buf.viewportY + (scrolledBack > 0 ? 0 : effSkip));
    const offset = scrolledBack + (skipBackRef.current || 0);
    // Cursor row in OUR coordinates: claude's row minus the rows we skipped.
    const cursorRow = cursorY - skip;
    const cursorInView = paintHardCursor && offset === 0 && (
      Number.isInteger(cursorRow) && cursorRow >= 0 && cursorRow < viewRows &&
      Number.isInteger(cursorX) && cursorX >= 0 && cursorX < readCols
    );
    // 0429: rows of claude's composer are never banner candidates — the
    // user's own prose can match the banner wording. Located from the live
    // cursor even when mc does not paint its own (Cursor sessions).
    // 0438: rows of claude's footer (below the composer's bottom rule) are
    // matched but never blanked — the update notice shares a row with the
    // mode line, so blanking it hid "shift+tab to cycle".
    let composer = null;
    let footer = null;
    if (hideUpdateBanner && offset === 0) {
      const texts = [];
      for (let y = 0; y < viewRows; y++) texts.push(buf.getLine(startY + y)?.translateToString(true) ?? '');
      composer = composerSpan(texts, cursorRow);
      footer = footerStart(texts, cursorRow);
    }
    // 0472: resolve OSC 8 link ids to URLs so link text can be written back
    // out as a link. claude writes ONLY the title inside OSC 8 when it thinks
    // the host terminal follows links, so dropping the link drops the URL —
    // an artifact link claude drew that way had nothing to open. The lookup
    // is xterm-internal (no public API in @xterm/headless 6.0.0); if it moves,
    // links fall back to plain text.
    const linkOf = (id) => {
      try { return safeLinkUrl(term._core?._oscLinkService?.getLinkData(id)?.uri); }
      catch { return undefined; }
    };
    const out = [];
    let banner = null;
    for (let y = 0; y < viewRows; y++) {
      const line = buf.getLine(startY + y);
      const cxForRow = (cursorInView && y === cursorRow) ? cursorX : -1;
      const runs = rowToRuns(line, cell, readCols, cxForRow, cursorStyle, linkOf);
      // Claude prints its own "update available" notice into this body region.
      // When suppression is on, recognise that row (never a composer or cursor
      // row), blank it here, and surface it as `banner` so the parent can show
      // a discrete indicator on the right instead of letting it encroach.
      const inComposer = composer && y >= composer[0] && y <= composer[1];
      if (hideUpdateBanner && cxForRow < 0 && !inComposer) {
        const hit = matchUpdateBanner(runs.map(r => r.text).join(''));
        if (hit) {
          banner = hit;
          if (footer == null || y < footer) { out.push([]); continue; }
        }
      }
      out.push(runs);
    }
    return { rows: out, banner };
    // tick drives re-renders; cols/rows already trigger via resize effect.
    // viewRows is in the deps because entering scroll mode reserves a row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, cols, rows, viewRows, cursorStyle, scrollOffset, hideUpdateBanner, paintHardCursor]);

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
            >{r.link ? `\x1b]8;;${r.link}\x1b\\${r.text}\x1b]8;;\x1b\\` : r.text}</Text>
          ))}
        </Text>
      ))}
      {scrollMode && (
        // wrap="truncate" keeps this to the ONE row reserved by footerRows. Let
        // it wrap and the box overflows, which makes Ink drop terminal rows
        // from the middle of the view.
        <Text wrap="truncate">
          <Text color={theme?.accent || 'cyan'} bold>▲ SCROLL </Text>
          <Text color={theme?.fg || 'white'}>{scrollOffset} </Text>
          <Text color={theme?.dim || 'gray'}>· w/s line · f/b half-page up/down · g/G top/bottom · Esc resume claude</Text>
        </Text>
      )}
      {capShown && (
        <Text color={theme?.red || 'red'} wrap="truncate">{capShown}</Text>
      )}
      {exited && (
        <Text color={theme?.dim || 'gray'} wrap="truncate">(claude exited)</Text>
      )}
    </Box>
  );
}

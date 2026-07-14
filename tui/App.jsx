// tui/App.jsx — top-level Ink component.
//
// Owns: hotkeys, focus, modal routing, settings persistence, fleet
// subscription, toast queue, command-bar state. The Fleet (passed in as a
// prop) is the authoritative source of agent state — we mirror its snapshot
// into React state on every 'change' event. All actions (launch, pause,
// resume, kill, broadcast, message) round-trip through the fleet so the
// in-card tails and the bottom fleet log always reflect what's actually
// happening to the underlying claude subprocesses.

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import Header   from './Header.jsx';
import Aggregate from './Aggregate.jsx';
import Card     from './Card.jsx';
import FleetLog, { deriveFleetLog } from './FleetLog.jsx';
import StatusBar from './StatusBar.jsx';

import Help        from './modals/Help.jsx';
import QuitConfirm from './modals/QuitConfirm.jsx';
import Broadcast   from './modals/Broadcast.jsx';
import Dashboard   from './modals/Dashboard.jsx';
import NewSession  from './modals/NewSession.jsx';
import Settings    from './modals/Settings.jsx';
import Zoom        from './modals/Zoom.jsx';
import RepoPicker  from './modals/RepoPicker.jsx';

import { THEMES, DEFAULT_THEME } from './lib/themes.js';
import { MODELS } from './lib/models.js';
import { probeAll, saveModelCache, applyCacheToCatalog } from './lib/modelProbe.js';
import { SPARK_SCALE } from '../server/spark.mjs';
import { loadSettings, saveSettings } from './lib/settings.js';
import { nextLaunchSlot } from './lib/slots.js';
import { computeGridLayout, chunkRows } from './lib/gridLayout.js';
import { CostStore } from './lib/costStore.js';
import { syncFromSnapshot, getResumeRecord, listResumeRecords, listOpenResumeRecords, clearResumeRecord, listHistory, setQuitMode } from './lib/sessionStore.js';
import { getTemplate, listTemplates } from './lib/templateStore.js';
import { probeAuth, authSummary } from './lib/auth.js';
import { versionLine } from './lib/version.js';
import { readUsage, fmtReset } from './lib/usage.js';
import { dlog } from './lib/debugLog.js';
import { postSlack } from './lib/slack.js';
import { listRecentRepos } from '../server/repos.mjs';
import { transcriptPathFor, TRANSCRIPT_BASE_DIR } from '../server/agent.mjs';
import { getConfigDir } from './lib/configDir.js';
import { isDebugKeysActive, setDebugKeysActive, clearDebugKeysLog, DEBUG_KEYS_PATH } from './lib/debugKeys.js';
import { appendMemoryNote, readProjectMemory, injectMemoryIntoPrompt, memoryPathFor } from './lib/projectMemory.js';
import { isPluginEnabled } from './lib/plugins.js';
import { listIssuesForCwd } from './lib/tasks.js';
import { fmtClock, fmtDuration, fmtMoney } from './lib/format.js';

// Permission modes claude CLI accepts. Source: `claude --help`.
//   default              — prompt on every potentially-mutating tool
//   acceptEdits          — auto-approve file edits, prompt on bash/etc.
//   auto                 — model decides; light-touch prompts
//   plan                 — read-only planning; no edits issued
//   dontAsk              — never prompt; for safe/observed sessions
//   bypassPermissions    — no guardrails. Scratch dirs only.
const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'];

// Toast kinds drive color. Auto-dismissed by a timer in App.
const TOAST_COLORS = { error: 'red', warn: 'yellow', info: 'accent', ok: 'green' };

export default function App({ fleet, auth: initialAuth }) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [snapshot, _setSnapshot] = useState(() => fleet.snapshot());
  // Mirror snapshot into a ref so background loops (tick interval,
  // resize handlers, etc.) can read the current value without listing
  // `snapshot` in their effect deps. Listing it would tear down + rebuild
  // the interval every time the fleet emits a change → re-render loop
  // (audit #57). The ref read is sync and always points to the last
  // committed render's snapshot.
  const snapshotRef = useRef(snapshot);
  const setSnapshot = (snap) => {
    snapshotRef.current = snap;
    _setSnapshot(snap);
  };
  const [settings, setSettingsState] = useState(loadSettings);
  const [theme, setTheme] = useState(() => THEMES[settings.theme] || THEMES[DEFAULT_THEME]);
  const [auth, setAuth] = useState(initialAuth || null);
  const [usage, setUsage] = useState(() => readUsage());

  const [focusedSlot, setFocusedSlot] = useState(1);
  const [modal, setModal] = useState(null);  // null | 'help' | 'bcast' | 'new' | 'settings' | 'zoom'
  const [helpView, setHelpView] = useState('main'); // which section Help should highlight
  const [newSlot, setNewSlot] = useState(null);
  const [zoomedId, setZoomedId] = useState(null);
  const [repos, setRepos] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [aggSpark, setAggSpark] = useState(() => Array(22).fill(1));

  // Force re-render bumper, used by SIGWINCH listener so cardW recomputes
  // when the user resizes the terminal.
  const [, bumpResize] = useState(0);
  const [termSize, setTermSize] = useState({ cols: stdout.columns || 180, rows: stdout.rows || 50 });

  // Toast queue. Each entry: { id, kind: 'error'|'warn'|'info'|'ok', text, expiresAt }
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(1);

  // Weekly cost store — singleton across the app's lifetime.
  const costStoreRef = useRef(null);
  if (!costStoreRef.current) costStoreRef.current = new CostStore();
  const [weekCost, setWeekCost] = useState(() => costStoreRef.current.weekCost());
  const [dayCost, setDayCost] = useState(() => costStoreRef.current.dayCost());

  // Command bar state.
  //  mode: 'normal' | 'filter' | 'command'
  //  buffer: typed text
  //  filterActive: latched query (set on Enter; cleared on / again or Esc-on-empty)
  const [cmdMode, setCmdMode] = useState('normal');
  const [cmdBuffer, setCmdBuffer] = useState('');
  const [filterActive, setFilterActive] = useState('');

  // Destructive-action arming: K and :kill require a second confirmation
  // press within 3s. The ref form (not useState) keeps the read/write
  // path inside the useInput closure synchronous — a React state update
  // wouldn't be visible to the keypress arriving 50ms later.
  const pendingKillRef = useRef(null);     // { id, slot, timer } | null
  const KILL_ARM_MS = 3000;

  // ── Fleet subscription ──────────────────────────────────
  useEffect(() => {
    const onChange = (snap) => setSnapshot(snap);
    fleet.on('change', onChange);
    setSnapshot(fleet.snapshot());
    dlog('app', 'boot', { slots: fleet.slots });
    return () => { fleet.off('change', onChange); dlog('app', 'shutdown', {}); };
  }, [fleet]);

  // ── Settings persistence + theme application ────────────
  useEffect(() => {
    saveSettings(settings);
    setTheme(THEMES[settings.theme] || THEMES[DEFAULT_THEME]);
  }, [settings]);

  // ── Slow clock for header/aggregate derived stats ───────
  // Also refreshes the fleet snapshot every tick so DERIVED fields
  // (stuckMin, time-since-anything) keep advancing even when no agent
  // is actively emitting events. Without this re-fetch, a silently-
  // stuck slot never re-renders and the user never sees the STUCK chip.
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      const fresh = fleet.snapshot();
      setSnapshot(fresh);
      // Read via ref — snapshot is no longer in our dep array so we'd
      // otherwise be looking at stale state. We use `fresh` directly
      // since we just produced it; the ref is for OTHER readers (resize,
      // shutdown) that don't have a fresh snapshot in hand.
      const live = fresh.agents.filter(a => a.status !== 'empty');
      const rate = live.reduce((s, a) => {
        const sp = a.spark || [];
        return s + (sp[sp.length - 1] || 0);
      }, 0);
      setAggSpark(prev => [...prev.slice(1), Math.max(1, rate)]);
    }, Math.max(300, settings.tickRate));
    return () => clearInterval(t);
  }, [settings.tickRate, fleet]);

  // ── Resize handling ─────────────────────────────────────
  // Node's process.stdout emits 'resize' on SIGWINCH; Ink doesn't re-flow
  // automatically. We mirror the new dimensions into state so the per-card
  // width computation re-runs and the Box width=... below picks up.
  useEffect(() => {
    if (!stdout || typeof stdout.on !== 'function') return;
    const onResize = () => {
      setTermSize({ cols: stdout.columns || 180, rows: stdout.rows || 50 });
      bumpResize(n => n + 1);
    };
    stdout.on('resize', onResize);
    return () => stdout.off?.('resize', onResize);
  }, [stdout]);

  // ── One-shot auth-status banner ────────────────────────
  // Convert the preflight result into a toast on first render so the user
  // sees their account inside the TUI (the stdout banner scrolls past
  // once Ink takes over the screen).
  useEffect(() => {
    if (!auth) return;
    if (auth.ok) {
      pushToast(authSummary(auth), 'ok');
    } else {
      pushToast(authSummary(auth), 'error');
      pushToast(`run :auth to re-probe, or quit and \`claude auth login\``, 'warn');
    }
    // Run exactly once on boot; subsequent re-probes happen via :auth/:whoami.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Repo discovery (refreshed when opening NewSession) ──
  // settings.repoParents (when set) replaces the built-in scan dirs; passed
  // through so a folder picked in RepoPicker takes effect immediately.
  const refreshRepos = async () => {
    try {
      const r = await listRecentRepos({ limit: 30, parents: settings.repoParents });
      setRepos(r);
    } catch { /* best-effort */ }
  };
  useEffect(() => { refreshRepos(); }, []);
  useEffect(() => { if (modal === 'new') refreshRepos(); }, [modal]);

  // ── Saved-session hint (or auto-resume) on boot ─────────
  // If there are any persisted sessions and every slot is currently
  // empty, either surface a `:resume-all` toast (default) or actually
  // bulk-resume them (when settings.autoResumeOnStart is true). Run once
  // on mount; defer slightly so the initial fleet snapshot and toast
  // system are both ready.
  useEffect(() => {
    const t = setTimeout(() => {
      // Hint/auto-resume reflect the open-at-close set — the same set
      // `:resume-all` will restart — so the count the user sees matches.
      const recs = listOpenResumeRecords();
      if (recs.length === 0) return;
      const snap = fleet.snapshot();
      const anyLive = snap.agents.some(a => a.status !== 'empty');
      if (anyLive) return;
      if (settings.autoResumeOnStart) {
        const { scheduled, total } = resumeAllSessions(snap.agents);
        pushToast(`auto-resuming ${scheduled}/${total} saved session${total === 1 ? '' : 's'}`, scheduled ? 'ok' : 'info');
      } else {
        pushToast(`${recs.length} saved session${recs.length === 1 ? '' : 's'} — :resume-all to restore`, 'info');
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Re-scan whenever the configured locations change (join → stable dep so
  // we don't loop on array identity).
  useEffect(() => { refreshRepos(); }, [settings.repoParents.join(':')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Toast auto-dismiss ──────────────────────────────────
  useEffect(() => {
    if (toasts.length === 0) return;
    const next = Math.min(...toasts.map(t => t.expiresAt));
    const t = setTimeout(() => {
      const cutoff = Date.now();
      setToasts(prev => prev.filter(x => x.expiresAt > cutoff));
    }, Math.max(50, next - Date.now()));
    return () => clearTimeout(t);
  }, [toasts]);

  const pushToast = (text, kind = 'info') => {
    const id = toastIdRef.current++;
    const expiresAt = Date.now() + (settings.toastDurationMs || 4000);
    setToasts(prev => [...prev.slice(-3), { id, kind, text, expiresAt }]);
  };

  // ── Cost store wiring ───────────────────────────────────
  // Whenever the fleet emits a new snapshot, fold cost deltas into the
  // weekly bucket. The store handles its own persistence + ISO-week
  // rotation. We also overlay costWeek onto every live agent so the
  // existing card/zoom rendering picks up the persisted value rather than
  // the per-process figure (which always equals costSession).
  useEffect(() => {
    const store = costStoreRef.current;
    const { weekCost: wk, dayCost: dy } = store.update(snapshot.agents);
    setWeekCost(wk);
    setDayCost(dy);
  }, [snapshot]);

  // Propagate the per-slot cost cap from settings down to the fleet
  // whenever it changes. The fleet pushes the value to every live
  // Agent and uses it as the default for new launches.
  useEffect(() => {
    fleet.setCostCap(settings.costCapUSD || 0);
  }, [settings.costCapUSD, fleet]);

  // Periodic GC of lastSeen entries for dead sessions.
  useEffect(() => {
    const t = setInterval(() => { costStoreRef.current.gc(snapshot.agents); }, 30000);
    return () => clearInterval(t);
  }, [snapshot]);

  // ── Session persistence (for resume) ───────────────────
  // Mirror every snapshot into ~/.config/claude-mc/sessions.json so the
  // user can resume yesterday's sessions tomorrow. The store debounces
  // its own writes (only updates lastSeen every 60s).
  useEffect(() => {
    syncFromSnapshot(snapshot.agents, { historyLimit: settings.sessionHistoryLimit ?? 20 });
  }, [snapshot, settings.sessionHistoryLimit]);

  // ── Stuck-detection toast ─────────────────────────────
  // Toast exactly once when a slot enters the stuck state (stuckMin
  // transitions from 0 → >0). Re-fire suppressed until the slot clears
  // (which happens automatically when the agent emits its next event).
  const stuckAlertRef = useRef(new Set());
  useEffect(() => {
    const fired = stuckAlertRef.current;
    for (const a of snapshot.agents) {
      if (a.status === 'empty') continue;
      const key = `${a.slot}`;
      if (a.stuckMin > 0) {
        if (!fired.has(key)) {
          fired.add(key);
          pushToast(`slot ${a.slot} · stuck ${a.stuckMin}m · no events while ${a.status}`, 'warn');
        }
      } else {
        fired.delete(key);
      }
    }
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Context-pressure warnings ──────────────────────────
  // Track which slot crossed which threshold so we toast exactly once
  // per crossing (not on every snapshot the agent is over the line).
  // Keys: `${slot}:80` / `${slot}:90`. Reset for a slot when it drops
  // back under the threshold — re-arming for the next compaction cycle.
  const ctxAlertRef = useRef(new Set());
  useEffect(() => {
    const fired = ctxAlertRef.current;
    for (const a of snapshot.agents) {
      if (a.status === 'empty') continue;
      const model = MODELS[a.model];
      if (!model) continue;
      const pct = (a.context || 0) / model.maxCtx;
      const k80 = `${a.slot}:80`;
      const k90 = `${a.slot}:90`;
      if (pct >= 0.9) {
        if (!fired.has(k90)) {
          fired.add(k90);
          pushToast(`slot ${a.slot} · context 90%+ · /compact or restart soon`, 'error');
        }
      } else if (pct >= 0.8) {
        if (!fired.has(k80)) {
          fired.add(k80);
          pushToast(`slot ${a.slot} · context 80% · consider /compact`, 'warn');
        }
        // Crossed back under 90% — re-arm the 90 trigger.
        fired.delete(k90);
      } else {
        // Dropped under 80% (post-compaction usually) — re-arm both.
        fired.delete(k80);
        fired.delete(k90);
      }
    }
    // GC entries for slots that no longer exist.
    const liveSlots = new Set(snapshot.agents.filter(a => a.status !== 'empty').map(a => a.slot));
    for (const key of [...fired]) {
      const slot = parseInt(key.split(':')[0], 10);
      if (!liveSlots.has(slot)) fired.delete(key);
    }
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Plan-side usage poller ─────────────────────────────
  // Re-read claude's rate-limit telemetry every 8s. The file is written
  // by claude itself on each turn, so this is cheap (small JSON on local
  // disk) and gives us near-real-time 5h / 7d quota visibility.
  useEffect(() => {
    const t = setInterval(() => {
      const u = readUsage();
      if (u) setUsage(u);
    }, 8000);
    return () => clearInterval(t);
  }, []);

  // ── Derived ─────────────────────────────────────────────
  const agentsRaw = snapshot.agents;
  // Stamp the persisted week cost onto each live agent so cards/zoom render
  // the rolling weekly total. (costStore.weekCost is the fleet total — we
  // attribute it uniformly to every live agent for the display; a future
  // per-agent attribution would store per-id weekly buckets, but right now
  // claude only reports per-turn totals.)
  const agents = useMemo(() => agentsRaw.map(a => (
    a.status === 'empty' ? a : { ...a, costWeek: weekCost }
  )), [agentsRaw, weekCost]);

  // Filter pass — when filterActive is set, dim non-matching cards. We
  // don't reflow the grid; the slot index is part of the user's muscle
  // memory.
  const filterMatches = (a) => {
    if (!filterActive) return true;
    if (a.status === 'empty') return false;
    const q = filterActive.toLowerCase();
    return [a.name, a.branch, a.model, a.status]
      .some(v => (v || '').toString().toLowerCase().includes(q));
  };

  const focusedAgent = agents.find(a => a.slot === focusedSlot) || agents[0];
  // For zoom we MUST pass the live Agent / PtyAgent instance, not the
  // toJSON snapshot in `agents`. PtyPane's attachZoomView path
  // (single-pipeline rewrite) duck-types on agent.attachZoomView ===
  // 'function'; on a plain snapshot object that method is missing so
  // PtyPane falls back to startZoomSession which spawns a SECOND
  // claude against the same session file. The two compete, then the
  // legacy dispose kills the original on exit — the exact "claude
  // stopped thinking and no output exists" symptom users hit on the
  // first re-zoom.
  //
  // The legacy stream-json Agent path (FLEET_USE_PTY=0) is ALSO
  // happier with the live instance because startZoomSession reads
  // agent.proc / mutates agent.sessionId — both no-ops on a snapshot.
  const zoomedAgent  = zoomedId
    ? (fleet.agentById(zoomedId) || agents.find(a => a.id === zoomedId))
    : null;

  // If the focused slot is empty (e.g., the user just killed it) and
  // there's another live agent, slide focus to the nearest live one so
  // hotkeys keep working without an extra arrow press.
  useEffect(() => {
    if (!focusedAgent || focusedAgent.status !== 'empty') return;
    const live = agents.filter(a => a.status !== 'empty');
    if (live.length === 0) return;
    const before = live.filter(a => a.slot < focusedSlot).pop();
    const after  = live.find(a => a.slot > focusedSlot);
    setFocusedSlot((before || after || live[0]).slot);
  }, [focusedSlot, agents]); // eslint-disable-line react-hooks/exhaustive-deps
  const threshold = settings.ctxThreshold;
  // NOTE: fleetLogLines passed here is the LOWER bound; the actual
  // render uses dynamicFleetLogLines computed below. We derive the
  // largest plausible window here so the FleetLog has rows to draw
  // from when the terminal is tall.
  const fleetLog = useMemo(
    () => deriveFleetLog(agents, Math.max(40, settings.fleetLogLines), settings.fleetLogMode),
    [agents, settings.fleetLogLines, settings.fleetLogMode]
  );
  const fleetTpm = useMemo(() => {
    return Math.round(agents.reduce((s, a) => {
      if (a.status === 'empty' || a.status === 'paused' || a.status === 'error') return s;
      const sp = a.spark || [];
      const r = sp.slice(-3).reduce((x, y) => x + y, 0) / Math.max(1, sp.slice(-3).length);
      return s + r * SPARK_SCALE;
    }, 0));
  }, [agents]);
  const sessionStr = fmtDuration(now - snapshot.sessionStart);
  const nowStr = fmtClock(now, settings.clock24);

  // ── Command bar processing ──────────────────────────────
  // Run `:cmd args` against a tiny dispatch table. Returns a status string
  // for the toast (or null to swallow).
  const runCommand = (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    if (!cmd) return null;
    switch (cmd) {
      case 'q':
      case 'quit':
        exit();
        return null;
      case 'theme': {
        if (!arg) { pushToast(`current theme: ${settings.theme}`, 'info'); return null; }
        const match = Object.keys(THEMES).find(k => k.toLowerCase().includes(arg.toLowerCase()));
        if (!match) { pushToast(`no theme matches "${arg}"`, 'warn'); return null; }
        setSettingsState(s => ({ ...s, theme: match }));
        pushToast(`theme → ${match}`, 'ok');
        return null;
      }
      case 'cols': {
        const n = parseInt(arg, 10);
        if (![3, 4, 5].includes(n)) { pushToast(`cols must be 3, 4, or 5`, 'warn'); return null; }
        setSettingsState(s => ({ ...s, gridCols: n }));
        pushToast(`grid → ${n} columns`, 'ok');
        return null;
      }
      // Slot jump for caps > 10 — `:goto 12` focuses slot 12. Hotkeys
      // 1-9/0 still cover slots 1-10; this is the escape hatch for
      // higher cap values where there's no single-digit hotkey.
      case 'goto':
      case 'jump': {
        const n = parseInt(arg, 10);
        if (!Number.isFinite(n) || n < 1 || n > (snapshot.slots || 10)) {
          pushToast(`slot out of range — fleet has ${snapshot.slots || 10} slots`, 'warn');
          return null;
        }
        setFocusedSlot(n);
        return null;
      }
      case 'model': {
        // :model <id>            — switch focused session's model (live)
        // :model default <id>    — change fleet default for new launches
        // :model refresh         — programmatically probe live models (billed)
        // :model                 — toast the focused session's resolved + requested model
        const [maybeDefault, ...modelRest] = rest;

        // :model refresh — the programmatic "pull available models" path.
        // Each alias probe is a real billed turn (~$0.10–0.15), so this is
        // manual-only; the result is cached and overlaid on boot offline.
        if (maybeDefault === 'refresh') {
          pushToast('probing models (opus · sonnet · haiku) — ~$0.10/ea, ~5s…', 'info');
          (async () => {
            const results = await probeAll();
            const cache = saveModelCache(results);
            const { updated, added } = applyCacheToCatalog(MODELS, cache);
            const failed = results.filter(r => r.error);
            const bits = [];
            if (updated.length) bits.push(`updated ${updated.join(', ')}`);
            if (added.length)   bits.push(`discovered ${added.join(', ')}`);
            if (failed.length)  bits.push(`${failed.length} failed (${failed.map(f => f.alias).join(', ')})`);
            pushToast(
              `model refresh: ${results.length - failed.length}/${results.length} probed${bits.length ? ' · ' + bits.join(' · ') : ''}`,
              failed.length ? 'warn' : 'ok',
            );
          })();
          return null;
        }

        // Live id list (Object.keys, not the import-time snapshot) so models
        // discovered by `:model refresh` are immediately selectable.
        const modelIds = Object.keys(MODELS);
        if (!maybeDefault) {
          if (!focusedAgent || focusedAgent.status === 'empty') {
            pushToast(`available · ${modelIds.join(' · ')}  ·  :model refresh to re-probe`, 'info');
            return null;
          }
          const reqId = focusedAgent.model;
          const reqCli = MODELS[reqId]?.cliModel || reqId;
          const resolved = focusedAgent.resolvedModel || '(pending init)';
          const mismatch = focusedAgent.resolvedModel && focusedAgent.resolvedModel !== reqCli;
          pushToast(
            `slot ${focusedAgent.slot} · requested ${reqId} (${reqCli}) · resolved ${resolved}${mismatch ? ' ⚠ MISMATCH' : ''}`,
            mismatch ? 'warn' : 'info',
          );
          return null;
        }
        const isDefault = maybeDefault === 'default';
        const newId = isDefault ? modelRest[0] : maybeDefault;
        if (!modelIds.includes(newId)) {
          pushToast(`unknown model · use one of: ${modelIds.join(' · ')}`, 'warn');
          return null;
        }
        if (isDefault) {
          setSettingsState(s => ({ ...s, defaultModel: newId }));
          pushToast(`default model → ${newId}`, 'ok');
          return null;
        }
        if (!focusedAgent || focusedAgent.status === 'empty') {
          pushToast(`no live session focused — use :model default <id> for new launches`, 'warn');
          return null;
        }
        const a = fleet.agentById(focusedAgent.id);
        if (!a) { pushToast(`session not found`, 'warn'); return null; }
        const changed = a.changeModel(newId);
        if (!changed) pushToast(`slot ${focusedAgent.slot} already on ${newId}`, 'info');
        else pushToast(`model: ${newId} (restarting session)`, 'ok');
        return null;
      }
      case 'perm':
      case 'permission': {
        // Two forms:
        //   :perm <mode>            — change the focused live session
        //   :perm default <mode>    — change the fleet default for new launches
        const [maybeDefault, ...modeRest] = rest;
        const isDefault = maybeDefault === 'default';
        const mode = isDefault ? modeRest[0] : maybeDefault;
        if (!PERMISSION_MODES.includes(mode)) {
          pushToast(`usage: :perm <mode>  or  :perm default <mode>  ·  modes: ${PERMISSION_MODES.join(', ')}`, 'warn');
          return null;
        }
        if (isDefault) {
          setSettingsState(s => ({ ...s, defaultPermission: mode }));
          pushToast(`default permission → ${mode}`, mode === 'bypassPermissions' ? 'warn' : 'ok');
          return null;
        }
        // Per-session change — target the focused live session.
        if (!focusedAgent || focusedAgent.status === 'empty') {
          pushToast(`no live session focused — use :perm default <mode> for new launches`, 'warn');
          return null;
        }
        const a = fleet.agentById(focusedAgent.id);
        if (!a) { pushToast(`session not found`, 'warn'); return null; }
        const changed = a.changePermissionMode(mode);
        if (!changed) pushToast(`slot ${focusedAgent.slot} already in ${mode}`, 'info');
        else pushToast(`permission: ${mode}`, mode === 'bypassPermissions' ? 'warn' : 'ok');
        return null;
      }
      // /clear — kill the focused session and immediately relaunch a
      // fresh one in the same slot with the same cwd/model/permission.
      // New sessionId; the prior transcript is preserved on disk.
      // Closest in-mc equivalent of `/clear` in the Claude Code REPL.
      case 'clear':
      case 'restart': {
        const target = focusedAgent;
        if (!target || target.status === 'empty') {
          pushToast(`no live session focused`, 'warn');
          return null;
        }
        const cfg = {
          slot: target.slot,
          cwd: target.cwd,
          branch: target.branch,
          model: target.model,
          name: target.name,
          permissionMode: target.permissionMode,
        };
        try { fleet.kill(target.id); } catch {}
        // Defer the relaunch one tick so the kill's snapshot emit lands
        // first; otherwise the launch races with the empty-slot update.
        setTimeout(() => {
          try { fleet.launch(cfg); pushToast(`slot ${cfg.slot} cleared — fresh session`, 'ok'); }
          catch (e) { pushToast(`relaunch failed: ${e.message}`, 'error'); }
        }, 50);
        return null;
      }
      // /compact — ask claude for a concise summary of the conversation
      // so far. Does NOT auto-restart (the user reviews the summary,
      // then can /clear if they want a fresh slate with that context in
      // mind). Future enhancement TODO(compact-restart): one-shot
      // summarize-then-restart-with-summary.
      case 'compact': {
        const target = focusedAgent;
        if (!target || target.status === 'empty') {
          pushToast(`no live session focused`, 'warn');
          return null;
        }
        const a = fleet.agentById(target.id);
        if (!a) { pushToast(`session not found`, 'warn'); return null; }
        const prompt = arg && arg.trim()
          ? `Please summarize our conversation so far, focusing on: ${arg.trim()}. Be concise — 3-5 paragraphs covering decisions made, code state, and next steps.`
          : `Please provide a concise summary of our conversation so far in 3-5 paragraphs. Include key decisions, current code state, and next steps. After you reply, I'll consider running /clear to start fresh with this summary as my reference.`;
        a.send(prompt);
        pushToast(`compact: asked slot ${target.slot} for a summary — review then optionally /clear`, 'info');
        return null;
      }
      // /compact-restart — one-shot version of /compact + /clear. Asks
      // the session for a summary, watches the tail for the first
      // assistant reply that lands AFTER our prompt, then kills + relaunches
      // in the same slot with the summary as the new first user message.
      // Gated by plugin_compactRestart (Layer 1).
      case 'compact-restart':
      case 'compactrestart':
      case 'cr': {
        if (!isPluginEnabled(settings, 'plugin_compactRestart')) {
          pushToast(`/compact-restart is disabled — enable in settings (PLUGINS · L1)`, 'warn');
          return null;
        }
        const target = focusedAgent;
        if (!target || target.status === 'empty') {
          pushToast(`no live session focused`, 'warn');
          return null;
        }
        const a = fleet.agentById(target.id);
        if (!a) { pushToast(`session not found`, 'warn'); return null; }
        const cfg = {
          slot: target.slot,
          cwd: target.cwd,
          branch: target.branch,
          model: target.model,
          name: target.name,
          permissionMode: target.permissionMode,
        };
        const summaryPrompt = arg && arg.trim()
          ? `Please summarize our conversation so far, focusing on: ${arg.trim()}. 3-5 paragraphs covering decisions, code state, next steps. After your reply mc will auto-restart this session with your summary as the new first message.`
          : `Please provide a concise summary of our conversation so far in 3-5 paragraphs covering key decisions, current code state, and next steps. After your reply mc will auto-restart this session with your summary as the new first message.`;
        const tailLenAtSend = a.tail.length;
        a.send(summaryPrompt);
        pushToast(`compact-restart: waiting for summary on slot ${cfg.slot}…`, 'info');
        // Poll the tail for a NEW assistant message after our prompt.
        // Cap at 2 min to avoid leaking the timer when claude hangs.
        const start = Date.now();
        const poll = setInterval(() => {
          if (Date.now() - start > 120000) {
            clearInterval(poll);
            pushToast(`compact-restart: timed out waiting for slot ${cfg.slot}`, 'warn');
            return;
          }
          const live = fleet.agentById(target.id);
          if (!live) { clearInterval(poll); return; }
          const newEntries = live.tail.slice(tailLenAtSend);
          const reply = newEntries.find(e => e.kind === 'asst' && e.text && e.text.length > 50);
          if (!reply) return;
          clearInterval(poll);
          const summary = reply.text;
          try { fleet.kill(target.id); } catch {}
          setTimeout(() => {
            try {
              const agent = fleet.launch(cfg);
              setTimeout(() => {
                try {
                  agent.send(`── prior session summary ──\n${summary}\n── prior session summary ──\n\nContinue from where we left off.`);
                  pushToast(`compact-restart: slot ${cfg.slot} relaunched with summary`, 'ok');
                } catch (e) { pushToast(`compact-restart inject failed: ${e.message}`, 'error'); }
              }, 400);
            } catch (e) { pushToast(`compact-restart relaunch failed: ${e.message}`, 'error'); }
          }, 80);
        }, 600);
        return null;
      }
      // :remember "X" — append a dated note to <focused-cwd>/.mc/MEMORY.md.
      // The note is also visible in the session tail as a sys event so
      // the user gets immediate feedback. Layer 2.
      case 'remember':
      case 'rem': {
        if (!isPluginEnabled(settings, 'plugin_projectMemory')) {
          pushToast(`:remember is disabled — enable plugin_projectMemory in settings`, 'warn');
          return null;
        }
        const target = focusedAgent;
        if (!target || target.status === 'empty' || !target.cwd) {
          pushToast(`no live session focused (or no cwd) — :remember needs a target repo`, 'warn');
          return null;
        }
        if (!arg || !arg.trim()) {
          pushToast(`usage: :remember "<short note about the project>"`, 'warn');
          return null;
        }
        // Strip surrounding quotes the user may type.
        const clean = arg.trim().replace(/^["'`]|["'`]$/g, '');
        const r = appendMemoryNote(target.cwd, clean);
        if (!r.ok) {
          pushToast(`remember failed: ${r.error}`, 'error');
          return null;
        }
        const a = fleet.agentById(target.id);
        if (a) a.appendTail({ kind: 'sys', text: `remembered → ${memoryPathFor(target.cwd)}` });
        pushToast(`remembered (${r.bytes}b) · ${r.path}`, 'ok');
        return null;
      }
      // :memory — show the focused repo's project memory inline. No
      // arg → reads <cwd>/.mc/MEMORY.md.
      case 'memory':
      case 'mem': {
        const target = focusedAgent;
        if (!target || target.status === 'empty' || !target.cwd) {
          pushToast(`no live session focused — :memory reads <cwd>/.mc/MEMORY.md`, 'warn');
          return null;
        }
        const body = readProjectMemory(target.cwd);
        if (!body) {
          pushToast(`no project memory at ${memoryPathFor(target.cwd)} (use :remember "X" to seed)`, 'info');
          return null;
        }
        const a = fleet.agentById(target.id);
        if (a) a.appendTail({ kind: 'sys', text: `── project memory (${body.length}b) ──\n${body}` });
        pushToast(`project memory injected into slot ${target.slot} tail`, 'ok');
        return null;
      }
      // :mcp — list MCP servers attached to the focused session by
      // reading ~/.claude/.mcp.json + <cwd>/.mcp.json. Layer 3.
      case 'mcp': {
        if (!isPluginEnabled(settings, 'plugin_mcpAware')) {
          pushToast(`:mcp is disabled — enable plugin_mcpAware in settings`, 'warn');
          return null;
        }
        const target = focusedAgent;
        if (!target || target.status === 'empty') {
          pushToast(`no live session focused — :mcp reads MCP config for the focused cwd`, 'warn');
          return null;
        }
        try {
          const candidates = [
            join(homedir(), '.claude', '.mcp.json'),
            target.cwd ? join(target.cwd, '.mcp.json') : null,
          ].filter(Boolean);
          const servers = new Set();
          for (const p of candidates) {
            if (!existsSync(p)) continue;
            try {
              const raw = JSON.parse(readFileSync(p, 'utf8'));
              const block = raw.mcpServers || raw.servers || raw;
              for (const name of Object.keys(block || {})) servers.add(name);
            } catch {}
          }
          if (servers.size === 0) {
            pushToast(`no MCP servers in ~/.claude/.mcp.json or ${target.cwd}/.mcp.json`, 'info');
            return null;
          }
          pushToast(`MCP servers (${servers.size}): ${[...servers].join(', ')}`, 'ok');
          return null;
        } catch (e) {
          pushToast(`mcp probe failed: ${e.message}`, 'warn');
          return null;
        }
      }
      case 'kill': {
        // `:kill!` (bang form) skips the confirm prompt — typing 6 chars
        // is already an explicit-enough signal. `:kill` arms like K.
        const force = cmd === 'kill' && arg.startsWith('!');
        const argClean = force ? arg.slice(1).trim() : arg;
        const n = parseInt(argClean, 10);
        const target = (n >= 1 && n <= 10) ? agents.find(a => a.slot === n) : focusedAgent;
        if (!target || target.status === 'empty') { pushToast(`no live session in slot ${n || focusedSlot}`, 'warn'); return null; }
        const pending = pendingKillRef.current;
        if (force || (pending && pending.id === target.id)) {
          if (pending) { clearTimeout(pending.timer); pendingKillRef.current = null; }
          fleet.kill(target.id);
          pushToast(`killed slot ${target.slot}`, 'ok');
          return null;
        }
        if (pending) clearTimeout(pending.timer);
        const armId = target.id;
        const armSlot = target.slot;
        const timer = setTimeout(() => {
          if (pendingKillRef.current && pendingKillRef.current.timer === timer) {
            pendingKillRef.current = null;
          }
        }, KILL_ARM_MS);
        pendingKillRef.current = { id: armId, slot: armSlot, timer };
        pushToast(`press K (or :kill ${armSlot}) again to confirm · or :kill! ${armSlot}`, 'warn');
        return null;
      }
      case 'pause':
      case 'resume': {
        const target = focusedAgent;
        if (!target || target.status === 'empty') { pushToast(`no live session focused`, 'warn'); return null; }
        const a = fleet.agentById(target.id);
        if (cmd === 'pause') a?.pause();
        else a?.resume();
        pushToast(`${cmd} slot ${target.slot}`, 'ok');
        return null;
      }
      case 'note':
      case 'n': {
        if (!arg.trim()) { pushToast(`usage: :note <text>  — drops a local annotation in the focused session's chat log`, 'warn'); return null; }
        if (!focusedAgent || focusedAgent.status === 'empty') { pushToast(`no live session focused`, 'warn'); return null; }
        const a = fleet.agentById(focusedAgent.id);
        if (!a) { pushToast(`session not found`, 'warn'); return null; }
        a.addNote(arg);
        pushToast(`note added to slot ${focusedAgent.slot}`, 'ok');
        return null;
      }
      case 'approve':
      case 'a': {
        const target = focusedAgent;
        if (!target || target.status === 'empty') { pushToast(`no live session focused`, 'warn'); return null; }
        const a = fleet.agentById(target.id);
        if (!a) { pushToast(`session not found`, 'warn'); return null; }
        a.approve();
        pushToast(`approve → slot ${target.slot}`, 'ok');
        return null;
      }
      case 'resume': {
        // Selective restore — supports 0 args (use focused slot),
        // 1 arg (single slot), or 2+ args / comma-separated list
        // (multi-restore). Distinct from `:resume-all` (whole bySlot
        // map) and `:history` (view-only reference list).
        const tokens = (arg || '')
          .split(/[\s,]+/)
          .map(s => parseInt(s, 10))
          .filter(n => n >= 1 && n <= 10);
        if (tokens.length === 0) {
          // No args / unparseable — fall back to single-restore on focused slot.
          const slot = focusedSlot;
          const rec = getResumeRecord(slot);
          if (!rec) { pushToast(`no saved session for slot ${slot}`, 'warn'); return null; }
          if (agents.find(a => a.slot === slot && a.status !== 'empty')) {
            pushToast(`slot ${slot} is in use — kill first`, 'warn');
            return null;
          }
          resumeSession(slot, rec);
          return null;
        }
        if (tokens.length === 1) {
          const slot = tokens[0];
          const rec = getResumeRecord(slot);
          if (!rec) { pushToast(`no saved session for slot ${slot}`, 'warn'); return null; }
          if (agents.find(a => a.slot === slot && a.status !== 'empty')) {
            pushToast(`slot ${slot} is in use — kill first`, 'warn');
            return null;
          }
          resumeSession(slot, rec);
          return null;
        }
        // Multi-restore: iterate, skip slots in use or without records.
        let resumed = 0, fresh = 0, skipped = 0, missing = 0;
        for (const slot of tokens) {
          const rec = getResumeRecord(slot);
          if (!rec) { missing++; continue; }
          if (agents.find(a => a.slot === slot && a.status !== 'empty')) { skipped++; continue; }
          try {
            if (launchFromRecord(slot, rec) === 'fresh') fresh++; else resumed++;
          } catch (e) {
            pushToast(`slot ${slot} failed: ${e?.message || String(e)}`, 'warn');
          }
        }
        const parts = [`resumed ${resumed + fresh}/${tokens.length}`];
        if (fresh) parts.push(`${fresh} fresh`);
        if (skipped) parts.push(`${skipped} skipped (in use)`);
        if (missing) parts.push(`${missing} unknown`);
        pushToast(parts.join(' · '), (resumed + fresh) ? 'ok' : 'warn');
        return null;
      }
      case 'resume-all': {
        // Restart the sessions open at last close (the open-set in bySlot).
        // Cold starts are staggered (broadcastStaggerMs) to avoid opening every
        // streaming connection at once.
        const { scheduled, skipped, total, counts } = resumeAllSessions(agents);
        if (total === 0) { pushToast(`no saved sessions to resume`, 'info'); return null; }
        const parts = [`resuming ${scheduled}/${total}`];
        if (counts?.fresh) parts.push(`${counts.fresh} fresh`);
        if (skipped) parts.push(`${skipped} skipped (slot in use)`);
        pushToast(parts.join(' · '), scheduled ? 'ok' : 'warn');
        return null;
      }
      case 'history':
      case 'hist': {
        // VIEW-ONLY rolling log of the last N sessions. Reference for
        // "what was that branch I was on last week?" — NOT a bulk
        // restore path. To revive an old one, copy the cwd into a new
        // NewSession or `:resume <slot>` after `:forget`ing.
        const recs = listHistory(settings.sessionHistoryLimit ?? 20);
        if (recs.length === 0) { pushToast(`no session history yet`, 'info'); return null; }
        const want = Math.min(recs.length, parseInt(arg, 10) || 6);
        pushToast(`history · ${recs.length} session${recs.length === 1 ? '' : 's'} (showing ${want})`, 'info');
        for (const r of recs.slice(0, want)) {
          const ago = Math.max(1, Math.round((Date.now() - (r.lastSeen || 0)) / 60000));
          pushToast(`${r.name || '—'} · ${r.branch || '?'} · ${r.model || '?'} · ${ago}m ago`, 'info');
        }
        return null;
      }
      case 'forget': {
        const n = parseInt(arg, 10);
        if (!(n >= 1 && n <= 10)) { pushToast(`forget <slot 1-10>`, 'warn'); return null; }
        clearResumeRecord(n);
        pushToast(`forgot saved session for slot ${n}`, 'ok');
        return null;
      }
      case 'sessions':
      case 'ls': {
        const recs = listResumeRecords();
        if (recs.length === 0) { pushToast(`no saved sessions`, 'info'); return null; }
        for (const r of recs.slice(0, 4)) {
          pushToast(`[${r.slot}] ${r.name} · ${r.branch} · ${r.model}`, 'info');
        }
        return null;
      }
      case 'help':
      case '?':
        setModal('help');
        return null;
      case 'version':
      case 'ver': {
        pushToast(`mc ${versionLine()}`, 'info');
        return null;
      }
      // Where state lives — surface the on-disk paths for the focused
      // session's transcript and mc's config dir. Addresses the recurring
      // "does mc have a persistent conversation record?" question — yes,
      // it does, and this verb tells you exactly where.
      case 'transcript':
      case 'tx':
      case 'log': {
        const focused = focusedAgent;
        if (!focused || focused.status === 'empty') {
          pushToast(`transcripts dir · ${TRANSCRIPT_BASE_DIR}`, 'info');
          return null;
        }
        const p = transcriptPathFor(focused.sessionId);
        pushToast(`transcript · ${p}`, 'info');
        return null;
      }
      // GitHub Issues for the focused session's repo. First step toward
      // the right-side task panel — for now we toast the top N open
      // issues so users have task visibility without leaving mc.
      case 'tasks':
      case 'todo':
      case 't': {
        const focused = focusedAgent;
        if (!focused || focused.status === 'empty') {
          pushToast('focus a live session first to see its tasks', 'warn');
          return null;
        }
        const cwd = focused.cwd;
        pushToast(`fetching tasks for ${focused.name}…`, 'info');
        listIssuesForCwd(cwd, { limit: 10 }).then(result => {
          if (!result.ok) {
            pushToast(`tasks · ${result.message}`, 'warn');
            return;
          }
          if (result.issues.length === 0) {
            pushToast(`tasks · no open issues for ${focused.name}`, 'info');
            return;
          }
          pushToast(`tasks · ${result.issues.length} open · top ${Math.min(4, result.issues.length)}:`, 'ok');
          for (const it of result.issues.slice(0, 4)) {
            pushToast(`  #${it.number} · ${it.title.slice(0, 70)}`, 'info');
          }
        });
        return null;
      }
      // Runtime key-event recorder. Useful when the user reports a
      // terminal-specific binding issue — flip on, repro, flip off,
      // hand over the log file. Forms:
      //   :debug-keys              → toast current state + path
      //   :debug-keys on  / start  → enable recording
      //   :debug-keys off / stop   → disable recording
      //   :debug-keys clear        → truncate the log
      //   :debug-keys path         → toast the log file path
      case 'debug-keys':
      case 'debugkeys':
      case 'dk': {
        const sub = (rest[0] || '').toLowerCase();
        if (!sub || sub === 'status') {
          const on = isDebugKeysActive();
          pushToast(`debug-keys · ${on ? 'ON' : 'off'} · log ${DEBUG_KEYS_PATH}`, on ? 'warn' : 'info');
          return null;
        }
        if (sub === 'on' || sub === 'start' || sub === 'enable') {
          setDebugKeysActive(true);
          pushToast(`debug-keys ON · logging to ${DEBUG_KEYS_PATH}`, 'warn');
          return null;
        }
        if (sub === 'off' || sub === 'stop' || sub === 'disable') {
          setDebugKeysActive(false);
          pushToast(`debug-keys OFF`, 'info');
          return null;
        }
        if (sub === 'clear' || sub === 'reset') {
          const ok = clearDebugKeysLog();
          pushToast(ok ? `debug-keys log cleared` : `couldn't clear debug-keys log`, ok ? 'ok' : 'warn');
          return null;
        }
        if (sub === 'path' || sub === 'where') {
          pushToast(`debug-keys log · ${DEBUG_KEYS_PATH}`, 'info');
          return null;
        }
        pushToast(`usage: :debug-keys [on|off|status|clear|path]`, 'warn');
        return null;
      }
      case 'where': {
        // One-stop "where does mc keep things?" report.
        const focused = focusedAgent;
        pushToast(`config · ${getConfigDir()}`, 'info');
        if (focused && focused.status !== 'empty') {
          pushToast(`transcript · ${transcriptPathFor(focused.sessionId)}`, 'info');
        } else {
          pushToast(`transcripts · ${TRANSCRIPT_BASE_DIR}`, 'info');
        }
        return null;
      }
      case 'whoami':
      case 'auth': {
        const probe = probeAuth();
        setAuth(probe);
        pushToast(authSummary(probe), probe.ok ? 'ok' : 'error');
        if (probe.ok && probe.orgName) pushToast(`org · ${probe.orgName}`, 'info');
        return null;
      }
      case 'dash':
      case 'dashboard': {
        setModal('dash');
        return null;
      }
      case 'template':
      case 'tpl': {
        // :template                  — list available templates
        // :template <name>           — launch into next N empty slots,
        //                              using the focused agent's cwd (or
        //                              process.cwd) as the working dir
        // :template <name> <cwd>     — explicit cwd override
        if (!arg) {
          const list = listTemplates();
          if (list.length === 0) { pushToast(`no templates configured · see ~/.config/claude-mc/templates.json`, 'info'); return null; }
          pushToast(`templates: ${list.map(t => `${t.name}(${t.count})`).join(', ')}`, 'info');
          return null;
        }
        const [tplName, ...cwdParts] = rest;
        const t = getTemplate(tplName);
        if (!t) {
          pushToast(`no template "${tplName}" · :template lists available`, 'warn');
          return null;
        }
        const sessions = Array.isArray(t.sessions) ? t.sessions : [];
        const empties = agents.filter(a => a.status === 'empty').map(a => a.slot);
        if (empties.length < sessions.length) {
          pushToast(`template "${t.name}" needs ${sessions.length} empty slots, ${empties.length} free`, 'warn');
          return null;
        }
        const cwdRaw = cwdParts.join(' ').trim();
        const cwd = cwdRaw
          ? cwdRaw
          : (focusedAgent && focusedAgent.status !== 'empty' && focusedAgent.cwd) || process.cwd();
        sessions.forEach((s, i) => {
          launchSession({
            slot: empties[i],
            repoPath: cwd,
            branch: 'main',
            model: s.model || settings.defaultModel || 'sonnet-4.6',
            permissionMode: s.permissionMode || settings.defaultPermission || 'acceptEdits',
            prompt: s.prompt || null,
          });
        });
        pushToast(`launched template "${t.name}" · ${sessions.length} slots`, 'ok');
        return null;
      }
      case 'cap': {
        // :cap <slot> <usd>      — per-slot override
        // :cap default <usd>     — fleet-wide default (persisted)
        // :cap                   — show current state
        if (!arg) {
          pushToast(`cap default: $${(settings.costCapUSD || 0).toFixed(2)} · use :cap <slot> <usd> or :cap default <usd>`, 'info');
          return null;
        }
        const [first, ...restArgs] = rest;
        if (first === 'default') {
          const usd = parseFloat(restArgs[0]);
          if (isNaN(usd) || usd < 0) { pushToast(`usage: :cap default <usd>`, 'warn'); return null; }
          setSettingsState(s => ({ ...s, costCapUSD: usd }));
          pushToast(`default cost cap → ${usd === 0 ? 'disabled' : '$' + usd.toFixed(2)}`, 'ok');
          return null;
        }
        const n = parseInt(first, 10);
        const usd = parseFloat(restArgs[0]);
        if (!(n >= 1 && n <= 10) || isNaN(usd) || usd < 0) {
          pushToast(`usage: :cap <slot 1-10> <usd>  or  :cap default <usd>`, 'warn');
          return null;
        }
        const ok = fleet.setSlotCostCap(n, usd);
        if (!ok) pushToast(`slot ${n} is empty`, 'warn');
        else pushToast(`slot ${n} cap → ${usd === 0 ? 'disabled' : '$' + usd.toFixed(2)}`, 'ok');
        return null;
      }
      case 'budget': {
        // :budget <usd>  — set daily budget. :budget 0 disables. :budget alone shows status.
        if (!arg) {
          const b = settings.dailyBudgetUSD || 0;
          const sp = costStoreRef.current.dayCost();
          pushToast(`today: $${sp.toFixed(2)}${b > 0 ? ` / $${b.toFixed(2)}` : ' · no budget set'}`, 'info');
          return null;
        }
        const usd = parseFloat(arg);
        if (isNaN(usd) || usd < 0) { pushToast(`usage: :budget <usd>  (0 disables)`, 'warn'); return null; }
        setSettingsState(s => ({ ...s, dailyBudgetUSD: usd }));
        pushToast(`daily budget → ${usd === 0 ? 'disabled' : '$' + usd.toFixed(2)}`, 'ok');
        return null;
      }
      case 'cost': {
        // Slash `/cost` (and bar `:cost`) — toast the focused session's
        // running cost so the user doesn't have to expand the stats panel
        // just to peek.
        const a = focusedAgent;
        if (!a || a.status === 'empty') {
          pushToast(`no live session focused`, 'warn');
          return null;
        }
        pushToast(`cost · session ${fmtMoney(a.costSession || 0)}  ·  week ${fmtMoney(a.costWeek || 0)}`, 'info');
        return null;
      }
      case 'usage': {
        const u = readUsage();
        setUsage(u);
        if (!u) {
          pushToast(`no usage data — claude hasn't written ~/.claude/abtop-rate-limits.json yet`, 'warn');
          return null;
        }
        pushToast(`5h: ${u.fiveHour.usedPct.toFixed(0)}%  (resets in ${fmtReset(u.fiveHour.resetsAt) || '?'})`, u.fiveHour.usedPct >= 85 ? 'warn' : 'ok');
        pushToast(`7d: ${u.sevenDay.usedPct.toFixed(0)}%  (resets in ${fmtReset(u.sevenDay.resetsAt) || '?'})`, u.sevenDay.usedPct >= 85 ? 'warn' : 'ok');
        return null;
      }
      case 'repos': {
        // `:repos` — open the folder picker. `:repos clear` — reset to the
        // built-in scan locations.
        if (arg === 'clear' || arg === 'reset' || arg === 'off') {
          setSettingsState(s => ({ ...s, repoParents: [] }));
          pushToast(`repo locations reset to defaults`, 'ok');
          return null;
        }
        setModal('repoPicker');
        return null;
      }
      case 'slack': {
        // `:slack <url>` — set the webhook. `:slack clear` — remove it.
        if (!arg) {
          pushToast(settings.slackWebhook ? `slack webhook configured (use :slack clear to remove)` : `no slack webhook — usage: :slack <https://hooks.slack.com/...>`, 'info');
          return null;
        }
        if (arg === 'clear' || arg === 'off') {
          setSettingsState(s => ({ ...s, slackWebhook: '' }));
          pushToast(`slack webhook cleared`, 'ok');
          return null;
        }
        if (!arg.startsWith('https://hooks.slack.com/')) {
          pushToast(`webhook url must start with https://hooks.slack.com/`, 'warn');
          return null;
        }
        setSettingsState(s => ({ ...s, slackWebhook: arg }));
        pushToast(`slack webhook configured — try :feedback <message>`, 'ok');
        return null;
      }
      case 'feedback':
      case 'request': {
        if (!arg.trim()) {
          pushToast(`usage: :${cmd} <message>`, 'warn');
          return null;
        }
        if (!settings.slackWebhook) {
          pushToast(`no slack webhook — configure with :slack <url>`, 'warn');
          return null;
        }
        const ctx = { auth, agents, usage };
        pushToast(`sending ${cmd}…`, 'info');
        postSlack({ webhook: settings.slackWebhook, kind: cmd, text: arg, context: ctx })
          .then(r => {
            if (r.ok) pushToast(`${cmd} sent to Slack`, 'ok');
            else pushToast(`slack post failed · ${r.error}`, 'error');
          });
        return null;
      }
      default:
        pushToast(`unknown command: ${cmd}`, 'warn');
        return null;
    }
  };

  // ── Hotkeys ─────────────────────────────────────────────
  useInput((input, key) => {
    // Command-bar input mode takes priority over everything else, including
    // modal hotkeys, because the user is actively typing.
    if (cmdMode !== 'normal') {
      if (key.escape) {
        setCmdMode('normal'); setCmdBuffer('');
        return;
      }
      if (key.return) {
        const text = cmdBuffer;
        if (cmdMode === 'filter') {
          setFilterActive(text.trim());
          if (text.trim()) pushToast(`filter: ${text.trim()}  (/ to clear)`, 'info');
        } else if (cmdMode === 'command') {
          runCommand(text);
        }
        setCmdMode('normal'); setCmdBuffer('');
        return;
      }
      if (key.backspace || key.delete) {
        setCmdBuffer(b => b.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && input.length === 1) {
        setCmdBuffer(b => b + input);
      }
      return;
    }

    if (modal) return;  // modal owns its own keys

    // Shift+Tab — cycle the focused session through the three core dev
    // modes (plan → auto → acceptEdits → plan). Mirrors Claude Code's
    // own keymap so users have one fewer thing to remember. Per-session
    // change; transcript is preserved via the kill+resume respawn.
    if (key.shift && key.tab) {
      cyclePerm(focusedAgent);
      return;
    }

    if (key.escape) { setModal('settings'); return; }
    if (input === ',') { setModal('settings'); return; }
    if (input === '?') { setModal('help'); return; }
    if (input === 'b' || input === 'B') { setModal('bcast'); return; }
    if (input === 'd' || input === 'D') { setModal('dash'); return; }
    // Shift+L cycles fleet-log content: all → narrative → all. Only uppercase
    // (lowercase 'l' is taken by vim-right). Persisted to settings.json.
    if (input === 'L') {
      const next = settings.fleetLogMode === 'narrative' ? 'all' : 'narrative';
      setSettingsState(s => ({ ...s, fleetLogMode: next }));
      pushToast(`fleet log → ${next}`, 'ok');
      return;
    }
    // q opens the QuitConfirm modal. The modal owns y/n; the parent
    // hotkey layer never sees q-as-quit, so there's no self-conflicting
    // "press q to arm, but q already quits" ambiguity. Ctrl+C bypasses
    // (Ink's exitOnCtrlC).
    if (input === 'q' || input === 'Q') { setModal('quit'); return; }

    // Command bar entry
    if (input === '/') {
      if (filterActive) { setFilterActive(''); pushToast('filter cleared', 'info'); return; }
      setCmdMode('filter'); setCmdBuffer('');
      return;
    }
    if (input === ':') {
      setCmdMode('command'); setCmdBuffer('');
      return;
    }

    // Slot jumps 1..9, 0=10
    if (/^[0-9]$/.test(input)) {
      const slot = input === '0' ? 10 : parseInt(input, 10);
      setFocusedSlot(slot);
      return;
    }

    // 2D arrow nav across the VISIBLE cards. Empty slots are hidden from
    // the grid now, so navigation operates on `visibleAgents` and the
    // focused index walks that list — not the underlying 1..10 slot
    // space. focusedSlot still stores the real slot id of the highlighted
    // agent for hotkey paths that key off it (:resume <slot> etc.).
    //
    // We only `return` if the index ACTUALLY changes — otherwise a key
    // like vim `k` (up) on a single-card grid would silently swallow the
    // press and shadow the uppercase-K kill key. Falling through when the
    // nav is a no-op lets the same keystroke reach the kill / pause /
    // resume handlers below.
    const visList = agents.filter(a => a.status !== 'empty');
    if (visList.length > 0) {
      const cols = Math.max(1, Math.min(settings.gridCols, visList.length));
      const curIdx = Math.max(0, visList.findIndex(a => a.slot === focusedSlot));
      let nextIdx = curIdx;
      if (key.leftArrow  || (settings.vimKeys && input === 'h')) nextIdx = (curIdx - 1 + visList.length) % visList.length;
      if (key.rightArrow || (settings.vimKeys && input === 'l')) nextIdx = (curIdx + 1) % visList.length;
      if (key.upArrow    || (settings.vimKeys && input === 'k')) nextIdx = Math.max(0, curIdx - cols);
      if (key.downArrow  || (settings.vimKeys && input === 'j')) nextIdx = Math.min(visList.length - 1, curIdx + cols);
      if (nextIdx !== curIdx) {
        setFocusedSlot(visList[nextIdx].slot);
        return;
      }
    }

    // Pane switch — `[` / `]` jump focus to the first card of the adjacent
    // pane. The active pane follows focus (single source of truth, no
    // separate page state to drift), so moving focus IS the page change.
    if (input === '[' || input === ']') {
      if (visList.length > 0) {
        const curIdx = Math.max(0, visList.findIndex(a => a.slot === focusedSlot));
        const pl = computeGridLayout({
          termCols: termSize.cols,
          termRows: termSize.rows,
          gridCols: settings.gridCols,
          count: visList.length,
          fleetLogLines: settings.fleetLogLines,
          windowsPerPane: settings.windowsPerPane,
          focusedIndex: curIdx,
        });
        if (pl.pageCount > 1) {
          const targetPage = Math.max(0, Math.min(pl.pageCount - 1, pl.pageIndex + (input === ']' ? 1 : -1)));
          if (targetPage !== pl.pageIndex) {
            const targetIdx = Math.min(targetPage * pl.perPage, visList.length - 1);
            setFocusedSlot(visList[targetIdx].slot);
          }
          return;
        }
      }
    }

    if (key.return) {
      const cur = focusedAgent;
      if (cur && cur.status !== 'empty') {
        setZoomedId(cur.id);
        setModal('zoom');
      } else {
        // No live focus → fall through to "new session," same as `n`.
        const slot = nextLaunchSlot(agents);
        if (slot) { setNewSlot(slot); setModal('new'); }
        else pushToast(`all ${snapshot.slots ?? 10} slots occupied — kill one first`, 'warn');
      }
      return;
    }

    // New-session hotkeys: `n` from anywhere, plus `Ctrl+N` for users
    // who prefer a modifier-based shortcut (Cmd doesn't reach Ink
    // reliably on macOS — Ctrl is the portable choice). Shift+N is
    // intentionally NOT bound so it's free for a future overload.
    if (input === 'n' || (key.ctrl && (input === 'n' || input === 'N'))) {
      // Explicit focus on an empty slot is a deliberate placement choice —
      // honor it. Otherwise append below the last active card.
      const slot = focusedAgent?.status === 'empty'
        ? focusedAgent.slot
        : nextLaunchSlot(agents);
      if (slot) {
        setNewSlot(slot);
        setModal('new');
      } else {
        pushToast(`all ${snapshot.slots ?? 10} slots occupied — kill one first`, 'warn');
      }
      return;
    }

    if (input === 'p' || input === 'P') {
      if (focusedAgent && focusedAgent.status !== 'empty') {
        const a = fleet.agentById(focusedAgent.id);
        a && a.pause();
      }
      return;
    }
    if (input === 'r' || input === 'R') {
      if (focusedAgent && focusedAgent.status !== 'empty') {
        const a = fleet.agentById(focusedAgent.id);
        a && a.resume();
      }
      return;
    }
    if (input === 'k' || input === 'K') {
      if (!focusedAgent || focusedAgent.status === 'empty') {
        pushToast('no live session focused — arrow keys to pick one', 'warn');
        return;
      }
      const pending = pendingKillRef.current;
      // Second K within the arm window AND on the same target → confirm.
      if (pending && pending.id === focusedAgent.id) {
        clearTimeout(pending.timer);
        pendingKillRef.current = null;
        const wasError = focusedAgent.status === 'error';
        const slot = focusedAgent.slot;
        fleet.kill(focusedAgent.id);
        pushToast(wasError ? `cleared errored slot ${slot}` : `killed slot ${slot}`, 'ok');
        if (getResumeRecord(slot)) {
          pushToast(`saved session still on slot ${slot} · :forget ${slot} to drop it`, 'info');
        }
        return;
      }
      // First press — arm. If a stale arm exists for another slot,
      // discard it (only one arm at a time, no cross-slot confusion).
      if (pending) clearTimeout(pending.timer);
      const slot = focusedAgent.slot;
      const id = focusedAgent.id;
      const timer = setTimeout(() => {
        if (pendingKillRef.current && pendingKillRef.current.timer === timer) {
          pendingKillRef.current = null;
        }
      }, KILL_ARM_MS);
      pendingKillRef.current = { id, slot, timer };
      pushToast(`press K again to kill slot ${slot} · cancels in 3s`, 'warn');
      return;
    }
    if (input === 'a' || input === 'A') {
      if (focusedAgent && focusedAgent.status !== 'empty') {
        const a = fleet.agentById(focusedAgent.id);
        if (a) { a.approve(); pushToast(`approve → slot ${focusedAgent.slot}`, 'ok'); }
      } else {
        pushToast(`no live session focused`, 'warn');
      }
      return;
    }
  });

  // ── Actions ────────────────────────────────────────────
  // `~` and `~/foo` expand to the real homedir before we hand the path to
  // the claude subprocess (which does not do shell expansion on cwd).
  const expandTilde = (p) => {
    if (!p) return p;
    if (p === '~') return homedir();
    if (p.startsWith('~/')) return join(homedir(), p.slice(2));
    return p;
  };

  const launchSession = (payload) => {
    try {
      // Fleet-wide daily budget guardrail — refuse new launches once
      // today's spend exceeds the configured budget. Existing sessions
      // keep running; this only blocks NEW work that would compound the
      // overage. Bypass with :budget 0 to disable.
      const budget = settings.dailyBudgetUSD || 0;
      const spent = costStoreRef.current.dayCost();
      if (budget > 0 && spent >= budget) {
        pushToast(
          `daily budget reached · $${spent.toFixed(2)} / $${budget.toFixed(2)} · :budget <usd> to raise`,
          'error',
        );
        return;
      }

      let { slot, repoPath, branch, model, permissionMode, prompt } = payload;
      repoPath = expandTilde(repoPath);

      if (!repoPath) {
        pushToast(`no path to launch`, 'warn');
        return;
      }

      const perm = permissionMode || settings.defaultPermission || 'acceptEdits';
      // Layer-2 memory: if plugin_projectMemory is enabled and the
      // launch cwd has a .mc/MEMORY.md, prepend its contents to the
      // first prompt. Silent no-op when memory file is absent.
      let finalPrompt = prompt && prompt.trim() ? prompt.trim() : null;
      if (isPluginEnabled(settings, 'plugin_projectMemory') && finalPrompt) {
        const memBody = readProjectMemory(repoPath);
        if (memBody) {
          finalPrompt = injectMemoryIntoPrompt(finalPrompt, memBody);
          pushToast(`project memory injected from ${memoryPathFor(repoPath)} (${memBody.length}b)`, 'info');
        }
      }
      fleet.launch({
        slot,
        cwd: repoPath,
        branch,
        model,
        name: (repoPath || '').split('/').filter(Boolean).pop() || 'session',
        permissionMode: perm,
        prompt: finalPrompt,
      });
      setModal(null);
      setNewSlot(null);
      setFocusedSlot(slot);
      pushToast(`launched slot ${slot} · ${model} · ${perm}`, perm === 'bypassPermissions' ? 'warn' : 'ok');
    } catch (e) {
      pushToast(`launch failed: ${e?.message || String(e)}`, 'error');
    }
  };

  const sendBroadcast = (text, targetIds) => {
    // 0070: broadcast() now returns { sent, skipped } — paused/empty targets are
    // skipped (a SIGSTOPped agent can't receive). Surface the skip so the user
    // knows a slot didn't get the message.
    const { sent, skipped } = fleet.broadcast(targetIds, text, settings.broadcastStaggerMs ?? 0);
    setModal(null);
    const tail = skipped ? ` · skipped ${skipped}` : '';
    pushToast(`broadcast → ${sent} session${sent === 1 ? '' : 's'}${tail}`, 'ok');
  };

  // Launch one slot from a saved record. Two modes, keyed off the record:
  //   - full record (has sessionId, !fresh) → fleet.resume → `claude --resume`
  //     rehydrates the conversation; seed the saved in/out/cost totals so they
  //     CONTINUE (new turns accumulate on top; ctx is restored separately by
  //     primeStatusFromDisk). This is what a proper quit+save preserves.
  //   - location-only ("fresh") record → fleet.launch a brand-new session in
  //     the repo, no history, totals at 0. This is what every non-save exit
  //     (don't-save, terminal close, crash) leaves behind.
  // Returns 'resumed' | 'fresh'. Throws on launch failure.
  const launchFromRecord = (slot, rec) => {
    const permissionMode = rec.permissionMode || settings.defaultPermission || 'acceptEdits';
    if (rec.fresh || !rec.sessionId) {
      fleet.launch({
        slot, cwd: rec.cwd, branch: rec.branch, model: rec.model,
        name: rec.name, permissionMode, prompt: null,
      });
      return 'fresh';
    }
    const agent = fleet.resume({
      slot, sessionId: rec.sessionId, cwd: rec.cwd, branch: rec.branch,
      model: rec.model, name: rec.name, permissionMode,
    });
    if (agent) {
      if (rec.tokensIn != null) agent.tokensIn = rec.tokensIn;
      if (rec.tokensCacheRead != null) agent.tokensCacheRead = rec.tokensCacheRead;
      if (rec.tokensOut != null) agent.tokensOut = rec.tokensOut;
      if (rec.costSession != null) agent.costSession = rec.costSession;
    }
    return 'resumed';
  };

  const resumeSession = (slot, rec) => {
    try {
      const how = launchFromRecord(slot, rec);
      setModal(null);
      setNewSlot(null);
      setFocusedSlot(slot);
      pushToast(`${how === 'fresh' ? 'opened fresh' : 'resumed'} slot ${slot} · ${rec.name}`, 'ok');
    } catch (e) {
      pushToast(`resume failed: ${e?.message || String(e)}`, 'error');
    }
  };

  // Bulk-resume every saved session whose slot is currently empty.
  // Called by the `:resume-all` command bar verb and the boot hook
  // (when settings.autoResumeOnStart is true). Pass the agents snapshot
  // explicitly so the boot path can use a fresh fleet.snapshot() result
  // instead of a stale closure value.
  const resumeAllSessions = (currentAgents) => {
    // Only the sessions that were OPEN at the last close — not every slot that
    // ever held a session (those stay in bySlot for manual `:resume <slot>`).
    const recs = listOpenResumeRecords();
    let skipped = 0;
    const toResume = [];
    for (const r of recs) {
      const inUse = currentAgents.find(a => a.slot === r.slot && a.status !== 'empty');
      if (inUse) { skipped++; continue; }
      toResume.push(r);
    }
    // Stagger the cold starts: resuming N sessions opens N streaming API
    // connections, and firing them at once is a self-induced ECONNRESET /
    // overload risk. Space them by broadcastStaggerMs (shared knob).
    const gap = Math.max(0, settings.broadcastStaggerMs ?? 0);
    // Planned fresh vs. resumed split, computed up-front so the toast is accurate
    // even though the actual launches are staggered (and thus async).
    const plannedFresh = toResume.filter(r => r.fresh || !r.sessionId).length;
    toResume.forEach((r, i) => {
      const doResume = () => {
        try {
          launchFromRecord(r.slot, r);
        } catch (e) {
          pushToast(`slot ${r.slot} failed: ${e?.message || String(e)}`, 'warn');
        }
      };
      if (gap === 0 || i === 0) doResume();
      else setTimeout(doResume, gap * i);
    });
    return { scheduled: toResume.length, skipped, total: recs.length, counts: { fresh: plannedFresh } };
  };

  const sendOne = (text, id) => {
    const a = fleet.agentById(id);
    if (a) a.send(text);
  };

  // Cycle a session's permission mode through the three core dev modes.
  // Used by Shift+Tab from both the main view and the Zoom modal.
  const cyclePerm = (agentLike) => {
    if (!agentLike || agentLike.status === 'empty') {
      pushToast(`no live session focused`, 'warn');
      return;
    }
    const a = fleet.agentById(agentLike.id);
    if (!a) return;
    const cycle = ['plan', 'auto', 'acceptEdits'];
    const cur = agentLike.permissionMode || a.permissionMode || 'acceptEdits';
    const i = cycle.indexOf(cur);
    const next = cycle[(i + 1) % cycle.length] || cycle[0];
    a.changePermissionMode(next);
    pushToast(`permission: ${next}`, next === 'bypassPermissions' ? 'warn' : 'ok');
  };

  // ── Layout ──────────────────────────────────────────────
  // Empty slots are hidden — the grid only renders agents that exist.
  // Card width fills the terminal evenly across however many are live,
  // capped at settings.gridCols columns so wide terminals don't end up
  // with a single huge card. AND auto-reduces column count when the
  // terminal is too narrow to fit gridCols cards at the 20-col minimum
  // (audit: cards used to spill past the right edge and overlap when
  // a 5-col grid was forced into an 80-col terminal).
  const termCols = termSize.cols;
  const termRows = termSize.rows;
  const visibleAgents = agents.filter(a => a.status !== 'empty');

  // Grid geometry + pagination is a pure function (tui/lib/gridLayout.js) so
  // the row math is testable — ink-testing-library can't set terminal rows.
  // The active pane follows the focused card; overflow beyond windowsPerPane
  // (or beyond what fits the terminal height) pages instead of clipping.
  const focusedGridIdx = visibleAgents.findIndex(a => a.slot === focusedSlot);
  const layout = computeGridLayout({
    termCols,
    termRows,
    gridCols: settings.gridCols,
    count: visibleAgents.length,
    fleetLogLines: settings.fleetLogLines,
    windowsPerPane: settings.windowsPerPane,
    focusedIndex: focusedGridIdx,
  });
  const { effectiveCols, cardW, pageCount, pageIndex, pageStart, pageEnd, dynamicFleetLogLines } = layout;
  const pageAgents = visibleAgents.slice(pageStart, pageEnd);
  const visibleRows = chunkRows(pageAgents, effectiveCols);

  // Feedback strip — always rendered above the status bar so the affordance
  // is visible. Shows queued toasts (actions, errors, command output) or a
  // short idle hint when empty. Multiple toasts stack vertically.
  const FeedbackStrip = () => (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.accent}>▸ FEEDBACK</Text>
        <Text color={theme.dim}> · </Text>
        <Text color={theme.faint}>{toasts.length === 0 ? 'idle' : `${toasts.length} message${toasts.length === 1 ? '' : 's'}`}</Text>
      </Box>
      {toasts.length === 0 ? (
        <Box>
          <Text color={theme.faint}>  ready · </Text>
          <Text color={theme.dim}>press </Text>
          <Text color={theme.accent}>?</Text>
          <Text color={theme.dim}> for help · </Text>
          <Text color={theme.accent}>n</Text>
          <Text color={theme.dim}> new session · </Text>
          <Text color={theme.accent}>:</Text>
          <Text color={theme.dim}> command bar</Text>
        </Box>
      ) : toasts.map(t => (
        <Box key={t.id}>
          <Text color={theme[TOAST_COLORS[t.kind] || 'accent']}>  ● </Text>
          <Text color={theme.fg} wrap="truncate">{t.text}</Text>
        </Box>
      ))}
    </Box>
  );

  // Status-bar wrapper — passes command-bar state through so the bar can
  // render the live buffer when the user is typing `/` or `:`.
  const renderStatusBar = (mode = 'normal', focusedOverride) => (
    <StatusBar
      mode={mode}
      focused={focusedOverride !== undefined ? focusedOverride : (focusedAgent?.status === 'empty' ? null : focusedAgent)}
      cmdMode={cmdMode}
      cmdBuffer={cmdBuffer}
      filterActive={filterActive}
      theme={theme}
    />
  );

  // Modals grow with the terminal so long content (cloud-storage paths,
  // claude tool output, etc.) fits without truncation. We clamp per-modal:
  //  - min keeps narrow terminals readable
  //  - max prevents lines so wide they're hard to scan
  //
  // The host Box pads 2 chars on each side (paddingX={2}), so we subtract
  // 4 from termCols to find the usable width inside the wrapper.
  const usable = Math.max(20, termCols - 4);
  const modalWidth = (min, max) => Math.min(max, Math.max(min, usable));

  // Ink doesn't reliably stack absolutely-positioned overlays over an active
  // layout — characters can interleave at the same row/col. We replace the
  // main view with the modal when one is open. Status bar stays visible so
  // the user keeps the breadcrumbs.
  if (modal === 'help') {
    return (
      <Box flexDirection="column" width={termCols} height={termRows}>
        <Box paddingX={2} paddingY={1}><Help onClose={() => setModal(null)} theme={theme} width={modalWidth(64, 110)} view={helpView} /></Box>
        <Box flexGrow={1} />
        <FeedbackStrip />
        {renderStatusBar('normal')}
      </Box>
    );
  }
  if (modal === 'quit') {
    const liveCount = agents.filter(a => a.status !== 'empty').length;
    return (
      <Box flexDirection="column" width={termCols} height={termRows}>
        <Box paddingX={2} paddingY={1}>
          <QuitConfirm onCancel={() => setModal(null)} onQuit={(mode) => setQuitMode(mode)} theme={theme} agentCount={liveCount} />
        </Box>
        <Box flexGrow={1} />
        <FeedbackStrip />
        {renderStatusBar('normal')}
      </Box>
    );
  }
  if (modal === 'bcast') {
    return (
      <Box flexDirection="column" width={termCols} height={termRows}>
        <Box paddingX={2} paddingY={1}><Broadcast agents={agents} onSend={sendBroadcast} onClose={() => setModal(null)} theme={theme} width={modalWidth(84, 160)} /></Box>
        <Box flexGrow={1} />
        <FeedbackStrip />
        {renderStatusBar('broadcast')}
      </Box>
    );
  }
  if (modal === 'dash') {
    return (
      <Box flexDirection="column" width={termCols} height={termRows}>
        <Box paddingX={2} paddingY={1}>
          <Dashboard
            agents={agents}
            threshold={threshold}
            theme={theme}
            weekCost={weekCost}
            dayCost={dayCost}
            budget={settings.dailyBudgetUSD || 0}
            initialSlot={focusedSlot}
            onClose={() => setModal(null)}
            onFocus={(slot) => setFocusedSlot(slot)}
            onZoom={(id) => { setZoomedId(id); setModal('zoom'); }}
            width={modalWidth(90, 200)}
          />
        </Box>
        <Box flexGrow={1} />
        <FeedbackStrip />
        {renderStatusBar('normal')}
      </Box>
    );
  }
  if (modal === 'new' && newSlot) {
    return (
      <Box flexDirection="column" width={termCols} height={termRows}>
        <Box paddingX={2} paddingY={1}>
          <NewSession
            slot={newSlot}
            repos={repos}
            defaultModel={settings.defaultModel}
            onLaunch={launchSession}
            onClose={() => { setModal(null); setNewSlot(null); }}
            theme={theme}
            width={modalWidth(84, 180)}
          />
        </Box>
        <Box flexGrow={1} />
        <FeedbackStrip />
        {renderStatusBar('command')}
      </Box>
    );
  }
  if (modal === 'settings') {
    return (
      <Box flexDirection="column" width={termCols} height={termRows}>
        <Box paddingX={2} paddingY={1}><Settings settings={settings} setSettings={setSettingsState} onClose={() => setModal(null)} theme={theme} width={modalWidth(92, 140)} /></Box>
        <Box flexGrow={1} />
        <FeedbackStrip />
        {renderStatusBar('command')}
      </Box>
    );
  }
  if (modal === 'repoPicker') {
    return (
      <Box flexDirection="column" width={termCols} height={termRows}>
        <Box paddingX={2} paddingY={1}>
          <RepoPicker
            current={settings.repoParents}
            onPick={(absPath) => {
              setSettingsState(s => ({ ...s, repoParents: [absPath] }));
              setModal(null);
              pushToast(`repo location → ${absPath}`, 'ok');
            }}
            onClose={() => setModal(null)}
            theme={theme}
            width={modalWidth(84, 160)}
          />
        </Box>
        <Box flexGrow={1} />
        <FeedbackStrip />
        {renderStatusBar('command')}
      </Box>
    );
  }
  if (modal === 'zoom' && zoomedAgent) {
    // Zoom needs to know its actual rendered height. The full termRows
    // is NOT what it has — the wrapper consumes paddingY=2 + FeedbackStrip
    // (1 row) + StatusBar (1 row) = 4 rows. Without this, Zoom sizes its
    // PTY body to (termRows - chrome) using the full terminal height,
    // and claude's bottom 2 rows of UI (status bar, update banner) bleed
    // past mc's footer.
    const zoomHeight = Math.max(10, termRows - 4);
    return (
      <Box flexDirection="column" width={termCols} height={termRows}>
        <Box paddingX={2} paddingY={1}>
          <Zoom
            agent={zoomedAgent}
            threshold={threshold}
            onClose={() => { setModal(null); setZoomedId(null); }}
            onCyclePerm={() => cyclePerm(zoomedAgent)}
            theme={theme}
            width={modalWidth(104, 220)}
            height={zoomHeight}
            usage={usage}
            fmtReset={fmtReset}
            weekCost={weekCost}
            hideUpdateBanner={settings.hideClaudeUpdateBanner !== false}
          />
        </Box>
        <Box flexGrow={1} />
        <FeedbackStrip />
        {renderStatusBar('focused', zoomedAgent)}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={termCols} height={termRows}>
      <Header agents={agents} threshold={threshold} nowStr={nowStr} sessionStr={sessionStr} theme={theme} auth={auth} />
      <Aggregate agents={agents} fleetTpm={fleetTpm} aggSpark={aggSpark} theme={theme} usage={usage} fmtReset={fmtReset} />

      {/* Grid of cards — empty slots are hidden; live cards autosize to
          fill the row. Filter pass dims non-matching slots. */}
      {visibleAgents.length === 0 ? (
        <Box flexDirection="column" paddingX={2} paddingY={2}>
          <Text color={theme.dim}>no sessions running</Text>
          <Box>
            <Text color={theme.faint}>press </Text>
            <Text color={theme.accent}>n</Text>
            <Text color={theme.faint}> (or </Text>
            <Text color={theme.accent}>ctrl+n</Text>
            <Text color={theme.faint}>) to launch one · </Text>
            <Text color={theme.accent}>?</Text>
            <Text color={theme.faint}> for help · </Text>
            <Text color={theme.accent}>q</Text>
            <Text color={theme.faint}> to quit</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {visibleRows.map((rowAgents, ri) => (
            <Box key={ri + pageStart}>
              {rowAgents.map(a => {
                const matched = filterMatches(a);
                return (
                  <Box key={a.id} width={cardW}>
                    <Card
                      agent={a}
                      cardWidth={cardW}
                      focused={a.slot === focusedSlot}
                      threshold={threshold}
                      warnPct={settings.warnPct}
                      borderStyle={settings.borderStyle}
                      showTools={settings.cardShowTools}
                      theme={matched ? theme : { ...theme, fg: theme.dim, accent: theme.faint, cyan: theme.faint, white: theme.dim }}
                    />
                  </Box>
                );
              })}
            </Box>
          ))}
          {pageCount > 1 && (
            // Pager strip — only when the grid spans more than one pane. The
            // active pane follows focus; [ / ] jump focus to the adjacent
            // pane (see the hotkey handler).
            <Box paddingX={1}>
              <Text color={theme.faint}>pane </Text>
              <Text color={theme.accent}>{pageIndex + 1}</Text>
              <Text color={theme.faint}>/{pageCount} · </Text>
              <Text color={theme.accent}>[</Text>
              <Text color={theme.faint} > </Text>
              <Text color={theme.accent}>]</Text>
              <Text color={theme.faint}> to switch panes</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Fleet log — sized to fill whatever vertical space is left. */}
      {settings.showFleetLog && (
        <FleetLog log={fleetLog} focusedId={focusedAgent?.id} theme={theme} maxLines={dynamicFleetLogLines} mode={settings.fleetLogMode} width={termSize.cols} />
      )}

      {/* Toasts above the status bar */}
      <FeedbackStrip />

      {/* Status bar */}
      {renderStatusBar('normal')}
    </Box>
  );
}

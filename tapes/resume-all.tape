# tapes/resume-all.tape — the "resume all" demo GIF.
# Render with: vhs tapes/resume-all.tape   (install VHS: `brew install vhs`)
# Populate the fleet, quit-with-save (q → s), relaunch (empty grid + hint), then
# :resume-all restores every session at once. Isolates HOME so the demo starts
# from a clean session store and the save/restore round-trips deterministically.

Output assets/resume-all.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 760
Set Padding 16
Set Framerate 24
Set PlaybackSpeed 1.0

Hide
Type "export HOME=/tmp/mc-vhs-resume && rm -rf $HOME && mkdir -p $HOME"
Enter
Show

# ── Phase 1: populate the fleet (3 mock sessions) ──
Type "MC_MOCK=quick-reply npm start"
Enter
Sleep 4s
Type "n"
Sleep 700ms
Type "~"
Sleep 400ms
Enter
Sleep 2500ms
Type "n"
Sleep 700ms
Type "~"
Sleep 400ms
Enter
Sleep 2500ms
Type "n"
Sleep 700ms
Type "~"
Sleep 400ms
Enter
Sleep 3s

# ── Quit with save (q → s) — persists the open set ──
Type "q"
Sleep 1s
Type "s"
Sleep 2s

# ── Phase 2: relaunch — empty grid + "saved sessions · :resume-all" hint ──
Type "MC_MOCK=quick-reply npm start"
Enter
Sleep 4s

# ── One command brings the whole fleet back ──
Type ":resume-all"
Sleep 1s
Enter
Sleep 5s

Type "q"
Sleep 1s
Type "s"
Sleep 500ms
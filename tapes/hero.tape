# tapes/hero.tape — the README hero GIF.
# Render with: vhs tapes/hero.tape   (install VHS: `brew install vhs`)
# Drives MC_MOCK so the recording is deterministic and needs no live Claude
# auth or token spend. Timings are a starting point — calibrate on first run.

Output assets/hero.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 760
Set Padding 16
Set Framerate 24
Set PlaybackSpeed 1.0

# Launch against a mock fixture (see server/fixtures/).
Type "MC_MOCK=quick-reply npm start"
Enter
Sleep 4s

# Open a couple of sessions to populate the grid.
Type "n"
Sleep 1s
Enter
Sleep 3s
Type "n"
Sleep 1s
Enter
Sleep 3s

# Navigate the fleet.
Right@800ms
Down@800ms
Left@800ms
Sleep 1s

# Zoom into the focused session, then back out.
Enter
Sleep 3s
Ctrl+q
Sleep 1s

# Show the Matrix theme live.
Type ":theme matrix"
Enter
Sleep 3s

# Back to BlueArch, then quit.
Type ":theme bluearch"
Enter
Sleep 2s
Type "q"
Sleep 1s

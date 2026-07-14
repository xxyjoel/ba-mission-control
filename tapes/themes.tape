# tapes/themes.tape — the palette gallery, ending on green-phosphor Matrix.
# Render: vhs tapes/themes.tape   (install VHS: `brew install vhs`)
# Deterministic via MC_MOCK; calibrate the Sleeps on first run.

Output assets/themes.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 760
Set Padding 16
Set Framerate 24

Type "MC_MOCK=quick-reply npm start"
Enter
Sleep 4s

# Populate a couple of cards so the palette change is visible across the grid.
Type "n"
Sleep 800ms
Enter
Sleep 2s
Type "n"
Sleep 800ms
Enter
Sleep 2s

# Cycle palettes via the command bar. Each `:theme <name>` applies instantly.
Type ":theme tokyo night"
Enter
Sleep 1800ms
Type ":theme gruvbox dark"
Enter
Sleep 1800ms
Type ":theme catppuccin mocha"
Enter
Sleep 1800ms
Type ":theme amber"
Enter
Sleep 1800ms

# Land on the launch aesthetic.
Type ":theme matrix"
Enter
Sleep 2500ms

# Back to default, then quit.
Type ":theme bluearch"
Enter
Sleep 1500ms
Type "q"
Sleep 1s

# tapes/zoom.tape — the zoom modal: scroll mode, stats + tools panels.
# Render: vhs tapes/zoom.tape   (install VHS: `brew install vhs`)
# Deterministic via MC_MOCK; calibrate the Sleeps on first run.

Output assets/zoom.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 760
Set Padding 16
Set Framerate 24

# A fixture with tool activity reads well in the zoom body.
Type "MC_MOCK=tool-loop npm start"
Enter
Sleep 4s

# Launch one session and zoom into it. The NewSession modal needs a valid dir
# before Enter launches; "~" resolves (cwd is cosmetic under MC_MOCK).
Type "n"
Sleep 800ms
Type "~"
Sleep 500ms
Enter
Sleep 3s
Enter
Sleep 3s

# Scroll mode (Ctrl+Y), then walk the history: w/s line, b/f half-page, g/G ends.
Ctrl+y
Sleep 1s
Type "s"
Sleep 500ms
Type "s"
Sleep 500ms
Type "f"
Sleep 800ms
Type "g"
Sleep 800ms
Type "G"
Sleep 800ms
Escape
Sleep 1s

# Toggle the stats panel, then the tools panel.
Ctrl+u
Sleep 2s
Ctrl+k
Sleep 2s

# Back to the fleet.
Ctrl+q
Sleep 1s
Type "q"
Sleep 1s

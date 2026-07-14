# tapes/dashboard.tape — the fleet dashboard (d): sortable table of all agents.
# Render: vhs tapes/dashboard.tape   (install VHS: `brew install vhs`)
# Deterministic via MC_MOCK; calibrate the Sleeps on first run.

Output assets/dashboard.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 760
Set Padding 16
Set Framerate 24

Type "MC_MOCK=long-thinking npm start"
Enter
Sleep 4s

# Spin up a few sessions so the dashboard has rows to sort.
Type "n"
Sleep 700ms
Enter
Sleep 1500ms
Type "n"
Sleep 700ms
Enter
Sleep 1500ms
Type "n"
Sleep 700ms
Enter
Sleep 2s

# Open the fleet dashboard.
Type "d"
Sleep 2500ms

# Move the selection down the rows, then close.
Down@700ms
Down@700ms
Up@700ms
Sleep 1500ms
Escape
Sleep 1s
Type "q"
Sleep 1s

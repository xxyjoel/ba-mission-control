// tests/lib/force-color.js — pin chalk's colour level before ink loads.
//
// A test that reads a colour back out of a rendered frame is only meaningful if
// the frame HAS colour. chalk decides that once, at import time, from the
// environment: truecolor on a developer terminal, and nothing at all on a
// headless CI runner with no TTY. So a frame that is correct renders the
// ShellOverlay cursor as `ESC[48;2;…m` here and as bare text there, and an
// assertion that looks for the cursor passes locally and fails in CI.
//
// That shipped twice. The first fix widened the matcher to the basic 16-colour
// palette, which looked right because the author's shell exports FORCE_COLOR=3
// — the simulated CI run still had colour and still passed. The runner has no
// FORCE_COLOR, drops to level 0, and emits no escape to match at any width.
//
// Import this FIRST, before ink or any module that pulls chalk. ESM evaluates
// imports in source order, so this side effect lands before chalk computes its
// level. Importing it later is a no-op.
process.env.FORCE_COLOR = '3';

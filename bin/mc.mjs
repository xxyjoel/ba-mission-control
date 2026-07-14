#!/usr/bin/env node
// bin/mc.mjs — CLI entry for `mc` (BlueArch Mission Control TUI).
//
// We use tsx's programmatic loader registration so the bin shebang stays at
// plain `node` and JSX files in tui/ still load transparently. This keeps
// `mc` runnable as a normal Node script + as `npm start`.

import { register } from 'tsx/esm/api';

register();
await import('../tui/main.jsx');

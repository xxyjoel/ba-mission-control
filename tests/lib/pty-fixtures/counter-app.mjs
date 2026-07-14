#!/usr/bin/env node
// tests/lib/pty-fixtures/counter-app.mjs — node entry that registers the
// tsx ESM loader and then imports counter-app.jsx. We need this shim so
// PTY recipes can spawn the fixture with a plain `node` invocation and
// pick up JSX transpilation without an extra wrapper.

import { register } from 'tsx/esm/api';

register();
await import('./counter-app.jsx');

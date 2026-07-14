#!/usr/bin/env node
// tests/lib/pty-fixtures/textfield-app.mjs — node entry shim that
// registers the tsx ESM loader before importing the JSX fixture. Lets
// PTY recipes spawn the fixture with a plain `node` invocation.

import { register } from 'tsx/esm/api';

register();
await import('./textfield-app.jsx');

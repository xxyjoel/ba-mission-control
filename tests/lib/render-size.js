// tests/lib/render-size.js — render an Ink tree against a stdout whose
// columns/rows the TEST controls. ink-testing-library pins columns=100 and
// reports no rows, which is exactly why the frame-budget defects (0408 R1-R4)
// could not be pinned with it: they only appear at specific terminal sizes.

import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';

class Stdout extends EventEmitter {
  constructor(cols, rows) { super(); this._cols = cols; this._rows = rows; this.frames = []; }
  get columns() { return this._cols; }
  get rows() { return this._rows; }
  write = (frame) => { this.frames.push(frame); this._last = frame; };
  lastFrame = () => this._last;
}

class Stdin extends EventEmitter {
  isTTY = true;
  write = (d) => { this.data = d; this.emit('readable'); this.emit('data', d); };
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
  read = () => { const d = this.data; this.data = null; return d; };
}

export function renderAt(tree, { cols = 100, rows = 40 } = {}) {
  const stdout = new Stdout(cols, rows);
  const stdin = new Stdin();
  const inst = inkRender(tree, {
    stdout, stderr: new Stdout(cols, rows), stdin,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  return { stdin, stdout, lastFrame: () => stdout.lastFrame(), rerender: inst.rerender, unmount: inst.unmount };
}

export const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
export const stripAnsi = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
export const frameLines = (f) => (f == null ? [] : f.split('\n'));

export const THEME = {
  accent: 'cyan', bg: 'black', fg: 'white', dim: 'gray', faint: 'gray',
  red: 'red', yellow: 'yellow', green: 'green', cyan: 'cyan', brBlue: 'blue',
  magenta: 'magenta', white: 'white',
};

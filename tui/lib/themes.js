// tui/lib/themes.js — color palettes ported from Mission Control TUI.html.
//
// In Ink we can't override CSS vars, so each theme exposes named tokens that
// components read via the `useTheme()` hook. Keys mirror the web design so
// future palette additions stay 1:1.

export const THEMES = {
  'BlueArch': {
    bg: '#0b0d12', fg: '#c5cdd6', dim: '#6c7787', faint: '#404a59',
    red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#ffffff',
    accent: '#19D4D4', brBlue: '#7cb9ff',
  },
  'Tokyo Night': {
    bg: '#1a1b26', fg: '#c0caf5', dim: '#787c99', faint: '#414868',
    red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#ffffff',
    accent: '#7dcfff', brBlue: '#7aa2f7',
  },
  'Gruvbox Dark': {
    bg: '#1d2021', fg: '#ebdbb2', dim: '#a89984', faint: '#665c54',
    red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f',
    blue: '#83a598', magenta: '#d3869b', cyan: '#8ec07c', white: '#fbf1c7',
    accent: '#8ec07c', brBlue: '#83a598',
  },
  'Catppuccin Mocha': {
    bg: '#1e1e2e', fg: '#cdd6f4', dim: '#7f849c', faint: '#45475a',
    red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#ffffff',
    accent: '#94e2d5', brBlue: '#89b4fa',
  },
  'Solarized Dark': {
    bg: '#002b36', fg: '#93a1a1', dim: '#586e75', faint: '#3a4a51',
    red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#fdf6e3',
    accent: '#2aa198', brBlue: '#268bd2',
  },
  'Amber (CRT)': {
    bg: '#1a0e00', fg: '#ffb000', dim: '#a36e00', faint: '#5c3d00',
    red: '#ff6b00', green: '#ffe000', yellow: '#ffd060',
    blue: '#ffb000', magenta: '#ff8800', cyan: '#ffd060', white: '#fff5d6',
    accent: '#ffd060', brBlue: '#ffd060',
  },
  // Green phosphor "Matrix" palette — near-black bg, bright-green fg/accent.
  // red/yellow kept distinct from green so error/warn status stays legible.
  'Matrix': {
    bg: '#000600', fg: '#33ff66', dim: '#149936', faint: '#0a5c22',
    red: '#ff5555', green: '#33ff66', yellow: '#d7ff4f',
    blue: '#2fe6a0', magenta: '#7bffb0', cyan: '#00ffaa', white: '#d6ffe0',
    accent: '#00ff66', brBlue: '#66ffcc',
  },
};

export const DEFAULT_THEME = 'BlueArch';

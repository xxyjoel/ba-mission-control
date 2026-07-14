// tests/themes.test.jsx — every theme must expose the full token set so a
// component reading `theme.<key>` never renders `undefined` (which Ink treats
// as "inherit", producing invisible/mis-colored text). Guards new palettes
// like 'Matrix' against a missing key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, DEFAULT_THEME } from '../tui/lib/themes.js';
import { SETTINGS_SCHEMA } from '../tui/lib/settings.js';

const KEYS = [
  'bg', 'fg', 'dim', 'faint', 'red', 'green', 'yellow',
  'blue', 'magenta', 'cyan', 'white', 'accent', 'brBlue',
];

test('every theme defines all color tokens as hex strings', () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const key of KEYS) {
      assert.match(
        theme[key] ?? '',
        /^#[0-9a-fA-F]{6}$/,
        `theme "${name}" is missing or has a malformed "${key}"`,
      );
    }
  }
});

test('Matrix theme is registered and selectable', () => {
  assert.ok(THEMES['Matrix'], 'Matrix theme must exist in THEMES');
  const colors = SETTINGS_SCHEMA.find((g) => g.id === 'colors');
  const themeItem = colors?.items.find((i) => i.key === 'theme');
  assert.ok(
    themeItem?.options.includes('Matrix'),
    'Matrix must be a selectable option in the COLORS settings group',
  );
});

test('default theme exists in THEMES', () => {
  assert.ok(THEMES[DEFAULT_THEME], `default theme "${DEFAULT_THEME}" must exist`);
});

test('every settings theme option has a matching palette', () => {
  const colors = SETTINGS_SCHEMA.find((g) => g.id === 'colors');
  const options = colors.items.find((i) => i.key === 'theme').options;
  for (const name of options) {
    assert.ok(THEMES[name], `settings offers "${name}" but no palette defines it`);
  }
});

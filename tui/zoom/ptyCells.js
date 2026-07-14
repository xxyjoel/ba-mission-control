// tui/zoom/ptyCells.js — translate xterm-headless buffer cells into Ink
// <Text> prop bundles.
//
// xterm.js encodes per-cell colour as (value, mode) where mode is one of
// the CM_* constants below. We map those to Ink's color names where
// possible (so the user's theme accents stay coherent in Ink palettes)
// and fall back to hex for 256-palette / RGB. The 16-colour names match
// Chalk / Ink's standard set.

// xterm.js Attribute constants (from common/buffer/Constants.ts).
const CM_DEFAULT = 0;
const CM_P16     = 0x1000000;
const CM_P256    = 0x2000000;
const CM_RGB     = 0x3000000;

const ANSI16 = [
  'black', 'red', 'green', 'yellow',
  'blue', 'magenta', 'cyan', 'white',
  'gray', 'redBright', 'greenBright', 'yellowBright',
  'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
];

// xterm 256-palette: 0..15 are the ANSI16; 16..231 are a 6×6×6 RGB cube;
// 232..255 are 24 greyscale steps. Used when we need to flatten a
// palette index to a hex colour for Ink (Ink doesn't speak 256 directly).
function palette256ToHex(idx) {
  if (idx < 16) {
    // Caller should have used ANSI16 directly; safety fallback.
    const PRIMARIES = ['#000000','#cd0000','#00cd00','#cdcd00','#0000ee','#cd00cd','#00cdcd','#e5e5e5',
                       '#7f7f7f','#ff0000','#00ff00','#ffff00','#5c5cff','#ff00ff','#00ffff','#ffffff'];
    return PRIMARIES[idx];
  }
  if (idx >= 232) {
    const grey = 8 + (idx - 232) * 10;
    const hex = grey.toString(16).padStart(2, '0');
    return `#${hex}${hex}${hex}`;
  }
  // 6×6×6 cube — each channel maps via [0, 95, 135, 175, 215, 255].
  const STEPS = [0, 95, 135, 175, 215, 255];
  const n = idx - 16;
  const r = STEPS[Math.floor(n / 36) % 6];
  const g = STEPS[Math.floor(n / 6)  % 6];
  const b = STEPS[n % 6];
  return `#${[r,g,b].map(c => c.toString(16).padStart(2,'0')).join('')}`;
}

function colorFromAttrs(value, mode) {
  if (mode === CM_DEFAULT || value < 0) return undefined;
  if (mode === CM_P16)  return ANSI16[value & 0xf];
  if (mode === CM_P256) {
    return value < 16 ? ANSI16[value] : palette256ToHex(value);
  }
  if (mode === CM_RGB) {
    const r = (value >>> 16) & 0xff;
    const g = (value >>> 8) & 0xff;
    const b = value & 0xff;
    return `#${[r,g,b].map(c => c.toString(16).padStart(2,'0')).join('')}`;
  }
  return undefined;
}

// Return a canonical key for a cell's style — two cells with the same key
// can be merged into a single <Text> segment for performance.
function styleKey(cell) {
  const fg = `${cell.getFgColor()}|${cell.getFgColorMode()}`;
  const bg = `${cell.getBgColor()}|${cell.getBgColorMode()}`;
  const flags = (cell.isBold() ? 'B' : '') +
                (cell.isItalic() ? 'I' : '') +
                (cell.isUnderline() ? 'U' : '') +
                (cell.isDim() ? 'D' : '') +
                (cell.isInverse() ? 'V' : '') +
                (cell.isStrikethrough?.() ? 'S' : '');
  return `${fg}/${bg}/${flags}`;
}

function propsFromCell(cell) {
  return {
    color: colorFromAttrs(cell.getFgColor(), cell.getFgColorMode()),
    backgroundColor: colorFromAttrs(cell.getBgColor(), cell.getBgColorMode()),
    bold: cell.isBold(),
    italic: cell.isItalic(),
    underline: cell.isUnderline(),
    dimColor: cell.isDim(),
    inverse: cell.isInverse(),
    strikethrough: cell.isStrikethrough?.() || false,
  };
}

// Walk one terminal row and return a list of styled runs:
//   [{ props, text }, ...]
// Adjacent cells with identical style are merged. The cursor cell (if
// cursorX is in range) is rendered as a hard-painted high-contrast
// block using cursorStyle. We avoid Ink's `inverse` prop for the
// cursor because it's flaky on whitespace-only cells (terminals don't
// always paint the inverse background when there's no glyph).
export function rowToRuns(line, cellRef, cols, cursorX = -1, cursorStyle = null) {
  const runs = [];
  if (!line) return runs;
  let curKey = null;
  let curProps = null;
  let curText = '';
  for (let x = 0; x < cols; x++) {
    line.getCell(x, cellRef);
    // Width 0 means this cell is the right half of a wide (CJK / emoji)
    // glyph; the left half already painted both columns, so skip it.
    // Width 1 or 2 is a real cell — including never-touched blanks,
    // which we render as a literal space so layout stays aligned.
    if (cellRef.getWidth() === 0) continue;
    const isCursor = x === cursorX;
    let key = styleKey(cellRef);
    if (isCursor) key += '|@';
    if (key !== curKey) {
      if (curText.length > 0) runs.push({ props: curProps, text: curText });
      curKey = key;
      curProps = propsFromCell(cellRef);
      if (isCursor && cursorStyle) {
        // Hard-paint the cursor cell. cursorStyle.backgroundColor +
        // cursorStyle.color override whatever was at the cell so the
        // cursor is visible regardless of theme, surrounding style,
        // or whether the cell glyph is whitespace.
        curProps.backgroundColor = cursorStyle.backgroundColor;
        curProps.color = cursorStyle.color;
        curProps.bold = true;
        curProps.inverse = false;
        curProps.dimColor = false;
      }
      curText = '';
    }
    let ch = cellRef.getChars();
    // Never-touched cells return '' — render as a space so claude's
    // boxed prompts / aligned UI keep their column positions. Dropping
    // them concatenated adjacent glyphs and made every line read as
    // one long word.
    if (ch === '') ch = ' ';
    curText += ch;
  }
  if (curText.length > 0) runs.push({ props: curProps, text: curText });
  return runs;
}

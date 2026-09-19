#!/usr/bin/env node
// 0349: stream a V8 .heapsnapshot and aggregate self_size by node type, WITHOUT
// loading the (multi-GB) file into memory. Optionally resolves the dominant
// type's `name` field to a constructor/string histogram via the strings table.
//
// Usage: node scripts/analyze-heapsnapshot.mjs <snapshot.heapsnapshot> [--names]
//
// The nodes array is a flat run of integers (node_fields per node). We tokenize
// the integer stream between `"nodes":[` and its closing `]` (nodes contain only
// ints + commas — no nesting), accumulating O(1) state. A second optional pass
// walks `"strings":[` to label the top `name` indices of the dominant type.

import fs from 'node:fs';

const file = process.argv[2];
const wantNames = process.argv.includes('--names');
if (!file) { console.error('usage: analyze-heapsnapshot.mjs <file> [--names]'); process.exit(1); }

// --- read the meta header (small) to learn field layout + type enum ----------
// Read only the first 8KB via a descriptor — the file is multi-GB, so a whole-file
// readFileSync would throw ERR_FS_FILE_TOO_LARGE (>2GiB).
const headBuf = Buffer.alloc(8192);
const fd = fs.openSync(file, 'r');
fs.readSync(fd, headBuf, 0, 8192, 0);
fs.closeSync(fd);
const head = headBuf.toString('latin1');
const metaMatch = head.match(/"meta":\{.*?"node_fields":\[(.*?)\].*?"node_types":\[\[(.*?)\]/s);
if (!metaMatch) { console.error('could not parse meta header'); process.exit(1); }
const nodeFields = metaMatch[1].split(',').map(s => s.replace(/"/g, ''));
const nodeTypes = metaMatch[2].split(',').map(s => s.replace(/"/g, ''));
const NF = nodeFields.length;
const TYPE_I = nodeFields.indexOf('type');
const SELF_I = nodeFields.indexOf('self_size');
const NAME_I = nodeFields.indexOf('name');
console.error(`node_fields=[${nodeFields}] (${NF}/node)  types=${nodeTypes.length}`);

// --- pass 1: stream the nodes array, sum self_size by type -------------------
const selfByType = new Array(nodeTypes.length).fill(0);
const countByType = new Array(nodeTypes.length).fill(0);
let maxSelf = 0, maxSelfType = -1;
// name histogram for the dominant type, collected only if --names (pass 2 resolves)
let dominantType = -1;               // filled after pass 1
const nameCounts = new Map();        // nameIndex -> count (for dominant type)
const nameSelf = new Map();          // nameIndex -> self_size sum

async function streamNodes(collectNamesForType) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { encoding: 'latin1', highWaterMark: 1 << 22 });
    let started = false;      // have we entered the nodes array?
    let done = false;
    let cur = 0, haveDigit = false, field = 0;
    // per-node scratch
    let nType = 0, nName = 0;
    let carry = '';           // to detect the `"nodes":[` marker across chunks
    rs.on('data', (chunk) => {
      if (done) return;
      let i = 0;
      if (!started) {
        const hay = carry + chunk;
        const m = hay.indexOf('"nodes":[');
        if (m === -1) { carry = hay.slice(-16); return; }
        started = true;
        i = m + '"nodes":['.length - carry.length;
        if (i < 0) i = 0;
      }
      const buf = chunk;
      const len = buf.length;
      for (; i < len; i++) {
        const c = buf.charCodeAt(i);
        if (c >= 48 && c <= 57) { cur = cur * 10 + (c - 48); haveDigit = true; }
        else if (c === 44 /* , */ || c === 93 /* ] */) {
          if (haveDigit) {
            if (field === TYPE_I) nType = cur;
            else if (field === SELF_I) {
              selfByType[nType] += cur;
              countByType[nType]++;
              if (cur > maxSelf) { maxSelf = cur; maxSelfType = nType; }
              if (collectNamesForType >= 0 && nType === collectNamesForType) {
                nameSelf.set(nName, (nameSelf.get(nName) || 0) + cur);
              }
            }
            else if (field === NAME_I) {
              nName = cur;
              if (collectNamesForType >= 0 && nType === collectNamesForType) {
                nameCounts.set(nName, (nameCounts.get(nName) || 0) + 1);
              }
            }
            field++;
            if (field === NF) field = 0;
            cur = 0; haveDigit = false;
          }
          if (c === 93) { done = true; rs.destroy(); break; }
        }
        // any other char (whitespace) ignored
      }
    });
    rs.on('close', resolve);
    rs.on('error', (e) => { if (done) resolve(); else reject(e); });
  });
}

console.error('pass 1: aggregating self_size by type…');
const t0 = Date.now();
await streamNodes(-1);
console.error(`pass 1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const rows = nodeTypes.map((name, i) => ({
  type: name, bytes: selfByType[i], mb: selfByType[i] / 1048576, count: countByType[i],
})).sort((a, b) => b.bytes - a.bytes);

const totalBytes = selfByType.reduce((a, b) => a + b, 0);
console.log(`\n=== self_size by node type (total ${(totalBytes / 1048576).toFixed(0)} MB across ${countByType.reduce((a,b)=>a+b,0).toLocaleString()} nodes) ===`);
for (const r of rows) {
  if (r.bytes === 0) continue;
  const pct = (r.bytes / totalBytes * 100).toFixed(1);
  const avg = r.count ? (r.bytes / r.count).toFixed(0) : 0;
  console.log(`${r.type.padEnd(20)} ${r.mb.toFixed(1).padStart(9)} MB  ${pct.padStart(5)}%  ${r.count.toLocaleString().padStart(14)} nodes  avg ${avg}B`);
}
console.log(`largest single node: ${(maxSelf/1048576).toFixed(1)} MB (type ${nodeTypes[maxSelfType]})`);

dominantType = nodeTypes.indexOf(rows[0].type);
console.error(`\ndominant type: ${rows[0].type} (index ${dominantType})`);

if (!wantNames) process.exit(0);

// --- pass 2: name-index histograms for array/string/object -------------------
// For `object` nodes name = constructor name; for `string` nodes name = the
// string's own content; for `array` nodes name is usually "" (index 0) or a
// hidden-class label. We histogram by name index per type, then resolve the
// hottest indices against the strings table.
const TARGET_TYPES = [1, 2, 3]; // array, string, object
const hist = new Map();          // `${type}:${nameIdx}` -> {count, self}
function bump(type, nameIdx, self) {
  const k = type * 100000000 + nameIdx; // pack; nameIdx < 1e8 in practice
  let e = hist.get(k);
  if (!e) { e = { type, nameIdx, count: 0, self: 0 }; hist.set(k, e); }
  e.count++; e.self += self;
}

await new Promise((resolve, reject) => {
  const rs = fs.createReadStream(file, { encoding: 'latin1', highWaterMark: 1 << 22 });
  let started = false, done = false, cur = 0, haveDigit = false, field = 0;
  let nType = 0, nName = 0, carry = '';
  const targetSet = new Set(TARGET_TYPES);
  rs.on('data', (chunk) => {
    if (done) return;
    let i = 0;
    if (!started) {
      const hay = carry + chunk;
      const m = hay.indexOf('"nodes":[');
      if (m === -1) { carry = hay.slice(-16); return; }
      started = true; i = m + 9 - carry.length; if (i < 0) i = 0;
    }
    const len = chunk.length;
    for (; i < len; i++) {
      const c = chunk.charCodeAt(i);
      if (c >= 48 && c <= 57) { cur = cur * 10 + (c - 48); haveDigit = true; }
      else if (c === 44 || c === 93) {
        if (haveDigit) {
          if (field === TYPE_I) nType = cur;
          else if (field === NAME_I) nName = cur;
          else if (field === SELF_I) { if (targetSet.has(nType)) bump(nType, nName, cur); }
          field++; if (field === NF) field = 0; cur = 0; haveDigit = false;
        }
        if (c === 93) { done = true; rs.destroy(); break; }
      }
    }
  });
  rs.on('close', resolve);
  rs.on('error', (e) => done ? resolve() : reject(e));
});

// top-K name indices per target type (by count) + the union we must resolve
const K = 15;
const perType = new Map(TARGET_TYPES.map(t => [t, []]));
for (const e of hist.values()) perType.get(e.type).push(e);
const need = new Set();
for (const t of TARGET_TYPES) {
  perType.get(t).sort((a, b) => b.count - a.count);
  perType.set(t, perType.get(t).slice(0, K));
  for (const e of perType.get(t)) need.add(e.nameIdx);
}

// --- resolve just the needed indices from the strings table (file tail) ------
console.error(`resolving ${need.size} string indices from the strings table…`);
const maxNeed = Math.max(...need);
const resolved = new Map();
await new Promise((resolve, reject) => {
  const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 22 });
  let inStrings = false, done = false, idx = -1, carry = '';
  let inStr = false, esc = false, cur = '';
  rs.on('data', (chunk) => {
    if (done) return;
    let i = 0;
    if (!inStrings) {
      const hay = carry + chunk;
      const m = hay.indexOf('"strings":[');
      if (m === -1) { carry = hay.slice(-16); return; }
      inStrings = true; i = m + 11 - carry.length; if (i < 0) i = 0;
    }
    const len = chunk.length;
    for (; i < len; i++) {
      const ch = chunk[i];
      if (inStr) {
        if (esc) { cur += ch; esc = false; }
        else if (ch === '\\') { esc = true; }
        else if (ch === '"') {
          inStr = false;
          if (need.has(idx)) { resolved.set(idx, cur); if (resolved.size >= need.size) { done = true; rs.destroy(); break; } }
          cur = '';
        } else cur += ch;
      } else {
        if (ch === '"') { inStr = true; idx++; cur = ''; }
        else if (ch === ']') { done = true; rs.destroy(); break; }
      }
    }
    if (idx > maxNeed && !inStr) { done = true; rs.destroy(); }
  });
  rs.on('close', resolve);
  rs.on('error', (e) => done ? resolve() : reject(e));
});

const label = (i) => {
  const s = resolved.get(i);
  if (s === undefined) return `<#${i}>`;
  return JSON.stringify(s.length > 60 ? s.slice(0, 60) + '…' : s);
};
for (const t of TARGET_TYPES) {
  console.log(`\n=== top '${nodeTypes[t]}' nodes by count (name → count / self) ===`);
  for (const e of perType.get(t)) {
    console.log(`  ${String(e.count).padStart(12)}  ${(e.self/1048576).toFixed(1).padStart(8)} MB  ${label(e.nameIdx)}`);
  }
}
process.exit(0);

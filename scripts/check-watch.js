#!/usr/bin/env node
/**
 * scripts/check-watch.js
 *
 * `node --watch` restarts the process whenever a watched file changes. This
 * server writes files WHILE a call is running — winston log files and .wav
 * recordings — so if those land inside the watched tree, the process restarts
 * itself mid-call and the call drops.
 *
 * This finds the writers:
 *
 *   node scripts/check-watch.js        # snapshot, then report what changed
 *   node scripts/check-watch.js --wait 60
 *
 * Run it, place a test call, and it reports every file under the project that
 * was created or modified in the meantime.
 */

import { readdirSync, statSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const WAIT_S = Number(arg('wait', 45));

const SKIP = new Set(['node_modules', '.git', '.vscode']);

function scan(dir, out = new Map(), depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scan(full, out, depth + 1);
    else {
      try { out.set(full, statSync(full).mtimeMs); } catch { /* vanished */ }
    }
  }
  return out;
}

const C = { reset:'\x1b[0m', red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', dim:'\x1b[2m', bold:'\x1b[1m' };

console.log(`\n${C.bold}Watching ${root} for ${WAIT_S}s${C.reset}`);
console.log(`${C.dim}Start the server and place a test call now.${C.reset}\n`);

const before = scan(root);
console.log(`  ${before.size} files snapshotted`);

await new Promise((r) => setTimeout(r, WAIT_S * 1000));

const after = scan(root);
const changed = [];
for (const [file, mtime] of after) {
  if (!before.has(file)) changed.push([file, 'created']);
  else if (before.get(file) !== mtime) changed.push([file, 'modified']);
}

console.log('');
if (!changed.length) {
  console.log(`${C.green}Nothing under the project changed.${C.reset} Watch-mode restarts are not`);
  console.log('coming from this process writing to its own tree.');
  process.exit(0);
}

console.log(`${C.bold}Files written while running${C.reset}  ${C.dim}(each one can trigger a restart)${C.reset}\n`);
const inSrc = [];
for (const [file, how] of changed) {
  const rel = path.relative(root, file);
  const under = rel.split(path.sep)[0];
  const danger = under === 'src';
  if (danger) inSrc.push(rel);
  console.log(`  ${danger ? C.red + 'IN src/' : C.yellow + 'project'}${C.reset}  ${how.padEnd(8)} ${rel}`);
}

console.log(`\n${C.bold}What to do${C.reset}`);
console.log(`  Limit what is watched so these cannot restart the server:\n`);
console.log(`    ${C.bold}node --watch-path=./src src/index.js${C.reset}\n`);
if (inSrc.length) {
  console.log(`  ${C.red}These are inside src/ and would STILL restart it:${C.reset}`);
  for (const rel of inSrc) console.log(`    ${rel}`);
  console.log(`  Move them out — set CALL_RECORDING_DIR and the winston filename`);
  console.log(`  to a directory outside src/.\n`);
}
console.log(`  ${C.dim}And never run production under --watch: a restart drops live calls.${C.reset}\n`);
#!/usr/bin/env node
/**
 * scripts/fix-abandon-turn.js
 *
 * Repairs _abandonTurn() in src/services/callSession.js.
 *
 * A hand-merged copy kept an old body that (1) forgets the barge-in timer
 * without stopping it, so it fires on the NEXT turn and cuts off its reply,
 * and (2) wipes the caller's half-finished sentence. Merges can also leave the
 * method defined twice, in which case JavaScript silently uses the LAST one.
 *
 *   node scripts/fix-abandon-turn.js          show what is there, change nothing
 *   node scripts/fix-abandon-turn.js --apply  fix it (writes a .bak first)
 */

import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(root, 'src/services/callSession.js');
const APPLY = process.argv.includes('--apply');

const CORRECT = `  _abandonTurn() {
    this.ttsAborted = true;
    this._turnToken++;          // stale synthesis and marks are now rejected
    this._speechQueue = [];
    this._pendingMarks.clear();

    // Only clear the provider's buffer if we had actually started playing something.
    if (this._speakingSince) {
      this._send({ event: 'clear', streamSid: this.streamSid });
    }

    this.speaking = false;
    this.processing = false;
    this._speakingSince = 0;
    this.clearWatchdog();

    // Drop the partial utterance from the transcript log so the call record
    // does not show the caller saying a fragment we then ignored.
    const last = this.turns[this.turns.length - 1];
    if (last?.role === 'user' && last.text === this._activeTranscript) this.turns.pop();
    this._activeTranscript = null;

    // A barge-in or resume check pending on THIS turn must not outlive it.
    // Forgetting the handle without clearing it let the timer fire on the NEXT
    // turn and interrupt a reply that had only just started.
    if (this._bargeInTimer) { clearTimeout(this._bargeInTimer); this._bargeInTimer = null; }
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    this._unconfirmedBargeInAt = 0;

    // Deliberately NOT cleared: _utteranceParts and its timer. Those hold what
    // the caller is saying right now, which is exactly what the next turn needs.
  }`;

/**
 * Index just past the brace that closes the one opening at `open`.
 * Skips strings, template literals and comments, so an apostrophe in a
 * comment ("provider's") or a brace inside a string cannot throw it off.
 */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Every `_abandonTurn() {` method: its span, line, and what is wrong with it. */
function findMethods(src) {
  const out = [];
  const re = /^[ \t]*_abandonTurn\(\)\s*\{/gm;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    const end = matchBrace(src, open);
    if (end < 0) throw new Error('could not find the end of _abandonTurn — file may be malformed');
    const body = src.slice(m.index, end);
    out.push({
      start: m.index,
      end,
      line: src.slice(0, m.index).split('\n').length,
      clearsTimer: /clearTimeout\(this\._bargeInTimer\)/.test(body),
      wipesParts: /this\._utteranceParts\s*=\s*\[\]/.test(body),
      forgetsTimer: /^\s*this\._bargeInTimer\s*=\s*null;/m.test(body.replace(/clearTimeout\(this\._bargeInTimer\);\s*this\._bargeInTimer = null;/g, '')),
    });
  }
  return out;
}

const src = readFileSync(FILE, 'utf8');
const methods = findMethods(src);
const rel = path.relative(root, FILE);

console.log(`\n${rel}\n`);

if (!methods.length) {
  console.log('  _abandonTurn() not found. Is this the right project folder?\n');
  process.exit(1);
}

if (methods.length > 1) {
  console.log(`  _abandonTurn() is defined ${methods.length} times — JavaScript uses the LAST one.`);
}

let broken = 0;
methods.forEach((m, i) => {
  const which = methods.length > 1 ? ` (#${i + 1}${i === methods.length - 1 ? ', the one that runs' : ', unused'})` : '';
  const problems = [];
  if (!m.clearsTimer) problems.push('does not cancel the pending barge-in timer');
  if (m.forgetsTimer) problems.push('forgets the timer handle without stopping it');
  if (m.wipesParts) problems.push("wipes the caller's half-finished sentence");
  const ok = problems.length === 0;
  if (!ok) broken++;
  console.log(`  line ${m.line}${which}: ${ok ? 'OK' : 'BROKEN'}`);
  for (const p of problems) console.log(`      - ${p}`);
});

const needsFix = broken > 0 || methods.length > 1;
if (!needsFix) {
  console.log('\n  Nothing to fix.\n');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n  Run with --apply to fix it. A backup is written first.\n');
  process.exit(1);
}

// Remove every copy, then put the correct one where the first one was.
let out = src;
for (const m of [...methods].reverse()) {
  // Also remove the blank line that preceded a removed duplicate.
  let s = m.start;
  if (m !== methods[0]) while (s > 0 && out[s - 1] === '\n' && out[s - 2] === '\n') s--;
  out = out.slice(0, s) + out.slice(m.end);
}
out = out.slice(0, methods[0].start) + CORRECT + out.slice(methods[0].start);

copyFileSync(FILE, `${FILE}.bak`);
writeFileSync(FILE, out);

const after = findMethods(out);
const good = after.length === 1 && after[0].clearsTimer && !after[0].wipesParts && !after[0].forgetsTimer;
console.log(`\n  ${good ? 'Fixed' : 'FIX DID NOT VERIFY'} — backup at ${rel}.bak`);
console.log(`  _abandonTurn() now at line ${after[0]?.line}, defined ${after.length} time(s).\n`);
console.log('  Next: node scripts/preflight.js\n');
process.exit(good ? 0 : 1);
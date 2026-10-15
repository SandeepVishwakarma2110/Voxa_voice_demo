#!/usr/bin/env node
//
// scripts/fix-lang-fallbacks.js
//
// Finds every place the agent still decides what LANGUAGE to speak by looking
// for Devanagari in the caller's words, and rewrites it to use the reply
// language the session already decided.
//
//   const hindi = /[\u0900-\u097F]/.test(String(transcript))   ← guesses
//   const hindi = this._convLang === 'hi'                      ← uses the decision
//
// Why this exists: the call is in English unless the caller speaks Hindi, and
// the session tracks that in one place. A fallback that sniffs the transcript
// instead will speak Hindi on an English call the moment the recognizer writes
// one word in Devanagari — a name, a number, a stray "हाँ".
//
// Safe by construction:
//   • writes a .bak beside every file it touches
//   • syntax-checks each result as a real ES module
//   • restores the backup and exits non-zero if anything fails to parse
//   • --dry shows what it would do and changes nothing
//
//   node scripts/fix-lang-fallbacks.js --dry
//   node scripts/fix-lang-fallbacks.js
//
// Written because the preflight `lang` stage found an occurrence in a
// hand-merged callSession.js that a hand-applied patch had missed.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// Which expression replaces the sniff, per file. callSession is a class, so it
// has `this`; the others are given the language as an argument.
const TARGETS = [
  { file: 'src/services/callSession.js', replacement: "this._convLang === 'hi'" },
  { file: 'src/services/agentService.js', replacement: "replyLanguage === 'hi'" },
  { file: 'src/agents/companyAgents.js', replacement: "replyLanguage === 'hi'" },
];

// The Devanagari range in either notation: an escaped \u0900-\u097F, or the
// literal characters, which is how an editor or a copy-paste often leaves it.
const DEV_CLASS = '\\[(?:\\\\u0900-\\\\u097F|\u0900-\u097F)\\]';
const SNIFF = new RegExp(`/${DEV_CLASS}/[gimsuy]*\\s*\\.test\\(`, 'g');

/** Walk from an opening paren to its match, respecting strings. */
function matchParen(src, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

/** Is this occurrence inside a comment? Cheap per-line check. */
function inComment(src, idx) {
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const before = src.slice(lineStart, idx);
  return before.includes('//') || /^\s*\*/.test(before);
}

function findSniffs(src) {
  const found = [];
  SNIFF.lastIndex = 0;
  let m;
  while ((m = SNIFF.exec(src))) {
    const start = m.index;
    if (inComment(src, start)) continue;
    const openIdx = start + m[0].length - 1;        // the "(" of .test(
    const closeIdx = matchParen(src, openIdx);
    if (closeIdx === -1) continue;
    found.push({
      start,
      end: closeIdx + 1,
      text: src.slice(start, closeIdx + 1),
      arg: src.slice(openIdx + 1, closeIdx).trim(),
      line: lineOf(src, start),
    });
  }
  return found;
}

/**
 * The `_reprompt` compound, which has to collapse rather than be substituted:
 *
 *   const hindi = (this._turnLang ?? this._callLang) === 'hi'
 *     || (!this._turnLang && !this._callLang && /[…]/.test(lastAgent));
 *
 * A straight substitution would leave the _turnLang branch taking precedence
 * over the call's real language, which is the bug in a different shape.
 */
function collapseRepromptCompound(src) {
  const re = new RegExp(
    'const\\s+hindi\\s*=\\s*\\(this\\._turnLang\\s*\\?\\?\\s*this\\._callLang\\)\\s*===\\s*\'hi\'' +
    '\\s*\\|\\|\\s*\\(!this\\._turnLang\\s*&&\\s*!this\\._callLang\\s*&&\\s*' +
    `/${DEV_CLASS}/[gimsuy]*\\.test\\([^)]*\\)\\s*\\);`,
    'g',
  );
  const replacement =
    "// Collapsed by scripts/fix-lang-fallbacks.js: _convLang is the call's\n" +
    '    // decided language and is always set, so the old "sniff the last agent\n' +
    '    // line for Devanagari" branch could only ever disagree with it.\n' +
    "    const hindi = this._convLang === 'hi';";
  let n = 0;
  const out = src.replace(re, () => { n++; return replacement; });
  return { out, n };
}

function syntaxCheck(file, src) {
  // node --check treats .js as CommonJS, which accepts things a real ES module
  // rejects. Copy to .mjs so the parse matches how the file is actually loaded.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'langfix-')), 'check.mjs');
  fs.writeFileSync(tmp, src);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return (err.stderr?.toString() || err.message).split('\n').slice(0, 6).join('\n');
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

console.log(`\n${C.bold}${C.cyan}Language fallbacks that guess from the transcript${C.reset}`);
if (DRY) console.log(`${C.dim}--dry: nothing will be written${C.reset}`);

let totalFound = 0;
let totalFixed = 0;
let failed = 0;

for (const { file, replacement } of TARGETS) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.log(`\n  ${C.yellow}skip${C.reset}  ${file} ${C.dim}(not found)${C.reset}`);
    continue;
  }

  const original = fs.readFileSync(abs, 'utf8');

  // The compound goes first: a plain substitution inside it would leave the
  // _turnLang branch in charge.
  const { out: afterCompound, n: compoundFixed } = file.endsWith('callSession.js')
    ? collapseRepromptCompound(original)
    : { out: original, n: 0 };

  const sniffs = findSniffs(afterCompound);
  totalFound += sniffs.length + compoundFixed;

  if (!sniffs.length && !compoundFixed) {
    console.log(`\n  ${C.green}clean${C.reset} ${file}`);
    continue;
  }

  console.log(`\n  ${C.bold}${file}${C.reset}`);
  if (compoundFixed) {
    console.log(`    ${C.yellow}compound${C.reset} _reprompt's "(_turnLang ?? _callLang) || sniff" collapsed to _convLang`);
  }

  // Replace back to front so earlier offsets stay valid.
  let patched = afterCompound;
  for (const s of [...sniffs].reverse()) {
    console.log(`    ${C.yellow}line ${s.line}${C.reset}  ${s.text.replace(/\s+/g, ' ').slice(0, 72)}`);
    console.log(`              ${C.dim}->${C.reset} ${C.green}${replacement}${C.reset}   ${C.dim}(was testing ${s.arg})${C.reset}`);
    patched = patched.slice(0, s.start) + replacement + patched.slice(s.end);
  }

  if (DRY) continue;

  const err = syntaxCheck(file, patched);
  if (err) {
    console.log(`\n    ${C.red}REFUSED — the result does not parse, so nothing was written${C.reset}`);
    console.log(`${C.dim}${err}${C.reset}`);
    failed++;
    continue;
  }

  fs.writeFileSync(`${abs}.bak`, original);
  fs.writeFileSync(abs, patched);
  totalFixed += sniffs.length + compoundFixed;
  console.log(`    ${C.green}written${C.reset}  ${C.dim}backup at ${file}.bak${C.reset}`);
}

console.log(`\n${'─'.repeat(60)}`);

if (!totalFound) {
  console.log(`${C.green}${C.bold}Nothing to fix.${C.reset} No fallback guesses the language from the transcript.`);
  process.exit(0);
}

if (DRY) {
  console.log(`${C.yellow}${totalFound} occurrence(s) found.${C.reset} Re-run without --dry to apply.`);
  process.exit(0);
}

if (failed) {
  console.log(`${C.red}${C.bold}${failed} file(s) refused.${C.reset} Nothing was written for those — send me the output.`);
  process.exit(1);
}

console.log(`${C.green}${C.bold}Fixed ${totalFixed} occurrence(s).${C.reset}`);
console.log(`\nNow run:  ${C.bold}node scripts/preflight.js --only=lang,robust${C.reset}`);
console.log(`${C.dim}If anything looks wrong, restore with the .bak files beside each one.${C.reset}`);
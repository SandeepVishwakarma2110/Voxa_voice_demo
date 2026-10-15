#!/usr/bin/env node
/**
 * scripts/verify-files.js
 *
 * Catches the "I pasted the new version onto the end of the old one" mistake
 * before it turns into a confusing SyntaxError several hundred lines down.
 *
 *   node scripts/verify-files.js
 *
 * Checks each file that was replaced for:
 *   - a second shebang, or a second copy of the leading comment
 *   - duplicate top-level export declarations
 *   - a line count wildly different from what was shipped
 *   - whether Node can parse it at all
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import os from 'os';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Line counts as shipped. A file within ~15% is fine (line endings, minor edits);
// roughly double means it was appended rather than replaced.
const EXPECTED = {
  'src/agents/unheardTurns.js': 54,
  'src/agents/bookingGuard.js': 79,
  'scripts/check-google-auth.js': 175,
  'scripts/fix-abandon-turn.js': 157,
  'src/constants/prompts.js': 81,
  'scripts/preflight.js': 998,
  'scripts/fake-call.js': 582,
  'scripts/fix-indexes.js': 174,
  'scripts/fix-duplicates.js': 188,
  'scripts/bench-tts.js': 294,
  'scripts/bench-turn.js': 334,
  'scripts/check-watch.js': 87,
  'src/index.js': 127,
  'src/app.js': 27,
  'src/config/index.js': 92,
  'src/constants/fillers.js': 46,
  'src/models/Log.js': 46,
  'src/tools/calendar.js': 258,
  'src/controllers/callController.js': 79,
  'src/routes/callRoutes.js': 19,
  'src/routes/callRecordingRoutes.js': 155,
  'src/services/agentService.js': 353,
  'src/services/callSession.js': 1509,
  'src/services/speechService.js': 590,
  'src/agents/companyAgents.js': 495,
  'src/agents/sentenceSink.js': 44,
  'src/utils/audioUtils.js': 250,
  'src/utils/speakable.js': 271,
  'src/utils/callRecorder.js': 176,
  'src/websocket/mediaStreamHandler.js': 168,
};

let problems = 0;
const fail = (f, msg) => { problems++; console.log(`  FAIL  ${f}\n        ${msg}`); };
const ok = (f, msg) => console.log(`  PASS  ${f}  ${msg}`);

console.log('Checking replaced files for accidental duplication\n');

for (const [rel, expected] of Object.entries(EXPECTED)) {
  const abs = path.join(root, rel);

  if (!existsSync(abs)) {
    fail(rel, 'file not found — was it copied into place?');
    continue;
  }

  const text = readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/).length - 1;

  // A shebang is only ever legal on line 1. A second one means concatenation.
  const shebangs = [...text.matchAll(/^#!.*$/gm)];
  if (shebangs.length > 1) {
    const at = text.slice(0, shebangs[1].index).split(/\r?\n/).length;
    fail(rel, `two shebangs (second at line ${at}) — the new version was APPENDED to the ` +
      `old one.\n        Delete the file and copy the replacement in fresh.`);
    continue;
  }

  // Same story for duplicate top-level declarations.
  const decls = [...text.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((m) => m[1]);
  const dupes = [...new Set(decls.filter((d, i) => decls.indexOf(d) !== i))];
  if (dupes.length) {
    fail(rel, `declared more than once: ${dupes.join(', ')} — looks like two copies ` +
      `of the file are concatenated.`);
    continue;
  }

  if (lines > expected * 1.6) {
    fail(rel, `${lines} lines, expected about ${expected}. Roughly double means the ` +
      `file was appended to rather than replaced.`);
    continue;
  }

  if (lines < expected * 0.6) {
    fail(rel, `${lines} lines, expected about ${expected}. The copy looks truncated.`);
    continue;
  }

  // `node --check file.js` parses as CommonJS unless package.json says
  // otherwise, and it will happily accept a file with an unclosed function.
  // These are ES modules, so check them as ES modules — copying to .mjs is the
  // reliable way to force that regardless of the project's package.json.
  const tmp = path.join(os.tmpdir(), `verify-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  try {
    writeFileSync(tmp, text);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (err) {
    const msg = String(err.stderr || '').split('\n').find((l) => l.includes('Error')) ?? err.message;
    fail(rel, `not valid as an ES module:\n        ${msg.trim()}`);
    continue;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }

  // A wrong relative import parses fine and only fails at boot, often pointing
  // at a file that exists — just not where this module looks for it.
  const broken = [];
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(abs), m[1]);
    if (!existsSync(target)) broken.push(m[1]);
  }
  if (broken.length) {
    fail(rel, `import path does not resolve: ${broken.join(', ')}\n        ` +
      `the file may exist elsewhere — check the number of ../ segments`);
    continue;
  }

  // A block comment missing its closing */ swallows whatever follows until the
  // next */. The file still parses — the code is simply gone, and only shows up
  // at runtime as "X is not defined". Flag any block comment containing a line
  // that looks like a top-level declaration.
  const swallowed = [];
  for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
    for (const line of m[0].split('\n')) {
      const decl = /^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s+(\w+)/.exec(line);
      if (decl) swallowed.push(decl[1]);
    }
  }
  if (swallowed.length) {
    fail(rel, `code is inside a block comment: ${[...new Set(swallowed)].join(', ')}\n        ` +
      `a missing */ swallowed it — the file parses, but these are gone at runtime`);
    continue;
  }

  ok(rel, `${lines} lines, parses`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Import check
//
// Everything above is static, and static checks keep missing the failure that
// actually bites: a declaration that is simply absent, or swallowed by a
// comment. The file parses, the imports resolve, and it still throws
// "X is not defined" the first time that line runs.
//
// Actually importing each module settles it in one step. It needs node_modules
// and a working .env, so it runs automatically when those are present and is
// skipped otherwise.
// ─────────────────────────────────────────────────────────────────────────────

const canImport = existsSync(path.join(root, 'node_modules')) && !process.argv.includes('--no-import');

if (canImport) {
  console.log('\nImporting each module (catches missing declarations)\n');

  // src/index.js starts the HTTP server and would not exit; app.js is pulled in
  // by it anyway. Everything else is side-effect free at import time.
  const skip = new Set(['src/index.js']);

  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  let importProblems = 0;
  for (const abs of walk(path.join(root, 'src')).sort()) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (skip.has(rel)) continue;
    try {
      await import(pathToFileURL(abs).href);
      console.log(`  PASS  ${rel}`);
    } catch (err) {
      importProblems++;
      problems++;
      console.log(`  FAIL  ${rel}\n        ${String(err.message).split('\n')[0]}`);
    }
  }

  if (importProblems === 0) console.log('\n  every module imports cleanly');
} else if (!existsSync(path.join(root, 'node_modules'))) {
  console.log(`\n${'Skipping the import check — no node_modules here.'}`);
}

console.log('');
if (problems) {
  console.log(`${problems} file(s) need attention. Replace them outright — do not paste ` +
    `on the end of the existing file.`);
  process.exit(1);
}
console.log('All files look intact. Run: node scripts/preflight.js');
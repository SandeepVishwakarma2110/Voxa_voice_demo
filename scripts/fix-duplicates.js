#!/usr/bin/env node
/**
 * scripts/fix-duplicates.js
 *
 * Finds UserProfile documents that share a phoneNumber (including documents
 * with no usable phone number at all) and cleans them up so the unique index
 * can be built.
 *
 *   node scripts/fix-duplicates.js               # inspect only — the default
 *   node scripts/fix-duplicates.js --backup      # also write a JSON backup
 *   node scripts/fix-duplicates.js --merge       # merge real duplicate numbers
 *   node scripts/fix-duplicates.js --purge-keyless   # delete unusable-key docs
 *
 * Nothing is written or deleted without an explicit flag, and every destructive
 * run writes a backup first.
 *
 * Two distinct problems get handled differently:
 *
 *   Real duplicates   — several documents for one genuine phone number. These
 *                       are merged into the richest one, keeping every memory
 *                       entry, so no captured lead is lost.
 *
 *   Keyless documents — phoneNumber null, empty, or absent. These can never be
 *                       matched to a caller, so they are dead weight, but they
 *                       are shown in full before deletion in case they hold a
 *                       lead worth copying out by hand.
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { connectDB } from '../src/utils/db.js';
import { UserProfile } from '../src/models/UserProfile.js';

const argv = process.argv.slice(2);
const MERGE = argv.includes('--merge');
const PURGE = argv.includes('--purge-keyless');
const BACKUP = argv.includes('--backup') || MERGE || PURGE;

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m',
};

const show = (v) =>
  v === null ? 'null' : v === undefined ? '<missing>' : v === '' ? '""' : String(v);

const isUsableKey = (v) => typeof v === 'string' && v.trim() !== '' && v !== 'unknown';

/** How much a document is worth keeping. Higher wins. */
const richness = (d) =>
  (d.name ? 2 : 0) + (d.email ? 2 : 0) + (d.memory?.length ?? 0) + (d.callCount ?? 0);

const describe = (d) => {
  const bits = [];
  if (d.name) bits.push(`name=${d.name}`);
  if (d.email) bits.push(`email=${d.email}`);
  if (d.callCount) bits.push(`calls=${d.callCount}`);
  if (d.memory?.length) bits.push(`memory=[${d.memory.map((m) => m.key).join(',')}]`);
  const when = d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : '?';
  return `${when}  ${bits.length ? bits.join('  ') : C.dim + 'empty' + C.reset}`;
};

await connectDB();

const all = await UserProfile.find({}).lean();
console.log(`\n${C.bold}${all.length} profile document(s) in ${UserProfile.collection.collectionName}${C.reset}`);

// ── Group ────────────────────────────────────────────────────────────────────
const byNumber = new Map();
const keyless = [];

for (const doc of all) {
  if (!isUsableKey(doc.phoneNumber)) { keyless.push(doc); continue; }
  const k = doc.phoneNumber.trim();
  if (!byNumber.has(k)) byNumber.set(k, []);
  byNumber.get(k).push(doc);
}

const dupGroups = [...byNumber.entries()].filter(([, docs]) => docs.length > 1);

// ── Backup ───────────────────────────────────────────────────────────────────
if (BACKUP) {
  const affected = [...dupGroups.flatMap(([, d]) => d), ...keyless];
  if (affected.length) {
    const file = path.resolve(process.cwd(), `userprofiles-backup-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(affected, null, 2));
    console.log(`${C.green}Backed up ${affected.length} document(s) to${C.reset} ${file}`);
  }
}

// ── Keyless documents ────────────────────────────────────────────────────────
console.log(`\n${C.bold}Documents with no usable phoneNumber${C.reset}  ${C.dim}(null, "", or "unknown")${C.reset}`);
if (!keyless.length) {
  console.log(`  ${C.green}none${C.reset}`);
} else {
  console.log(`  ${keyless.length} found. These can never be looked up by a caller, so they are`);
  console.log(`  ${C.dim}why the unique index cannot be built — MongoDB sees them all as the same null.${C.reset}\n`);
  for (const d of keyless.slice(0, 20)) {
    console.log(`    ${String(d._id).slice(-8)}  phoneNumber=${show(d.phoneNumber).padEnd(10)} ${describe(d)}`);
  }
  if (keyless.length > 20) console.log(`    ${C.dim}… and ${keyless.length - 20} more${C.reset}`);

  const withData = keyless.filter((d) => richness(d) > 0);
  if (withData.length) {
    console.log(`\n  ${C.yellow}${withData.length} of them contain captured data.${C.reset} ` +
      `They cannot be attached to a caller without a number —\n  copy anything you want out of the backup file first.`);
  } else {
    console.log(`\n  ${C.green}All of them are empty — nothing is lost by deleting them.${C.reset}`);
  }

  if (PURGE) {
    const res = await UserProfile.deleteMany({ _id: { $in: keyless.map((d) => d._id) } });
    console.log(`\n  ${C.green}deleted ${res.deletedCount} keyless document(s)${C.reset}`);
  } else {
    console.log(`\n  ${C.dim}Re-run with --purge-keyless to delete them (a backup is written first).${C.reset}`);
  }
}

// ── Real duplicates ──────────────────────────────────────────────────────────
console.log(`\n${C.bold}Phone numbers with more than one profile${C.reset}`);
if (!dupGroups.length) {
  console.log(`  ${C.green}none${C.reset}`);
} else {
  for (const [number, docs] of dupGroups) {
    const sorted = [...docs].sort((a, b) => richness(b) - richness(a));
    console.log(`\n  ${C.cyan}${number}${C.reset}  (${docs.length} documents)`);
    sorted.forEach((d, i) => {
      console.log(`    ${i === 0 ? C.green + 'keep  ' + C.reset : C.dim + 'merge ' + C.reset}` +
        `${String(d._id).slice(-8)}  ${describe(d)}`);
    });
  }

  if (MERGE) {
    console.log(`\n${C.bold}Merging${C.reset}`);
    for (const [number, docs] of dupGroups) {
      const sorted = [...docs].sort((a, b) => richness(b) - richness(a));
      const [keeper, ...rest] = sorted;

      // Union the memory arrays, newest write per key wins.
      const merged = new Map();
      for (const d of [...rest].reverse().concat(keeper)) {
        for (const m of d.memory ?? []) {
          if (!m?.key) continue;
          const prev = merged.get(m.key);
          if (!prev || new Date(m.updatedAt ?? 0) >= new Date(prev.updatedAt ?? 0)) merged.set(m.key, m);
        }
      }

      const update = {
        memory: [...merged.values()],
        name: keeper.name ?? rest.find((d) => d.name)?.name ?? null,
        email: keeper.email ?? rest.find((d) => d.email)?.email ?? null,
        callCount: docs.reduce((n, d) => n + (d.callCount ?? 0), 0),
        lastCallAt: docs
          .map((d) => d.lastCallAt)
          .filter(Boolean)
          .sort((a, b) => new Date(b) - new Date(a))[0] ?? null,
      };

      await UserProfile.updateOne({ _id: keeper._id }, { $set: update });
      const res = await UserProfile.deleteMany({ _id: { $in: rest.map((d) => d._id) } });
      console.log(`  ${number}: kept ${String(keeper._id).slice(-8)}, ` +
        `merged ${update.memory.length} memory entr${update.memory.length === 1 ? 'y' : 'ies'}, ` +
        `removed ${res.deletedCount}`);
    }
  } else {
    console.log(`\n  ${C.dim}Re-run with --merge to combine each group into the "keep" document.${C.reset}`);
    console.log(`  ${C.dim}Memory entries from every copy are preserved; nothing captured is lost.${C.reset}`);
  }
}

// ── Next step ────────────────────────────────────────────────────────────────
const remaining = await UserProfile.aggregate([
  { $group: { _id: '$phoneNumber', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]);

console.log('');
if (remaining.length) {
  console.log(`${C.yellow}${remaining.length} duplicate group(s) remain — the unique index still cannot be built.${C.reset}`);
} else {
  console.log(`${C.green}${C.bold}No duplicates left.${C.reset} Now run: node scripts/fix-indexes.js --create-missing`);
}

await mongoose.disconnect();
process.exit(remaining.length ? 1 : 0);

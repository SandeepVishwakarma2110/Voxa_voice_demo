#!/usr/bin/env node
/**
 * scripts/fix-indexes.js
 *
 * Finds indexes on the UserProfile collection that the current schema does not
 * account for, and optionally drops them.
 *
 *   node scripts/fix-indexes.js            # inspect only, changes nothing
 *   node scripts/fix-indexes.js --drop     # drop the stale unique indexes
 *
 * Dry run by default. Nothing is dropped unless you pass --drop.
 *
 * Why this exists: a unique index on a field the schema no longer writes makes
 * MongoDB treat every new document as having that field set to null. A unique
 * index permits exactly one null, so once a single such document exists, every
 * subsequent insert fails with E11000.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/utils/db.js';
import { UserProfile } from '../src/models/UserProfile.js';

const DROP = process.argv.includes('--drop');
const CREATE = process.argv.includes('--create-missing');

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m',
};

await connectDB();

const coll = UserProfile.collection;
const name = coll.collectionName;
const schemaPaths = new Set(Object.keys(UserProfile.schema.paths));

console.log(`\n${C.bold}Collection:${C.reset} ${name}`);
console.log(`${C.dim}Schema fields: ${[...schemaPaths].filter((p) => !p.includes('.')).join(', ')}${C.reset}\n`);

const indexes = await coll.indexes();

const stale = [];
for (const ix of indexes) {
  const fields = Object.keys(ix.key);
  const unknown = fields.filter((f) => !schemaPaths.has(f));
  const isStale = ix.name !== '_id_' && unknown.length > 0;

  const tag = ix.name === '_id_' ? `${C.dim}(primary key)${C.reset}`
    : isStale && ix.unique ? `${C.red}STALE + UNIQUE — this is breaking inserts${C.reset}`
    : isStale ? `${C.yellow}stale (not unique, harmless)${C.reset}`
    : `${C.green}ok${C.reset}`;

  console.log(`  ${ix.name.padEnd(24)} { ${fields.join(', ')} }${ix.unique ? ' unique' : ''}  ${tag}`);
  if (isStale && ix.unique) stale.push(ix);
}

// ── The other direction: indexes the schema declares but the collection lacks.
// A `unique: true` path with no index behind it is not enforcing anything, so
// duplicate profiles for one phone number can quietly accumulate.
const present = new Set(indexes.map((ix) => JSON.stringify(ix.key)));
const missing = UserProfile.schema
  .indexes()
  .map(([key, opts]) => ({ key, opts: opts ?? {} }))
  .filter((d) => !present.has(JSON.stringify(d.key)));

if (missing.length) {
  console.log(`\n${C.bold}Declared in the schema but missing from the collection${C.reset}`);
  for (const d of missing) {
    const fields = Object.keys(d.key).join(', ');
    const tag = d.opts.unique
      ? `${C.red}unique — nothing is preventing duplicates right now${C.reset}`
      : `${C.yellow}missing (performance only)${C.reset}`;
    console.log(`  { ${fields} }  ${tag}`);
  }

  // A unique index build FAILS if duplicates already exist, and Mongoose's
  // background build reports that on an event nobody is listening to — which is
  // one way an index silently goes missing.
  for (const d of missing.filter((x) => x.opts.unique)) {
    const field = Object.keys(d.key)[0];
    const dupes = await UserProfile.aggregate([
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 5 },
    ]);
    if (dupes.length) {
      // Render null / "" / missing explicitly — printing them raw produces
      // "e.g. " with nothing after it, which says nothing useful.
      const show = (v) =>
        v === null ? 'null' : v === undefined ? '<missing>' : v === '' ? '""' : String(v);
      console.log(`  ${C.red}${dupes.length}+ duplicate ${field} value(s) already exist:${C.reset}`);
      for (const d of dupes.slice(0, 5)) {
        console.log(`      ${show(d._id).padEnd(20)} x${d.n}`);
      }
      console.log(`  ${C.dim}The unique index cannot be built until those are merged or removed.${C.reset}`);
      console.log(`  ${C.bold}Inspect and fix them with: node scripts/fix-duplicates.js${C.reset}`);
    } else if (CREATE) {
      try {
        await UserProfile.collection.createIndex(d.key, { ...d.opts, background: true });
        console.log(`  ${C.green}created${C.reset} index on { ${field} }`);
      } catch (err) {
        console.log(`  ${C.red}could not create${C.reset} index on { ${field} }: ${err.message}`);
      }
    } else {
      console.log(`  ${C.dim}Re-run with --create-missing to build it.${C.reset}`);
    }
  }
}

if (!stale.length) {
  console.log(missing.length
    ? `\n${C.green}No stale unique indexes.${C.reset} See the missing-index section above.`
    : `\n${C.green}Indexes match the schema. Nothing to do.${C.reset}`);
  await mongoose.disconnect();
  process.exit(0);
}

// Show how much damage has already been done before touching anything.
console.log(`\n${C.bold}Impact${C.reset}`);
const total = await UserProfile.countDocuments();
console.log(`  ${total} profile document(s) currently exist.`);

for (const ix of stale) {
  const field = Object.keys(ix.key)[0];
  const missing = await UserProfile.countDocuments({ [field]: { $exists: false } });
  console.log(`  ${missing} of them have no "${field}" field.`);
  if (missing >= 1) {
    console.log(`  ${C.red}The single allowed null slot is taken, so EVERY new caller ` +
      `is failing to get a profile right now.${C.reset}`);
  }
}

if (!DROP) {
  console.log(`\n${C.yellow}Dry run — nothing changed.${C.reset}`);
  console.log(`Re-run with ${C.bold}--drop${C.reset} to remove: ${stale.map((i) => i.name).join(', ')}`);
  console.log(`${C.dim}Dropping an index does not touch documents. It is reversible: you can\n` +
    `recreate it later, sparse or partial, if something else needs it.${C.reset}`);
  await mongoose.disconnect();
  process.exit(0);
}

console.log(`\n${C.bold}Dropping${C.reset}`);
let failed = 0;
for (const ix of stale) {
  try {
    await coll.dropIndex(ix.name);
    console.log(`  ${C.green}dropped${C.reset} ${ix.name}`);
  } catch (err) {
    failed++;
    console.log(`  ${C.red}failed${C.reset} ${ix.name}: ${err.message}`);
  }
}

// Prove the fix rather than assuming it: two inserts is the real test, since a
// stale unique index lets the first one through.
console.log(`\n${C.bold}Verifying${C.reset}`);
const probes = [`fixcheck-a-${Date.now()}`, `fixcheck-b-${Date.now()}`];
try {
  for (const p of probes) await UserProfile.create({ phoneNumber: p });
  console.log(`  ${C.green}two consecutive new profiles created successfully${C.reset}`);
} catch (err) {
  failed++;
  console.log(`  ${C.red}still failing: ${err.message}${C.reset}`);
} finally {
  for (const p of probes) await UserProfile.deleteOne({ phoneNumber: p }).catch(() => {});
}

await mongoose.disconnect();

console.log(failed
  ? `\n${C.red}Finished with ${failed} problem(s).${C.reset}`
  : `\n${C.green}${C.bold}Fixed.${C.reset} Re-run: node scripts/preflight.js --only=db`);
process.exit(failed ? 1 : 0);

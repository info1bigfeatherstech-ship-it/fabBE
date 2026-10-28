/**
 * PRODUCTION-SAFE backfill
 * ========================
 * Rename retired ProductTag slugs to current ones. Does NOT touch Product
 * documents, prices, stock, orders, users, or carts.
 *
 * Current mapping:
 *   ganesh-chaturthi-sale  →  festive-offer
 *
 * Also drops any other tag string that is no longer in the ProductTag enum
 * (those values already fail validation and are unused by the app).
 *
 * GUARANTEES:
 * - Writes ONLY: ProductTag.tags
 * - Idempotent — re-run is a no-op once tags are sanitized
 * - Default mode is DRY-RUN (zero writes)
 * - Apply requires BOTH --apply and --confirm-production
 *
 * Usage (from backend folder, with the target .env loaded):
 *
 *   node scripts/backfill-legacy-marketing-tags.js
 *   node scripts/backfill-legacy-marketing-tags.js --apply --confirm-production
 */
require('dotenv').config();
const mongoose = require('mongoose');
const ProductTag = require('../models/ProductTag');
const {
  sanitizeMarketingTags,
  LEGACY_MARKETING_TAG_MAP,
} = require('../utils/productTagQuery');

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    confirmProduction: argv.includes('--confirm-production'),
  };
}

function redactUri(uri) {
  try {
    const normalized = String(uri)
      .replace(/^mongodb\+srv:\/\//i, 'https://')
      .replace(/^mongodb:\/\//i, 'http://');
    const u = new URL(normalized);
    const proto = String(uri).toLowerCase().startsWith('mongodb+srv')
      ? 'mongodb+srv:'
      : 'mongodb:';
    return `${proto}//***@${u.host}${u.pathname || ''}`;
  } catch {
    return '(uri present, could not parse for display)';
  }
}

function sameTagSet(a, b) {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((tag, i) => tag === right[i]);
}

async function main() {
  const { apply, confirmProduction } = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_DB_URI;
  if (!uri) {
    throw new Error('MONGO_DB_URI is required in .env');
  }

  if (apply && !confirmProduction) {
    throw new Error(
      [
        'Refusing to write to the database.',
        'Dry-run is the default. To apply you MUST pass BOTH flags:',
        '',
        '  node scripts/backfill-legacy-marketing-tags.js --apply --confirm-production',
        '',
      ].join('\n')
    );
  }

  const dbName = process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME || undefined;
  await mongoose.connect(uri, dbName ? { dbName } : undefined);
  const db = mongoose.connection.db;

  const legacySlugs = Object.keys(LEGACY_MARKETING_TAG_MAP);
  console.log('============================================================');
  console.log('[tag-backfill] legacy ProductTag slugs → current enum');
  console.log('============================================================');
  console.log('[tag-backfill] uri:     ', redactUri(uri));
  console.log('[tag-backfill] database:', db.databaseName);
  console.log('[tag-backfill] mode:    ', apply ? 'APPLY (writes ProductTag.tags only)' : 'DRY-RUN (no writes)');
  console.log('[tag-backfill] map:     ', JSON.stringify(LEGACY_MARKETING_TAG_MAP));
  console.log('[tag-backfill] never:   ', 'products, prices, stock, orders, users, carts');

  const docs = await ProductTag.find({
    tags: { $elemMatch: { $nin: ['on-sale', 'today-arrival', 'jewellery-spotted', 'bestselling-jewelry', 'festive-offer'] } },
  })
    .select('product tags')
    .lean();

  let wouldUpdate = 0;
  let alreadyClean = 0;
  let updated = 0;
  const samples = [];

  for (const doc of docs) {
    const current = Array.isArray(doc.tags) ? doc.tags : [];
    const next = sanitizeMarketingTags(current);
    if (sameTagSet(current, next)) {
      alreadyClean += 1;
      continue;
    }
    wouldUpdate += 1;
    if (samples.length < 8) {
      samples.push({
        product: String(doc.product),
        before: current,
        after: next,
      });
    }
    if (!apply) continue;
    await ProductTag.updateOne(
      { _id: doc._id },
      { $set: { tags: next } },
      { runValidators: true }
    );
    updated += 1;
  }

  console.log('[tag-backfill] docs with non-enum tags:', docs.length);
  console.log('[tag-backfill] already clean:         ', alreadyClean);
  console.log('[tag-backfill] would update:          ', wouldUpdate);
  if (apply) console.log('[tag-backfill] updated:              ', updated);
  if (samples.length) {
    console.log('[tag-backfill] sample:');
    for (const row of samples) console.log('  ', JSON.stringify(row));
  } else {
    console.log('[tag-backfill] no legacy/unknown tags found');
  }
  console.log('[tag-backfill] legacy slugs scanned:  ', legacySlugs.join(', '));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  return mongoose.disconnect().catch(() => {});
});

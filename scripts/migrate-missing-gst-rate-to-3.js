/**
 * PRODUCTION-SAFE migration
 * =========================
 * Sets product-level `gstRate` to 3 ONLY where GST was never filled.
 *
 * GUARANTEES:
 * - Writes ONLY the path: gstRate
 * - Updates ONLY documents where gstRate is missing or null
 * - Does NOT overwrite an existing numeric gstRate (0, 5, 12, 18, …)
 * - Does NOT touch: variants, price, inventory, images, status, HSN, orders, users, carts
 * - Idempotent — safe to re-run
 * - Default mode is DRY-RUN (zero writes)
 *
 * Usage (on the server, from backend folder with PRODUCTION .env loaded):
 *
 *   # 1) Dry-run — inspect DB name + counts (NO writes)
 *   node scripts/migrate-missing-gst-rate-to-3.js
 *
 *   # 2) Apply — requires BOTH flags (intentional double confirm)
 *   node scripts/migrate-missing-gst-rate-to-3.js --apply --confirm-production
 *
 * Optional env:
 *   MONGO_DB_URI                     (required)
 *   MONGODB_DB_NAME / MONGO_DB_NAME  (optional explicit db name)
 *   GST_RATE_TARGET                 (optional; default 3)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DEFAULT_TARGET = 3;

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    confirmProduction: argv.includes('--confirm-production'),
  };
}

function resolveTargetRate() {
  const raw = process.env.GST_RATE_TARGET;
  if (raw == null || String(raw).trim() === '') return DEFAULT_TARGET;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`GST_RATE_TARGET must be a number 0–100 (got ${raw})`);
  }
  return n;
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

/** Products that never had GST filled (missing field or null only). */
function missingGstFilter() {
  return {
    $or: [{ gstRate: { $exists: false } }, { gstRate: null }],
  };
}

async function countMissing(products) {
  return products.countDocuments(missingGstFilter());
}

async function countWithNumericGst(products) {
  return products.countDocuments({ gstRate: { $type: 'number' } });
}

async function sampleMissing(products, limit = 10) {
  return products
    .find(missingGstFilter())
    .project({
      slug: 1,
      name: 1,
      status: 1,
      hsnCode: 1,
      gstRate: 1,
      'variants.0.productCode': 1,
      'variants.0.sku': 1,
      'variants.0.price': 1,
      'variants.0.inventory.quantity': 1,
    })
    .limit(limit)
    .toArray();
}

function fingerprintSample(doc) {
  const v0 = Array.isArray(doc.variants) ? doc.variants[0] : null;
  return {
    name: doc.name ?? null,
    status: doc.status ?? null,
    hsnCode: doc.hsnCode ?? null,
    variantCountHint: Array.isArray(doc.variants) ? doc.variants.length : 0,
    v0ProductCode: v0?.productCode ?? null,
    v0Sku: v0?.sku ?? null,
    v0Price: v0?.price ?? null,
    v0Qty: v0?.inventory?.quantity ?? null,
  };
}

async function main() {
  const { apply, confirmProduction } = parseArgs(process.argv.slice(2));
  const targetRate = resolveTargetRate();
  const uri = process.env.MONGO_DB_URI;
  if (!uri) {
    throw new Error('MONGO_DB_URI is required in .env (use the PRODUCTION URI on the server)');
  }

  if (apply && !confirmProduction) {
    throw new Error(
      [
        'Refusing to write to the database.',
        'Dry-run is the default. To apply on production you MUST pass BOTH flags:',
        '',
        '  node scripts/migrate-missing-gst-rate-to-3.js --apply --confirm-production',
        '',
      ].join('\n')
    );
  }

  const dbName = process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME || undefined;
  await mongoose.connect(uri, dbName ? { dbName } : undefined);

  const db = mongoose.connection.db;
  const products = db.collection('products');

  console.log('============================================================');
  console.log(`[migrate-gst] PRODUCTION-SAFE missing gstRate → ${targetRate}`);
  console.log('============================================================');
  console.log('[migrate-gst] uri:     ', redactUri(uri));
  console.log('[migrate-gst] database:', db.databaseName);
  console.log('[migrate-gst] mode:    ', apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)');
  console.log('[migrate-gst] scope:   ', 'products.gstRate ONLY (missing/null → set)');
  console.log('[migrate-gst] never:   ', 'orders, users, carts, variants, price, inventory, images, hsnCode, status');
  console.log('[migrate-gst] skip:    ', 'products that already have a numeric gstRate');

  const totalProducts = await products.countDocuments({});
  const alreadySet = await countWithNumericGst(products);
  const needingUpdate = await countMissing(products);
  const sample = await sampleMissing(products, 10);

  const rateBreakdown = await products
    .aggregate([
      { $match: { gstRate: { $type: 'number' } } },
      { $group: { _id: '$gstRate', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  console.log('[migrate-gst] products total:           ', totalProducts);
  console.log('[migrate-gst] already have numeric GST: ', alreadySet);
  console.log('[migrate-gst] missing GST (will update):', needingUpdate);
  if (rateBreakdown.length) {
    console.log('[migrate-gst] existing GST breakdown (untouched):');
    for (const row of rateBreakdown) {
      console.log(`  - ${row._id}% → ${row.count} product(s)`);
    }
  }

  const beforeById = new Map();
  if (sample.length) {
    console.log('[migrate-gst] sample (other fields must stay identical after apply):');
    for (const row of sample) {
      beforeById.set(String(row._id), fingerprintSample(row));
      const code = row.variants?.[0]?.productCode || row.variants?.[0]?.sku || '—';
      console.log(
        `  - ${row.slug || row._id} [${code}] gstRate=${row.gstRate ?? 'missing'} status=${row.status ?? '—'} hsn=${row.hsnCode || '—'}`
      );
    }
  } else {
    console.log('[migrate-gst] nothing to change — every product already has a numeric gstRate');
  }

  if (!apply) {
    console.log('------------------------------------------------------------');
    console.log('[migrate-gst] DRY-RUN complete. No documents were modified.');
    console.log('[migrate-gst] If database name + counts look correct, run:');
    console.log(
      `[migrate-gst]   node scripts/migrate-missing-gst-rate-to-3.js --apply --confirm-production`
    );
    console.log('------------------------------------------------------------');
    await mongoose.disconnect();
    return;
  }

  if (needingUpdate === 0) {
    console.log('[migrate-gst] APPLY skipped — already fully migrated.');
    await mongoose.disconnect();
    return;
  }

  /**
   * CRITICAL UPDATE:
   * $set only gstRate on documents that still have missing/null gstRate.
   * Never uses $unset / replaceOne / bulkReplace.
   */
  const result = await products.updateMany(missingGstFilter(), {
    $set: { gstRate: targetRate },
  });

  console.log('[migrate-gst] updateMany matched:', result.matchedCount);
  console.log('[migrate-gst] updateMany modified:', result.modifiedCount);

  const remaining = await countMissing(products);

  const sampleIds = sample.map((r) => r._id);
  const afterDocs = sampleIds.length
    ? await products
        .find({ _id: { $in: sampleIds } })
        .project({
          slug: 1,
          name: 1,
          status: 1,
          hsnCode: 1,
          gstRate: 1,
          'variants.0.productCode': 1,
          'variants.0.sku': 1,
          'variants.0.price': 1,
          'variants.0.inventory.quantity': 1,
        })
        .toArray()
    : [];

  let fieldMismatch = 0;
  let gstMismatch = 0;
  console.log('[migrate-gst] post-apply spot-check:');
  for (const p of afterDocs) {
    const id = String(p._id);
    const before = beforeById.get(id);
    const after = fingerprintSample(p);
    const gstOk = p.gstRate === targetRate;
    let thisFieldMismatch = 0;

    if (!gstOk) {
      gstMismatch += 1;
      console.error(`  ! GST NOT SET ${p.slug || p._id} gstRate=${p.gstRate}`);
    }

    if (before) {
      for (const k of Object.keys(before)) {
        const b = JSON.stringify(before[k]);
        const a = JSON.stringify(after[k]);
        if (b !== a) {
          thisFieldMismatch += 1;
          fieldMismatch += 1;
          console.error(`  ! FIELD CHANGED ${p.slug || p._id} ${k}: before=${b} after=${a}`);
        }
      }
    }

    if (gstOk && thisFieldMismatch === 0) {
      console.log(
        `  - ${p.slug || p._id} gstRate=${p.gstRate} status=${p.status ?? '—'} hsn=${p.hsnCode || '—'} (other fields unchanged)`
      );
    }
  }

  console.log('------------------------------------------------------------');
  console.log('[migrate-gst] remaining missing gstRate:', remaining);
  console.log('[migrate-gst] sample GST mismatches:    ', gstMismatch);
  console.log('[migrate-gst] sample other-field diffs: ', fieldMismatch);

  if (remaining > 0 || gstMismatch > 0 || fieldMismatch > 0) {
    console.error('[migrate-gst] WARNING — review required before treating migration as complete');
    process.exitCode = 2;
  } else {
    console.log(
      `[migrate-gst] OK — missing GST filled to ${targetRate}%; existing rates and other fields preserved in sample`
    );
  }
  console.log('============================================================');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[migrate-gst] FAILED:', err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

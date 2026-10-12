/**
 * PRODUCTION-SAFE migration
 * =========================
 * Sets every product variant's `inventory.lowStockThreshold` to 0.
 *
 * GUARANTEES:
 * - Writes ONLY the path: variants.$[v].inventory.lowStockThreshold
 * - Does NOT touch: quantity, price, images, status, SKU, orders, users, carts
 * - Does NOT replace the inventory object (quantity / trackInventory stay as-is)
 * - Idempotent — safe to re-run
 * - Default mode is DRY-RUN (zero writes)
 *
 * Usage (on the server, from backend folder with PRODUCTION .env loaded):
 *
 *   # 1) Dry-run — inspect DB name + counts (NO writes)
 *   node scripts/migrate-low-stock-threshold-to-zero.js
 *
 *   # 2) Apply — requires BOTH flags (intentional double confirm)
 *   node scripts/migrate-low-stock-threshold-to-zero.js --apply --confirm-production
 *
 * Optional env:
 *   MONGO_DB_URI          (required)
 *   MONGODB_DB_NAME / MONGO_DB_NAME  (optional explicit db name)
 */
require('dotenv').config();
const mongoose = require('mongoose');

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

async function countVariantsNeedingUpdate(products) {
  const agg = await products
    .aggregate([
      { $unwind: '$variants' },
      {
        $match: {
          'variants.inventory': { $type: 'object' },
          $or: [
            { 'variants.inventory.lowStockThreshold': { $exists: false } },
            { 'variants.inventory.lowStockThreshold': null },
            { 'variants.inventory.lowStockThreshold': { $ne: 0 } },
          ],
        },
      },
      { $count: 'n' },
    ])
    .toArray();
  return agg[0]?.n || 0;
}

async function sampleVariantsNeedingUpdate(products, limit = 10) {
  return products
    .aggregate([
      { $unwind: '$variants' },
      {
        $match: {
          'variants.inventory': { $type: 'object' },
          $or: [
            { 'variants.inventory.lowStockThreshold': { $exists: false } },
            { 'variants.inventory.lowStockThreshold': null },
            { 'variants.inventory.lowStockThreshold': { $ne: 0 } },
          ],
        },
      },
      {
        $project: {
          slug: 1,
          productCode: '$variants.productCode',
          quantity: '$variants.inventory.quantity',
          trackInventory: '$variants.inventory.trackInventory',
          lowStockThreshold: '$variants.inventory.lowStockThreshold',
        },
      },
      { $limit: limit },
    ])
    .toArray();
}

async function main() {
  const { apply, confirmProduction } = parseArgs(process.argv.slice(2));
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
        '  node scripts/migrate-low-stock-threshold-to-zero.js --apply --confirm-production',
        '',
      ].join('\n')
    );
  }

  const dbName = process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME || undefined;
  await mongoose.connect(uri, dbName ? { dbName } : undefined);

  const db = mongoose.connection.db;
  const products = db.collection('products');

  console.log('============================================================');
  console.log('[migrate-low-stock] PRODUCTION-SAFE lowStockThreshold → 0');
  console.log('============================================================');
  console.log('[migrate-low-stock] uri:     ', redactUri(uri));
  console.log('[migrate-low-stock] database:', db.databaseName);
  console.log('[migrate-low-stock] mode:    ', apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)');
  console.log('[migrate-low-stock] scope:   ', 'products.variants.inventory.lowStockThreshold ONLY');
  console.log('[migrate-low-stock] never:   ', 'orders, users, carts, quantity, price, images');

  const totalProducts = await products.countDocuments({});
  const withVariants = await products.countDocuments({ 'variants.0': { $exists: true } });
  const variantsNeedingUpdate = await countVariantsNeedingUpdate(products);
  const sample = await sampleVariantsNeedingUpdate(products, 10);

  console.log('[migrate-low-stock] products total:              ', totalProducts);
  console.log('[migrate-low-stock] products with variants:      ', withVariants);
  console.log('[migrate-low-stock] variants needing threshold→0:', variantsNeedingUpdate);

  if (sample.length) {
    console.log('[migrate-low-stock] sample (qty must stay same after apply):');
    for (const row of sample) {
      console.log(
        `  - ${row.slug || row._id} [${row.productCode || '—'}] qty=${row.quantity ?? '—'} track=${row.trackInventory ?? '—'} threshold=${row.lowStockThreshold ?? 'missing'}`
      );
    }
  } else {
    console.log('[migrate-low-stock] nothing to change — all thresholds already 0 (or no inventory objects)');
  }

  if (!apply) {
    console.log('------------------------------------------------------------');
    console.log('[migrate-low-stock] DRY-RUN complete. No documents were modified.');
    console.log('[migrate-low-stock] If database name + counts look correct, run:');
    console.log('[migrate-low-stock]   node scripts/migrate-low-stock-threshold-to-zero.js --apply --confirm-production');
    console.log('------------------------------------------------------------');
    await mongoose.disconnect();
    return;
  }

  if (variantsNeedingUpdate === 0) {
    console.log('[migrate-low-stock] APPLY skipped — already fully migrated.');
    await mongoose.disconnect();
    return;
  }

  // Snapshot quantities for the sample BEFORE write (integrity check after).
  const beforeByKey = new Map();
  for (const row of sample) {
    const key = `${String(row._id)}::${String(row.productCode || '')}`;
    beforeByKey.set(key, row.quantity);
  }

  /**
   * CRITICAL UPDATE:
   * $set only variants.$[v].inventory.lowStockThreshold
   * arrayFilters ensure we never rewrite the whole inventory object.
   */
  const result = await products.updateMany(
    {
      variants: {
        $elemMatch: {
          inventory: { $type: 'object' },
          $or: [
            { 'inventory.lowStockThreshold': { $exists: false } },
            { 'inventory.lowStockThreshold': null },
            { 'inventory.lowStockThreshold': { $ne: 0 } },
          ],
        },
      },
    },
    { $set: { 'variants.$[v].inventory.lowStockThreshold': 0 } },
    {
      arrayFilters: [
        {
          'v.inventory': { $type: 'object' },
          $or: [
            { 'v.inventory.lowStockThreshold': { $exists: false } },
            { 'v.inventory.lowStockThreshold': null },
            { 'v.inventory.lowStockThreshold': { $ne: 0 } },
          ],
        },
      ],
    }
  );

  console.log('[migrate-low-stock] updateMany matched:', result.matchedCount);
  console.log('[migrate-low-stock] updateMany modified:', result.modifiedCount);

  const remaining = await countVariantsNeedingUpdate(products);

  // Re-read sample products and verify quantity unchanged + threshold 0
  const sampleIds = [...new Set(sample.map((r) => r._id))];
  const afterDocs = sampleIds.length
    ? await products
        .find({ _id: { $in: sampleIds } })
        .project({
          slug: 1,
          'variants.productCode': 1,
          'variants.inventory.quantity': 1,
          'variants.inventory.trackInventory': 1,
          'variants.inventory.lowStockThreshold': 1,
        })
        .toArray()
    : [];

  let qtyMismatch = 0;
  console.log('[migrate-low-stock] post-apply spot-check:');
  for (const p of afterDocs) {
    for (const v of p.variants || []) {
      const key = `${String(p._id)}::${String(v.productCode || '')}`;
      const beforeQty = beforeByKey.has(key) ? beforeByKey.get(key) : undefined;
      const afterQty = v.inventory?.quantity;
      const thr = v.inventory?.lowStockThreshold;
      if (beforeQty !== undefined && beforeQty !== afterQty) {
        qtyMismatch += 1;
        console.error(
          `  ! QTY CHANGED ${p.slug || p._id} [${v.productCode || '—'}] before=${beforeQty} after=${afterQty}`
        );
      } else {
        console.log(
          `  - ${p.slug || p._id} [${v.productCode || '—'}] qty=${afterQty ?? '—'} track=${v.inventory?.trackInventory ?? '—'} threshold=${thr}`
        );
      }
    }
  }

  console.log('------------------------------------------------------------');
  console.log('[migrate-low-stock] remaining variants ≠ 0:', remaining);
  console.log('[migrate-low-stock] quantity mismatches in sample:', qtyMismatch);

  if (remaining > 0 || qtyMismatch > 0) {
    console.error('[migrate-low-stock] WARNING — review required before continuing deploy checks');
    process.exitCode = 2;
  } else {
    console.log('[migrate-low-stock] OK — all applicable thresholds are 0; quantities preserved in sample');
  }
  console.log('============================================================');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[migrate-low-stock] FAILED:', err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

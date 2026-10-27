/**
 * PRODUCTION-SAFE backfill
 * ========================
 * For every product tagged `on-sale`, set each variant's `price.promo`
 * to 20% off that variant's current `price.sale` (nearest rupee).
 *
 * GUARANTEES:
 * - Writes ONLY: variants.$[v].price.promo
 * - Does NOT touch: price.base, price.sale, wholesale prices, inventory,
 *   images, status, SKU, orders, users, carts
 * - Idempotent — re-run sets the same promo from current sale
 * - Default mode is DRY-RUN (zero writes)
 * - Fractional results are Math.round()'d to a whole rupee
 *
 * Formula:
 *   promo = round(sale × 0.8)   // 20% extra off the existing sale
 *   Example: base 120, sale 100 → promo 80
 *
 * Usage (from backend folder, with the target .env loaded):
 *
 *   # 1) Dry-run — inspect DB + sample rows (NO writes)
 *   node scripts/backfill-on-sale-promo-price.js
 *
 *   # 2) Apply — requires BOTH flags
 *   node scripts/backfill-on-sale-promo-price.js --apply --confirm-production
 *
 * After apply, catalog cache is invalidated so PDP/listing pick up promo.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductTag = require('../models/ProductTag');
const { ON_SALE_TAG } = require('../utils/productTagQuery');
const { computePromoFromSale, isSaleValid } = require('../utils/variantPrice');

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

function planVariantPromo(product, variant) {
  const base = Number(variant?.price?.base);
  const sale = variant?.price?.sale != null ? Number(variant.price.sale) : null;
  const existingPromo =
    variant?.price?.promo != null ? Number(variant.price.promo) : null;

  if (!isSaleValid(base, sale)) {
    return { action: 'skip-no-sale', product, variant, base, sale, existingPromo, promo: null };
  }

  const promo = computePromoFromSale(sale);
  if (promo == null || promo <= 0 || promo >= sale || promo >= base) {
    return { action: 'skip-invalid-promo', product, variant, base, sale, existingPromo, promo };
  }

  if (existingPromo === promo) {
    return { action: 'already-set', product, variant, base, sale, existingPromo, promo };
  }

  return { action: 'update', product, variant, base, sale, existingPromo, promo };
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
        '  node scripts/backfill-on-sale-promo-price.js --apply --confirm-production',
        '',
      ].join('\n')
    );
  }

  const dbName = process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME || undefined;
  await mongoose.connect(uri, dbName ? { dbName } : undefined);

  const db = mongoose.connection.db;

  console.log('============================================================');
  console.log('[promo-backfill] 20% off sale → variants.price.promo');
  console.log('============================================================');
  console.log('[promo-backfill] uri:     ', redactUri(uri));
  console.log('[promo-backfill] database:', db.databaseName);
  console.log('[promo-backfill] mode:    ', apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes)');
  console.log('[promo-backfill] scope:   ', 'on-sale products, variants.price.promo ONLY');
  console.log('[promo-backfill] never:   ', 'base, sale, wholesale, inventory, orders, carts');

  const tagDocs = await ProductTag.find({ tags: ON_SALE_TAG })
    .select('product tags')
    .lean();
  const productIds = [];
  const seen = new Set();
  for (const doc of tagDocs) {
    if (!doc?.product) continue;
    const key = String(doc.product);
    if (seen.has(key)) continue;
    seen.add(key);
    productIds.push(doc.product);
  }

  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } })
        .select('slug name variants._id variants.sku variants.productCode variants.price')
        .lean()
    : [];

  const plans = [];
  for (const product of products) {
    for (const variant of product.variants || []) {
      plans.push(planVariantPromo(product, variant));
    }
  }

  const counts = plans.reduce((acc, row) => {
    acc[row.action] = (acc[row.action] || 0) + 1;
    return acc;
  }, {});
  const updates = plans.filter((row) => row.action === 'update');
  const sample = updates.slice(0, 12);

  console.log('[promo-backfill] on-sale tag docs:         ', tagDocs.length);
  console.log('[promo-backfill] on-sale products found:   ', products.length);
  console.log('[promo-backfill] variants planned update:  ', updates.length);
  console.log('[promo-backfill] already at 20% off sale:  ', counts['already-set'] || 0);
  console.log('[promo-backfill] skipped (no valid sale):  ', counts['skip-no-sale'] || 0);
  console.log('[promo-backfill] skipped (invalid promo):  ', counts['skip-invalid-promo'] || 0);

  if (sample.length) {
    console.log('[promo-backfill] sample (base / sale → promo):');
    for (const row of sample) {
      console.log(
        `  - ${row.product.slug || row.product._id} [${row.variant.productCode || row.variant.sku || '—'}] ` +
          `${row.base} / ${row.sale} → ${row.promo}` +
          (row.existingPromo != null ? ` (was promo ${row.existingPromo})` : '')
      );
    }
  } else {
    console.log('[promo-backfill] nothing to change');
  }

  if (!apply) {
    console.log('------------------------------------------------------------');
    console.log('[promo-backfill] DRY-RUN complete. No documents were modified.');
    console.log('[promo-backfill] If database name + counts look correct, run:');
    console.log('[promo-backfill]   node scripts/backfill-on-sale-promo-price.js --apply --confirm-production');
    console.log('------------------------------------------------------------');
    await mongoose.disconnect();
    return;
  }

  if (!updates.length) {
    console.log('[promo-backfill] APPLY skipped — already fully migrated.');
    await mongoose.disconnect();
    return;
  }

  const backupDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(
    backupDir,
    `on-sale-promo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  const backupRows = updates.map((row) => ({
    productId: String(row.product._id),
    slug: row.product.slug,
    variantId: String(row.variant._id),
    sku: row.variant.sku || null,
    productCode: row.variant.productCode || null,
    base: row.base,
    sale: row.sale,
    promoBefore: row.existingPromo,
    promoAfter: row.promo,
  }));
  fs.writeFileSync(backupPath, JSON.stringify(backupRows, null, 2), 'utf8');
  console.log('[promo-backfill] backup written:          ', backupPath);

  const ops = updates.map((row) => ({
    updateOne: {
      filter: { _id: row.product._id },
      update: { $set: { 'variants.$[v].price.promo': row.promo } },
      arrayFilters: [{ 'v._id': row.variant._id }],
    },
  }));

  const CHUNK = 200;
  let modified = 0;
  let matched = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const chunk = ops.slice(i, i + CHUNK);
    const result = await Product.bulkWrite(chunk, { ordered: false });
    matched += result.matchedCount || 0;
    modified += result.modifiedCount || 0;
  }

  console.log('[promo-backfill] bulkWrite matched:       ', matched);
  console.log('[promo-backfill] bulkWrite modified:      ', modified);

  try {
    const cacheInvalidation = require('../services/cacheInvalidation.service');
    const count = await cacheInvalidation.onProductTagChange(
      updates.map((row) => row.product._id)
    );
    console.log('[promo-backfill] catalog cache invalidated:', count);
  } catch (err) {
    console.warn(
      '[promo-backfill] cache invalidation failed (prices are in DB; restart/TTL will pick them up):',
      err?.message || err
    );
  }

  const remaining = [];
  const after = await Product.find({ _id: { $in: updates.map((r) => r.product._id) } })
    .select('variants._id variants.price.promo')
    .lean();
  const afterPromo = new Map();
  for (const p of after) {
    for (const v of p.variants || []) {
      afterPromo.set(`${String(p._id)}::${String(v._id)}`, v.price?.promo);
    }
  }
  for (const row of updates) {
    const got = afterPromo.get(`${String(row.product._id)}::${String(row.variant._id)}`);
    if (Number(got) !== Number(row.promo)) remaining.push(row);
  }

  console.log('------------------------------------------------------------');
  console.log('[promo-backfill] variants not at expected promo:', remaining.length);
  if (remaining.length) {
    for (const row of remaining.slice(0, 10)) {
      console.error(
        `  ! ${row.product.slug} [${row.variant.productCode || '—'}] expected ${row.promo}`
      );
    }
    process.exitCode = 2;
  } else {
    console.log('[promo-backfill] OK — promo set; base/sale untouched');
  }
  console.log('============================================================');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[promo-backfill] FAILED:', err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

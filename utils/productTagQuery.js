const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductTag = require('../models/ProductTag');
const { mongoCatalogAnd } = require('./storefrontCatalog');

/** Marketing / listing tags stored on ProductTag documents. */
const MARKETING_TAG_SLUGS = Object.freeze([
  'on-sale',
  'today-arrival',
  'jewellery-spotted',
  'bestselling-jewelry',
  'festive-offer',
]);

/**
 * Old ProductTag slugs renamed when festive became a dynamic label.
 * Values are current MARKETING_TAG_SLUGS. Mapping is additive (no product data loss).
 */
const LEGACY_MARKETING_TAG_MAP = Object.freeze({
  'ganesh-chaturthi-sale': 'festive-offer',
});

/**
 * Map legacy slugs, drop unknown values, de-dupe.
 * Used on read + write so Mongoose enum never sees retired slugs.
 * @param {unknown} rawTags
 * @returns {string[]}
 */
function sanitizeMarketingTags(rawTags = []) {
  try {
    const list = Array.isArray(rawTags) ? rawTags : [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const slug = String(raw || '').trim().replace(/_/g, '-').toLowerCase();
      if (!slug) continue;
      const mapped = LEGACY_MARKETING_TAG_MAP[slug] || slug;
      if (!MARKETING_TAG_SLUGS.includes(mapped) || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(mapped);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * When querying a current slug, also match its legacy aliases still sitting in Mongo.
 * @param {string|string[]|null|undefined} tagSlugs
 * @returns {string[]}
 */
function expandTagSlugsForQuery(tagSlugs = []) {
  const normalized = sanitizeMarketingTags(
    Array.isArray(tagSlugs) ? tagSlugs : normalizeTagSlugs(tagSlugs)
  );
  const out = new Set(normalized);
  for (const [legacy, current] of Object.entries(LEGACY_MARKETING_TAG_MAP)) {
    if (out.has(current)) out.add(legacy);
  }
  return [...out];
}

/**
 * Normalize tag slugs from query strings or admin payloads.
 * @param {string|string[]|null|undefined} raw
 * @returns {string[]}
 */
function normalizeTagSlugs(raw) {
  if (!raw) return [];

  const parts = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

  const seen = new Set();
  const out = [];

  for (const part of parts) {
    const slug = String(part).trim().replace(/_/g, '-').toLowerCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }

  return out;
}

/**
 * Parse admin `tags` query for catalog listing.
 * Unknown slugs are dropped. Empty / omitted query → no tag filter.
 *
 * @param {string|string[]|null|undefined} raw
 * @returns {{ active: boolean, slugs: string[] }}
 */
function resolveAdminMarketingTagFilter(raw) {
  try {
    if (raw == null) return { active: false, slugs: [] };
    const joined = Array.isArray(raw) ? raw.join(',') : String(raw);
    if (!String(joined).trim()) return { active: false, slugs: [] };
    const slugs = sanitizeMarketingTags(normalizeTagSlugs(joined));
    return { active: true, slugs };
  } catch {
    return { active: false, slugs: [] };
  }
}

/**
 * Product ids that have at least one of the requested tags (ProductTag collection).
 * @param {string[]} tagSlugs
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
async function getProductIdsByTags(tagSlugs = []) {
  const normalized = expandTagSlugsForQuery(tagSlugs);
  if (!normalized.length) return [];

  const tagDocs = await ProductTag.find({ tags: { $in: normalized } })
    .select('product')
    .lean();

  const ids = [];
  const seen = new Set();

  for (const doc of tagDocs) {
    if (!doc?.product) continue;
    const key = String(doc.product);
    if (seen.has(key)) continue;
    seen.add(key);
    if (mongoose.Types.ObjectId.isValid(key)) {
      ids.push(doc.product);
    }
  }

  return ids;
}

/**
 * Live storefront-visible product ids for the given marketing tags.
 * Applies the same catalog filters as public product list APIs.
 * @param {string[]} tagSlugs
 * @param {'ecomm'|'wholesale'} storefront
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
async function getLiveProductIdsByTags(tagSlugs = [], storefront = 'ecomm') {
  const taggedIds = await getProductIdsByTags(tagSlugs);
  if (!taggedIds.length) return [];

  const liveProducts = await Product.find(
    mongoCatalogAnd(storefront, { _id: { $in: taggedIds } })
  )
    .select('_id')
    .lean();

  return liveProducts.map((p) => p._id).filter(Boolean);
}

/**
 * Build a Mongo filter clause restricting products to tagged ids.
 * Returns null when no tagged products exist (caller should short-circuit empty response).
 * @param {string[]} tagSlugs
 * @returns {Promise<{ _id: { $in: import('mongoose').Types.ObjectId[] } }|null>}
 */
async function buildTagFilterClause(tagSlugs = []) {
  const ids = await getProductIdsByTags(tagSlugs);
  if (!ids.length) return null;
  return { _id: { $in: ids } };
}

const ON_SALE_TAG = 'on-sale';

function productHasOnSaleTag(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => String(tag || '').trim().toLowerCase() === ON_SALE_TAG);
}

/**
 * Product ids that currently have the `on-sale` marketing tag.
 * @param {Array<import('mongoose').Types.ObjectId|string>} productIds
 * @returns {Promise<Set<string>>}
 */
async function getOnSaleProductIdSet(productIds = []) {
  const ids = [];
  const seen = new Set();

  for (const raw of productIds || []) {
    if (raw == null) continue;
    const id = raw._id != null ? raw._id : raw;
    const key = String(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (mongoose.Types.ObjectId.isValid(key)) ids.push(id);
  }

  if (!ids.length) return new Set();

  const tagDocs = await ProductTag.find({
    product: { $in: ids },
    tags: ON_SALE_TAG,
  })
    .select('product')
    .lean();

  const onSale = new Set();
  for (const doc of tagDocs) {
    if (!doc?.product) continue;
    onSale.add(String(doc.product));
  }
  return onSale;
}

module.exports = {
  MARKETING_TAG_SLUGS,
  LEGACY_MARKETING_TAG_MAP,
  ON_SALE_TAG,
  normalizeTagSlugs,
  sanitizeMarketingTags,
  expandTagSlugsForQuery,
  resolveAdminMarketingTagFilter,
  productHasOnSaleTag,
  getProductIdsByTags,
  getLiveProductIdsByTags,
  getOnSaleProductIdSet,
  buildTagFilterClause,
};

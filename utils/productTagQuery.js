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
]);

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
 * Product ids that have at least one of the requested tags (ProductTag collection).
 * @param {string[]} tagSlugs
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
async function getProductIdsByTags(tagSlugs = []) {
  const normalized = normalizeTagSlugs(tagSlugs);
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

module.exports = {
  MARKETING_TAG_SLUGS,
  normalizeTagSlugs,
  getProductIdsByTags,
  getLiveProductIdsByTags,
  buildTagFilterClause,
};

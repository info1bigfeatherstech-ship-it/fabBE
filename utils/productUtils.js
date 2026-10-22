const slugify = require('slugify');
const Product = require('../models/Product');

/**
 * Generate unique slug from product name
 */
const generateSlug = async (name, excludeId = null) => {
  const base = slugify(name, { lower: true, strict: true });
  let candidate = base;
  let suffix = 1;

  while (await Product.exists({ slug: candidate, ...(excludeId && { _id: { $ne: excludeId } }) })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};

/**
 * Canonical catalog SKU from productCode — same rule for single + bulk listing.
 * Examples: 1221-1 → SKU-1221-1 ; 2323 → SKU-2323
 *
 * @param {string} productCode already-normalized product code preferred
 * @returns {string}
 */
function buildSkuFromProductCode(productCode) {
  const code = String(productCode || '')
    .trim()
    .toUpperCase();
  if (!code) {
    const err = new Error('productCode is required to generate SKU');
    err.code = 'PRODUCT_CODE_REQUIRED_FOR_SKU';
    err.statusCode = 400;
    throw err;
  }
  // Idempotent if caller already passed a SKU-prefixed value
  if (code.startsWith('SKU-')) {
    if (code === 'SKU-' || code.length <= 4) {
      const err = new Error('Invalid SKU / productCode for SKU generation');
      err.code = 'INVALID_SKU_SOURCE';
      err.statusCode = 400;
      throw err;
    }
    return code;
  }
  return `SKU-${code}`;
}

/**
 * Resolve variant SKU: optional explicit CSV/manual sku (kept as-is when provided),
 * else productCode-derived `SKU-{productCode}`. Never generates random SKUs.
 *
 * @param {{ productCode: string, explicitSku?: string|null }} opts
 * @returns {string}
 */
function resolveVariantSku({ productCode, explicitSku } = {}) {
  const fromExplicit = String(explicitSku || '').trim();
  if (fromExplicit) {
    return fromExplicit;
  }
  return buildSkuFromProductCode(productCode);
}

/**
 * Ensure SKU is not already used on another variant (DB unique index also enforces).
 *
 * @param {string} sku
 * @param {{ excludeProductId?: import('mongoose').Types.ObjectId|string|null }} [opts]
 */
async function assertSkuAvailable(sku, opts = {}) {
  const normalized = String(sku || '').trim();
  if (!normalized) {
    const err = new Error('SKU is required');
    err.code = 'SKU_REQUIRED';
    err.statusCode = 400;
    throw err;
  }
  const filter = { 'variants.sku': normalized };
  if (opts.excludeProductId) {
    filter._id = { $ne: opts.excludeProductId };
  }
  const exists = await Product.exists(filter);
  if (exists) {
    const err = new Error(`SKU already exists: ${normalized}`);
    err.code = 'SKU_ALREADY_EXISTS';
    err.statusCode = 400;
    throw err;
  }
  return normalized;
}

/**
 * @deprecated Random SKUs are retired. Use {@link resolveVariantSku} / {@link buildSkuFromProductCode}.
 * Kept as a thin wrapper so any leftover callers still get productCode-based SKUs when passed a code.
 * @param {string} [productCode]
 */
const generateSku = async (productCode) => {
  if (!productCode) {
    const err = new Error(
      'generateSku requires productCode. Catalog SKUs are derived as SKU-{productCode}.'
    );
    err.code = 'PRODUCT_CODE_REQUIRED_FOR_SKU';
    err.statusCode = 400;
    throw err;
  }
  const sku = buildSkuFromProductCode(productCode);
  await assertSkuAvailable(sku);
  return sku;
};

/**
 * Validate product prices and MOQ
 */
const validateProductPrices = (price) => {
  if (!price.base || price.base <= 0) {
    throw new Error('Base price is required and must be greater than 0');
  }

  if (price.sale != null && price.sale >= price.base) {
    throw new Error('Sale price must be less than base price');
  }

  if (!price.wholesaleBase || price.wholesaleBase <= 0) {
    throw new Error('Wholesale base price is required and must be greater than 0');
  }

  if (price.wholesaleSale != null && price.wholesaleSale >= price.wholesaleBase) {
    throw new Error('Wholesale sale price must be less than wholesale base price');
  }

  if (!price.minimumOrderQuantity || price.minimumOrderQuantity < 1) {
    throw new Error('Minimum order quantity is required and must be at least 1');
  }
};

/**
 * Bulk listing column order — matches FabUniqo Bulk Listing Final Template (29 Aug 2026).
 * Import maps by header NAME, not position. Reordering here only changes the Excel layout.
 */
const BULK_PRODUCT_TEMPLATE_HEADERS = [
  'productCode',
  'name',
  'category',
  'brand',
  'status',
  'isfeatured',
  'basePrice',
  'salePrice',
  'quantity',
  'variantAttributes',
  'weight',
  'length',
  'width',
  'height',
  'soldEnabled',
  'soldCount',
  'fomoEnabled',
  'fomoType',
  'viewingNow',
  'productLeft',
  'customMessage',
  'productAttributes',
  'images (LEAVE BLANK)',
  'hsnCode',
  'gstRate',
  'isFragile',
  'wholesale',
  'wholesaleBase',
  'wholesaleSale',
  'minimumOrderQuantity',
  'countryOfOrigin',
  'title',
  'description'
];

/** Export uses the same order; images column is filled with URLs. */
const BULK_PRODUCT_EXPORT_HEADERS = BULK_PRODUCT_TEMPLATE_HEADERS.map((h) =>
  h === 'images (LEAVE BLANK)' ? 'images' : h
);

/**
 * GST slabs on single listing + bulk Excel dropdown.
 * Import is not a closed whitelist: any number >= 0 is stored (same as createProduct).
 */
const GST_RATE_OPTIONS = [0, 3, 5, 12, 18, 28];

function gstRateAllowedValuesText() {
  return GST_RATE_OPTIONS.join(', ');
}

/**
 * Parse gstRate from a bulk Excel/CSV cell.
 * Accepts 0, 3, "3", "3%", "3.0". Blank → null. Does not reject 3.
 */
function parseBulkGstRate(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error('gstRate must be a number greater than or equal to 0');
    }
    return raw;
  }
  const text = String(raw).trim();
  if (!text) return null;
  const cleaned = text.replace(/%\s*$/i, '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Invalid gstRate "${text}". Enter a number such as ${gstRateAllowedValuesText()}.`
    );
  }
  return parsed;
}

function bulkHeaderKey(header) {
  return String(header || '')
    .trim()
    .replace(/\s*\(.*\)\s*$/, '')
    .trim()
    .toLowerCase();
}

function excelColLetter(colNumber) {
  let n = Number(colNumber);
  if (!Number.isFinite(n) || n < 1) return '';
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function reorderBulkProductRows(rows, targetHeaders = BULK_PRODUCT_TEMPLATE_HEADERS) {
  const headers = Array.isArray(targetHeaders) ? targetHeaders : BULK_PRODUCT_TEMPLATE_HEADERS;
  if (!Array.isArray(rows) || rows.length === 0) return [headers.slice()];
  const srcHeaders = Array.isArray(rows[0]) ? rows[0] : [];
  const indexByKey = new Map();
  srcHeaders.forEach((h, i) => {
    const key = bulkHeaderKey(h);
    if (key && !indexByKey.has(key)) indexByKey.set(key, i);
  });
  const out = [headers.slice()];
  for (let r = 1; r < rows.length; r += 1) {
    const src = Array.isArray(rows[r]) ? rows[r] : [];
    out.push(
      headers.map((h) => {
        const idx = indexByKey.get(bulkHeaderKey(h));
        return idx == null ? '' : src[idx] ?? '';
      })
    );
  }
  return out;
}

function patchBulkInstructionColumns(instructionRows, targetHeaders = BULK_PRODUCT_TEMPLATE_HEADERS) {
  const colByField = new Map();
  (targetHeaders || []).forEach((h, i) => {
    colByField.set(bulkHeaderKey(h), excelColLetter(i + 1));
  });
  const allowedGst = gstRateAllowedValuesText();
  return (Array.isArray(instructionRows) ? instructionRows : []).map((row) => {
    const next = Array.isArray(row) ? row.slice() : [];
    const field = bulkHeaderKey(next[1]);
    if (field && colByField.has(field)) next[0] = colByField.get(field);
    if (field === 'gstrate') next[4] = allowedGst;
    return next;
  });
}

module.exports = {
  generateSlug,
  generateSku,
  buildSkuFromProductCode,
  resolveVariantSku,
  assertSkuAvailable,
  validateProductPrices,
  BULK_PRODUCT_TEMPLATE_HEADERS,
  BULK_PRODUCT_EXPORT_HEADERS,
  GST_RATE_OPTIONS,
  gstRateAllowedValuesText,
  parseBulkGstRate,
  bulkHeaderKey,
  excelColLetter,
  reorderBulkProductRows,
  patchBulkInstructionColumns
};

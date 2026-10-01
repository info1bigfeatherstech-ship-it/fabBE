const ProductCodePrefixSettings = require('../models/ProductCodePrefixSettings');
const logger = require('../utils/logger');
const {
  validateProductCodePrefix,
  normalizeProductCodePrefixInput
} = require('../utils/productCode');

const VALID_STOREFRONTS = new Set(['ecomm', 'wholesale']);

function normalizeStorefront(value) {
  const s = String(value || 'ecomm').toLowerCase().trim();
  return VALID_STOREFRONTS.has(s) ? s : 'ecomm';
}

function toPublicPolicy(doc) {
  const raw = doc?.prefix != null ? String(doc.prefix) : '';
  const normalized = normalizeProductCodePrefixInput(raw);
  const configured = Boolean(normalized);
  return {
    storefront: doc?.storefront || 'ecomm',
    prefix: configured ? normalized : '',
    configured,
    minLength: 2,
    maxLength: 3
  };
}

async function getOrCreateSettings(storefront) {
  const sf = normalizeStorefront(storefront);
  let doc = await ProductCodePrefixSettings.findOne({ storefront: sf }).lean();
  if (doc) return doc;
  try {
    doc = await ProductCodePrefixSettings.create({
      storefront: sf,
      prefix: ''
    });
    logger.info('[productCodePrefixSettings] Created empty settings', { storefront: sf });
    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      return ProductCodePrefixSettings.findOne({ storefront: sf }).lean();
    }
    throw err;
  }
}

async function getPolicyForStorefront(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return toPublicPolicy(doc);
}

/**
 * Returns validated prefix or throws 400 if not configured.
 * Use on NEW listing write paths only (create / bulk create).
 */
async function requireConfiguredPrefix(storefront) {
  const policy = await getPolicyForStorefront(storefront);
  const check = validateProductCodePrefix(policy.prefix);
  if (!check.ok) {
    const err = new Error(
      'Product code prefix is not configured. Set it in Admin → Settings → Product code prefix (2–3 letters) before listing products.'
    );
    err.statusCode = 400;
    err.code = 'PRODUCT_CODE_PREFIX_REQUIRED';
    throw err;
  }
  return check.prefix;
}

/**
 * Admin PUT: prefix required, 2–3 letters A–Z only. No empty save.
 */
async function applyAdminPatch(storefront, body, updatedByUserId) {
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['Request body is required'] };
  }
  if (body.prefix === undefined) {
    return { ok: false, errors: ['prefix is required'] };
  }

  const check = validateProductCodePrefix(body.prefix);
  if (!check.ok) {
    return { ok: false, errors: [check.error] };
  }

  const sf = normalizeStorefront(storefront);
  await getOrCreateSettings(sf);

  const doc = await ProductCodePrefixSettings.findOneAndUpdate(
    { storefront: sf },
    {
      $set: {
        prefix: check.prefix,
        updatedBy: updatedByUserId || null
      }
    },
    { new: true, runValidators: true }
  ).lean();

  if (!doc) {
    const err = new Error('Product code prefix settings not found after update');
    err.statusCode = 500;
    err.code = 'PRODUCT_CODE_PREFIX_UPDATE_FAILED';
    throw err;
  }

  return { ok: true, policy: toPublicPolicy(doc) };
}

module.exports = {
  normalizeStorefront,
  getOrCreateSettings,
  getPolicyForStorefront,
  requireConfiguredPrefix,
  applyAdminPatch,
  toPublicPolicy
};

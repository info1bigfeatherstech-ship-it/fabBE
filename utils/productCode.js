/**
 * Shared productCode normalization (e-comm ↔ inventory stock APIs).
 * Keep in sync with inventory software rules:
 * - trim + uppercase
 * - suffix canonicalize: 34354-01 → 34354-1
 * - bare codes (34354) stay as-is — no bare→primary resolution on e-comm
 */

const SUFFIXED_PRODUCT_CODE_REGEX = /^([A-Z0-9]+)-(\d+)$/;

/** Admin-configured listing prefix: 2–3 letters only. */
const PRODUCT_CODE_PREFIX_MIN = 2;
const PRODUCT_CODE_PREFIX_MAX = 3;
const PRODUCT_CODE_PREFIX_REGEX = /^[A-Z]{2,3}$/;

function normalizeProductCode(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) return '';
  const m = s.match(SUFFIXED_PRODUCT_CODE_REGEX);
  if (m) {
    const baseToken = m[1];
    const seq = Number(m[2]);
    if (!Number.isFinite(seq)) return s;
    return `${baseToken}-${seq}`;
  }
  return s;
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SEARCH_MAX_LEN = 100;
const CODE_SEARCH_MIN_LEN = 3;
/** Optional letter prefix length in catalog search (supports 2–3 char admin prefixes). */
const CODE_SEARCH_OPTIONAL_PREFIX_MAX = 3;

/**
 * Trim + uppercase only. Empty string stays empty (not configured).
 * Invalid characters → null (caller treats as validation failure).
 */
function normalizeProductCodePrefixInput(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) return '';
  if (!PRODUCT_CODE_PREFIX_REGEX.test(s)) return null;
  return s;
}

/**
 * Strict validation for admin save / listing gate.
 * Empty is NOT allowed (prefix must be configured before listing).
 */
function validateProductCodePrefix(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) {
    return {
      ok: false,
      error: `Product code prefix is required (${PRODUCT_CODE_PREFIX_MIN}–${PRODUCT_CODE_PREFIX_MAX} letters, e.g. FU or MTL).`
    };
  }
  if (s.length < PRODUCT_CODE_PREFIX_MIN || s.length > PRODUCT_CODE_PREFIX_MAX) {
    return {
      ok: false,
      error: `Product code prefix must be ${PRODUCT_CODE_PREFIX_MIN}–${PRODUCT_CODE_PREFIX_MAX} letters.`
    };
  }
  if (!PRODUCT_CODE_PREFIX_REGEX.test(s)) {
    return {
      ok: false,
      error: 'Product code prefix must contain letters only (A–Z).'
    };
  }
  return { ok: true, prefix: s };
}

/**
 * Apply configured prefix for NEW product listings only.
 * - If code already starts with the current prefix → leave as-is (no FUFU…)
 * - Else prepend (MTL + FU788-1 → MTLFU788-1)
 * Does not mutate existing DB rows; caller must only use on create/bulk-create paths.
 *
 * @param {string} rawCode
 * @param {string} prefix validated 2–3 letter prefix
 * @returns {string}
 */
function applyConfiguredProductCodePrefix(rawCode, prefix) {
  const check = validateProductCodePrefix(prefix);
  if (!check.ok) {
    const err = new Error(check.error);
    err.code = 'PRODUCT_CODE_PREFIX_REQUIRED';
    err.statusCode = 400;
    throw err;
  }
  const p = check.prefix;
  const normalized = normalizeProductCode(rawCode);
  if (!normalized) return normalized;
  if (normalized.startsWith(p)) return normalized;
  return normalizeProductCode(`${p}${normalized}`);
}

/**
 * Catalog search: name OR productCode only (no brand/title/description).
 * Codes may omit a 2–3 letter prefix: FU2311 ↔ 2311, MTL788 ↔ 788.
 * Variant families still match: 2421 → 2421-1 / 2421-2.
 * Anchored so short digits do not substring-match unrelated codes.
 */
function buildNameAndProductCodeSearch(rawQuery) {
  const q = String(rawQuery || '').trim().slice(0, SEARCH_MAX_LEN);
  if (!q) return null;

  const compact = q.replace(/[\s_]+/g, '');
  const nameClause = { name: { $regex: escapeRegex(q), $options: 'i' } };
  const or = [nameClause];

  const addCodeFamily = (token) => {
    if (!token || token.length < CODE_SEARCH_MIN_LEN) return;
    or.push({
      'variants.productCode': {
        $regex: `^[A-Za-z]{0,${CODE_SEARCH_OPTIONAL_PREFIX_MAX}}${escapeRegex(token)}(?:-\\d+)*$`,
        $options: 'i',
      },
    });
  };

  addCodeFamily(q);
  if (compact !== q) addCodeFamily(compact);

  return { $or: or };
}

module.exports = {
  SUFFIXED_PRODUCT_CODE_REGEX,
  PRODUCT_CODE_PREFIX_MIN,
  PRODUCT_CODE_PREFIX_MAX,
  PRODUCT_CODE_PREFIX_REGEX,
  normalizeProductCode,
  escapeRegex,
  normalizeProductCodePrefixInput,
  validateProductCodePrefix,
  applyConfiguredProductCodePrefix,
  buildNameAndProductCodeSearch,
};

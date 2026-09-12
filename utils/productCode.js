/**
 * Shared productCode normalization (e-comm ↔ inventory stock APIs).
 * Keep in sync with inventory software rules:
 * - trim + uppercase
 * - suffix canonicalize: 34354-01 → 34354-1
 * - bare codes (34354) stay as-is — no bare→primary resolution on e-comm
 */

const SUFFIXED_PRODUCT_CODE_REGEX = /^([A-Z0-9]+)-(\d+)$/;

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

/**
 * Catalog search: name OR productCode only (no brand/title/description).
 * Codes may omit a 2-letter prefix: FU2311 ↔ 2311.
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
        $regex: `^[A-Za-z]{0,2}${escapeRegex(token)}(?:-\\d+)*$`,
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
  normalizeProductCode,
  escapeRegex,
  buildNameAndProductCodeSearch,
};

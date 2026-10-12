/**
 * Sanitize product/variant attribute payloads.
 * Optional `hex` is kept only for valid #RGB / #RRGGBB (storefront swatches).
 */

function normalizeAttrHex(raw) {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  const withHash = s.startsWith('#') ? s : `#${s}`;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(withHash)) return undefined;
  // Expand #RGB → #RRGGBB and normalize to uppercase for stable equality.
  if (withHash.length === 4) {
    const r = withHash[1];
    const g = withHash[2];
    const b = withHash[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return withHash.toUpperCase();
}

/**
 * @param {unknown} list
 * @returns {{ key: string, value: string, hex?: string }[]}
 */
function sanitizeVariantAttributes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const key = String(raw.key || '').trim();
    const value = String(raw.value || '').trim();
    if (!key || !value) continue;
    const attr = { key, value };
    const hex = normalizeAttrHex(raw.hex);
    if (hex) attr.hex = hex;
    out.push(attr);
  }
  return out;
}

/**
 * Parse CSV/ZIP attribute strings like:
 *   Color:Ochre|Size:M
 *   Color:Ochre:#CC7722|Size:M
 *   Color:Rose Gold:#B76E79
 */
function parseAttributePipeList(attrString) {
  if (!attrString) return [];
  return String(attrString)
    .split('|')
    .map((item) => {
      const segs = String(item || '')
        .split(':')
        .map((p) => p.trim())
        .filter(Boolean);
      if (segs.length < 2) return null;
      if (segs.length >= 3) {
        const maybeHex = normalizeAttrHex(segs[segs.length - 1]);
        if (maybeHex) {
          return {
            key: segs[0],
            value: segs.slice(1, -1).join(':'),
            hex: maybeHex
          };
        }
      }
      return { key: segs[0], value: segs.slice(1).join(':') };
    })
    .filter(Boolean)
    .filter((a) => a.key && a.value);
}

module.exports = {
  normalizeAttrHex,
  sanitizeVariantAttributes,
  parseAttributePipeList
};

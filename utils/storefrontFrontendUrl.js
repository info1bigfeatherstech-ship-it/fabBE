/**
 * Resolve public storefront base URLs for push click targets / emails.
 * Skips localhost in production so bad env does not ship broken links.
 */

function pickFirstUrl(raw) {
  return String(raw || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
}

function isLocalFrontendUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function resolveStorefrontBaseUrl(storefront = 'ecomm') {
  const sf = String(storefront || 'ecomm').toLowerCase() === 'wholesale' ? 'wholesale' : 'ecomm';
  const allowLocal =
    String(process.env.PUSH_USE_LOCAL_FRONTEND || '').trim().toLowerCase() === 'true' ||
    process.env.NODE_ENV !== 'production';

  const candidates =
    sf === 'wholesale'
      ? [
          process.env.WHOLESALE_FRONTEND_URL,
          process.env.ECOMM_PUBLIC_URL,
          process.env.FRONTEND_URL,
          process.env.STORE_URL,
        ]
      : [
          process.env.ECOMM_PUBLIC_URL,
          process.env.FRONTEND_URL,
          process.env.STORE_URL,
          process.env.WHOLESALE_FRONTEND_URL,
        ];

  for (const raw of candidates) {
    const url = pickFirstUrl(raw);
    if (!url) continue;
    if (!allowLocal && isLocalFrontendUrl(url)) continue;
    return url;
  }
  return '';
}

function resolvePushBrandIconUrl() {
  const explicit = pickFirstUrl(process.env.PUSH_BRAND_ICON_URL);
  if (explicit) return explicit;
  const base = resolveStorefrontBaseUrl('ecomm');
  if (base) return `${base}/favicon-192.png`;
  return '/favicon-192.png';
}

function joinStorefrontPath(storefront, path) {
  const base = resolveStorefrontBaseUrl(storefront);
  const clean = String(path || '/').startsWith('/') ? String(path) : `/${path}`;
  return base ? `${base}${clean}` : clean;
}

/** Cart page (SPA redirects /cart → /account/cart). */
function resolveCartPageUrl(storefront = 'ecomm') {
  return joinStorefrontPath(storefront, '/account/cart');
}

/** Full wishlist page. */
function resolveWishlistPageUrl(storefront = 'ecomm') {
  return joinStorefrontPath(storefront, '/wishlist');
}

/** New Arrivals PLP (featured products). */
function resolveNewArrivalsPageUrl(storefront = 'ecomm') {
  return joinStorefrontPath(storefront, '/shop/new-arrivals');
}

/** Product detail — FE route is /product/:slug (singular). */
function resolveProductDetailUrl(slug, storefront = 'ecomm') {
  const clean = String(slug || '').trim();
  if (!clean) return joinStorefrontPath(storefront, '/shop/new-arrivals');
  return joinStorefrontPath(storefront, `/product/${encodeURIComponent(clean)}`);
}

module.exports = {
  pickFirstUrl,
  isLocalFrontendUrl,
  resolveStorefrontBaseUrl,
  resolvePushBrandIconUrl,
  joinStorefrontPath,
  resolveCartPageUrl,
  resolveWishlistPageUrl,
  resolveNewArrivalsPageUrl,
  resolveProductDetailUrl,
};

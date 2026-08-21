/**
 * Resolves catalog storefront from the incoming HTTP request.
 * Priority: storefront headers → hostname allowlists (env) → default "ecomm".
 *
 * Env (optional, comma-separated hostnames, no protocol):
 *   STOREFRONT_WHOLESALE_HOSTS=wholesale.example.com,localhost:3001
 *   STOREFRONT_ECOMM_HOSTS=shop.example.com,localhost:3000
 */

const DEFAULT_STOREFRONT = 'ecomm';
const { STOREFRONT_HEADER_ALIASES } = require('../constants/storefrontHeaders');

function parseHostList(envValue) {
  if (!envValue || typeof envValue !== 'string') return [];
  return envValue
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeHostHeader(host) {
  if (!host || typeof host !== 'string') return '';
  return host.split(':')[0].trim().toLowerCase();
}

/**
 * Match host against an entry: exact, suffix subdomain, or leading-dot suffix.
 * @param {string} host normalized hostname without port
 * @param {string} entry entry from env list
 */
function hostMatchesEntry(host, entry) {
  if (!host || !entry) return false;
  const e = entry.toLowerCase().trim();
  if (!e) return false;
  if (host === e) return true;
  if (e.startsWith('.')) {
    const root = e.slice(1);
    return host === root || host.endsWith(e);
  }
  return host === e || host.endsWith(`.${e}`);
}

function resolveStorefrontFromHeader(raw) {
  if (raw == null || raw === '') return null;
  const v = String(raw).toLowerCase().trim();
  if (v === 'wholesale' || v === 'wholesaler' || v === 'b2b') return 'wholesale';
  if (v === 'ecomm' || v === 'retail' || v === 'shop' || v === 'store' || v === 'b2c') {
    return 'ecomm';
  }
  return null;
}

function readStorefrontHeader(req) {
  for (const key of STOREFRONT_HEADER_ALIASES) {
    const value = req.get(key);
    if (value != null && String(value).trim() !== '') return value;
  }
  return null;
}

/**
 * @param {import('express').Request} req
 * @returns {'ecomm'|'wholesale'}
 */
function resolveStorefront(req) {
  const fromHeader = resolveStorefrontFromHeader(readStorefrontHeader(req));
  if (fromHeader) return fromHeader;

  const host = normalizeHostHeader(req.get('host') || '');

  const wholesaleHosts = parseHostList(process.env.STOREFRONT_WHOLESALE_HOSTS);
  for (const h of wholesaleHosts) {
    if (hostMatchesEntry(host, h)) return 'wholesale';
  }

  const ecommHosts = parseHostList(process.env.STOREFRONT_ECOMM_HOSTS);
  for (const h of ecommHosts) {
    if (hostMatchesEntry(host, h)) return 'ecomm';
  }

  return DEFAULT_STOREFRONT;
}

module.exports = {
  DEFAULT_STOREFRONT,
  resolveStorefront
};

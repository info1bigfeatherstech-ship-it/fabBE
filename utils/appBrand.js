/**
 * Single source of truth for the public store / brand display name.
 *
 * Set in `.env`:
 *   APP_NAME=TeamTee Ecomm
 *
 * Used across emails, OTP, notifications, SEO titles, invoices, labels, etc.
 * Change the env value → every user-facing surface picks it up (after restart).
 */

function getAppName() {
  const name = String(process.env.APP_NAME || '').trim();
  return name || 'Store';
}

/** Email "From" display name: `"TeamTee Ecomm" <user@...>` */
function getAppEmailFromName() {
  const marketing = String(process.env.MARKETING_EMAIL_FROM_NAME || '').trim();
  return marketing || getAppName();
}

/** Signature line used in plain/HTML emails: `— TeamTee Ecomm` */
function getAppSignature() {
  return `— ${getAppName()}`;
}

/** Team signature: `— Team TeamTee Ecomm` */
function getAppTeamSignature() {
  return `— Team ${getAppName()}`;
}

/** Security mailer display: `TeamTee Ecomm Security` */
function getAppSecurityFromName() {
  return `${getAppName()} Security`;
}

/**
 * Safe token for User-Agent / technical identifiers (no spaces).
 * e.g. "TeamTee Ecomm" → "TeamTeeEcomm"
 */
function getAppNameSlug() {
  return getAppName().replace(/\s+/g, '') || 'Store';
}

/** HTTP User-Agent compatible string for outbound fetches */
function getAppUserAgent() {
  const site = String(process.env.FRONTEND_URL || process.env.STORE_URL || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
  const sitePart = site ? `; +${site}` : '';
  return `Mozilla/5.0 (compatible; ${getAppNameSlug()}/1.0${sitePart})`;
}

module.exports = {
  getAppName,
  getAppEmailFromName,
  getAppSignature,
  getAppTeamSignature,
  getAppSecurityFromName,
  getAppNameSlug,
  getAppUserAgent
};

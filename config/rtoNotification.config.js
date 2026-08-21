/**
 * RTO customer notification copy + policy URL.
 * Prefer RTO_REFUND_POLICY_URL; else FRONTEND_URL/STORE_URL + /policies/return-refund.
 */

function getRtoRefundPolicyUrl() {
  const raw = String(process.env.RTO_REFUND_POLICY_URL || '').trim();
  if (raw) return raw;

  const base = String(process.env.FRONTEND_URL || process.env.STORE_URL || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
  if (base) return `${base}/policies/return-refund`;

  return '/policies/return-refund';
}

module.exports = {
  getRtoRefundPolicyUrl
};

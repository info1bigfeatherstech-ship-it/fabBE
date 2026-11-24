/**
 * Customer checkout shipping lock.
 *
 * Checkout-time delivery is frozen forever for the customer (UI, totals, labels).
 * Admin may re-quote after address / weight-dim edits; that amount lives in
 * adminQuotedDeliveryInr and must never overwrite the customer-facing charge.
 */

const { roundMoney2 } = require('../services/checkoutComputation.service');

/**
 * Immutable customer shipping (₹). Legacy orders without checkoutDeliveryCharges
 * fall back to deliveryCharges (current SSOT at read time).
 * @param {object|null|undefined} order
 * @returns {number}
 */
function getCheckoutDeliveryCharges(order) {
  try {
    const frozen = order?.checkoutDeliveryCharges;
    if (frozen != null && frozen !== '' && Number.isFinite(Number(frozen))) {
      return roundMoney2(Math.max(0, Number(frozen)));
    }
    return roundMoney2(Math.max(0, Number(order?.deliveryCharges) || 0));
  } catch {
    return 0;
  }
}

/**
 * Ensure order document has checkoutDeliveryCharges set (idempotent).
 * Call on place-order and once on first admin amend of legacy orders.
 * @param {object} order — mongoose doc or plain
 * @param {number} [explicitAmount]
 * @returns {number} locked amount
 */
function ensureCheckoutDeliveryFrozen(order, explicitAmount) {
  const existing = order?.checkoutDeliveryCharges;
  if (existing != null && existing !== '' && Number.isFinite(Number(existing))) {
    return roundMoney2(Math.max(0, Number(existing)));
  }
  const amount =
    explicitAmount != null && Number.isFinite(Number(explicitAmount))
      ? roundMoney2(Math.max(0, Number(explicitAmount)))
      : roundMoney2(Math.max(0, Number(order?.deliveryCharges) || 0));
  if (order && typeof order === 'object') {
    order.checkoutDeliveryCharges = amount;
  }
  return amount;
}

/**
 * Admin / courier re-quote (₹), when known.
 * @param {object|null|undefined} order
 * @returns {number|null}
 */
function getAdminQuotedDeliveryInr(order) {
  try {
    const q = order?.adminQuotedDeliveryInr;
    if (q == null || q === '') return null;
    const n = Number(q);
    if (!Number.isFinite(n)) return null;
    return roundMoney2(Math.max(0, n));
  } catch {
    return null;
  }
}

/**
 * Admin delta vs locked checkout shipping (positive = merchant pays more).
 * @param {object|null|undefined} order
 * @returns {number|null}
 */
function getAdminShippingDeltaInr(order) {
  const quoted = getAdminQuotedDeliveryInr(order);
  if (quoted == null) return null;
  return roundMoney2(quoted - getCheckoutDeliveryCharges(order));
}

/**
 * Persist admin quote fields after a re-quote. Does not touch customer delivery.
 * @param {object} order
 * @param {number} quotedDelivery
 */
function applyAdminQuotedDelivery(order, quotedDelivery) {
  const quoted = roundMoney2(Math.max(0, Number(quotedDelivery) || 0));
  const locked = ensureCheckoutDeliveryFrozen(order);
  order.adminQuotedDeliveryInr = quoted;
  order.adminShippingDeltaInr = roundMoney2(quoted - locked);
  order.adminQuotedDeliveryAt = new Date();
  return { locked, quoted, delta: order.adminShippingDeltaInr };
}

/**
 * Keep customer-billed deliveryCharges aligned with checkout lock.
 * @param {object} order
 * @returns {number}
 */
function syncCustomerDeliveryChargesToLock(order) {
  const locked = ensureCheckoutDeliveryFrozen(order);
  order.deliveryCharges = locked;
  return locked;
}

module.exports = {
  getCheckoutDeliveryCharges,
  ensureCheckoutDeliveryFrozen,
  getAdminQuotedDeliveryInr,
  getAdminShippingDeltaInr,
  applyAdminQuotedDelivery,
  syncCustomerDeliveryChargesToLock
};

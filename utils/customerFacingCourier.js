/**
 * Quoted vs assigned courier helpers.
 *
 * - Assigned (`shipmentInfo.courier`): custom label name, AWB, barcode, tracking courier.
 * - Quoted (checkout snapshot / substitute-from): admin reference + customer shipping ₹ context.
 *   Customer shipping charges stay on order.deliveryCharges / customerFacing — never rewritten here.
 */

function isAggregatorCourierName(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/^ship\s*mozo$/i.test(n)) return true;
  if (/^shiprocket$/i.test(n)) return true;
  return false;
}

function cleanCourierName(raw) {
  const name = String(raw || '').trim();
  if (!name || isAggregatorCourierName(name)) return null;
  return name;
}

/**
 * Checkout-quoted courier (admin reference / substitute-from).
 * Not used for custom label name or AWB — those use resolveAssignedCourierName.
 *
 * @param {object|null|undefined} order
 * @returns {string|null}
 */
function resolveCustomerFacingCourierName(order) {
  if (!order || typeof order !== 'object') return null;
  const si = order.shipmentInfo && typeof order.shipmentInfo === 'object' ? order.shipmentInfo : {};
  const snap = order.shippingSnapshot && typeof order.shippingSnapshot === 'object' ? order.shippingSnapshot : {};

  return (
    cleanCourierName(si.courierSubstitutedFromName) ||
    cleanCourierName(snap.courierName) ||
    cleanCourierName(si.quotedCourierName) ||
    cleanCourierName(si.preferredCourier) ||
    cleanCourierName(si.courier) ||
    null
  );
}

/**
 * Actual booked courier (admin / AWB / carrier).
 * @param {object|null|undefined} order
 * @returns {string|null}
 */
function resolveAssignedCourierName(order) {
  if (!order || typeof order !== 'object') return null;
  const si = order.shipmentInfo && typeof order.shipmentInfo === 'object' ? order.shipmentInfo : {};
  return cleanCourierName(si.courier) || null;
}

/**
 * True when assigned courier differs from what the customer was quoted.
 * @param {object|null|undefined} order
 */
function isCourierSubstitutedForCustomer(order) {
  const quoted = resolveCustomerFacingCourierName(order);
  const assigned = resolveAssignedCourierName(order);
  if (!quoted || !assigned) return false;
  return quoted.toLowerCase() !== assigned.toLowerCase();
}

module.exports = {
  isAggregatorCourierName,
  cleanCourierName,
  resolveCustomerFacingCourierName,
  resolveAssignedCourierName,
  isCourierSubstitutedForCustomer
};

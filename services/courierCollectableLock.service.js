/**
 * Courier collectable lock (partial prepaid + COD / Ship Now freight).
 *
 * At courier push, COD/collectable freezes on Shipmozo/Shiprocket.
 * Later OOS / Ship Now may lower live balanceDueInr / deliveryCharges in our DB,
 * but the courier still expects the push-time amount. Customer UI + labels must
 * show the locked amounts when present; admin keeps live due for internal accounting.
 */

const { roundMoney2 } = require('./checkoutComputation.service');

const LOCK_FIELD_KEYS = Object.freeze([
  'courierCollectableInr',
  'courierDeliveryInr',
  'courierFacingTotalInr',
  'codLockedAt',
  'codLockSource'
]);

function asFiniteMoney(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return roundMoney2(n);
}

/**
 * Live collectable = what we would send to the courier right now (no lock).
 * Mirrors Shipmozo buildPushOrderParts / label paymentAndCollectable rules.
 */
function computeLiveCourierCollectable(order) {
  try {
    const payMethod = String(order?.paymentInfo?.method || order?.paymentMethod || '')
      .toLowerCase()
      .trim();
    const balanceViaCod =
      String(order?.paymentInfo?.balanceCollectionMethod || '').toLowerCase() === 'cod';
    const totalInr = roundMoney2(Number(order?.totalAmount) || 0);
    const paidInr = roundMoney2(Number(order?.amountPaidInr) || 0);
    let balanceDue = roundMoney2(Math.max(0, Number(order?.balanceDueInr) || 0));
    if (!(balanceDue > 0.005) && paidInr > 0.005 && totalInr > 0.005) {
      balanceDue = roundMoney2(Math.max(0, totalInr - paidInr));
    }
    const unpaidInr = roundMoney2(Math.max(0, totalInr - paidInr));
    if (balanceDue > unpaidInr + 0.005) balanceDue = unpaidInr;

    const useCodAtDoor = payMethod === 'cod' || (balanceViaCod && balanceDue > 0.005);
    const collectable = useCodAtDoor ? (payMethod === 'cod' ? totalInr : balanceDue) : 0;

    return {
      collectable: roundMoney2(collectable),
      paymentMode: useCodAtDoor ? 'COD' : 'PREPAID',
      orderTotal: totalInr,
      shippingCharges: roundMoney2(Number(order?.deliveryCharges) || 0),
      useCodAtDoor: Boolean(useCodAtDoor),
      balanceDue,
      paidInr
    };
  } catch {
    return {
      collectable: 0,
      paymentMode: 'PREPAID',
      orderTotal: roundMoney2(Number(order?.totalAmount) || 0),
      shippingCharges: roundMoney2(Number(order?.deliveryCharges) || 0),
      useCodAtDoor: false,
      balanceDue: 0,
      paidInr: roundMoney2(Number(order?.amountPaidInr) || 0)
    };
  }
}

function hasCourierCollectableLockOnSi(si) {
  try {
    if (!si || typeof si !== 'object') return false;
    const v = asFiniteMoney(si.courierCollectableInr);
    // Explicit 0 is a valid lock (prepaid / nothing to collect)
    return v != null;
  } catch {
    return false;
  }
}

function hasCourierCollectableLock(order) {
  try {
    return hasCourierCollectableLockOnSi(order?.shipmentInfo);
  } catch {
    return false;
  }
}

function getCustomerFacingCollectableInr(order) {
  try {
    if (hasCourierCollectableLock(order)) {
      return asFiniteMoney(order.shipmentInfo.courierCollectableInr) ?? 0;
    }
    return computeLiveCourierCollectable(order).collectable;
  } catch {
    return 0;
  }
}

function getCustomerFacingDeliveryInr(order) {
  try {
    if (hasCourierCollectableLock(order)) {
      const frozen = asFiniteMoney(order.shipmentInfo?.courierDeliveryInr);
      if (frozen != null) return frozen;
    }
    return roundMoney2(Number(order?.deliveryCharges) || 0);
  } catch {
    return 0;
  }
}

function getCustomerFacingOrderTotalInr(order) {
  try {
    if (hasCourierCollectableLock(order)) {
      const frozen = asFiniteMoney(order.shipmentInfo?.courierFacingTotalInr);
      if (frozen != null) return frozen;
    }
    return roundMoney2(Number(order?.totalAmount) || 0);
  } catch {
    return roundMoney2(Number(order?.totalAmount) || 0);
  }
}

/** Customer label: locked COD → "Pay to courier"; else "Balance due". */
function getCustomerFacingCollectableLabel(order) {
  try {
    if (hasCourierCollectableLock(order)) {
      const locked = getCustomerFacingCollectableInr(order);
      if (locked > 0.005) return 'Pay to courier';
      return null;
    }
    const live = computeLiveCourierCollectable(order);
    if (live.collectable > 0.005) return 'Balance due';
    return null;
  } catch {
    return null;
  }
}

/**
 * Snapshot lock fields for shipment upsert payload (first push only).
 * Prepaid → lock 0 is intentional.
 */
function buildCourierLockShipmentPayloadFields(order, { source = 'push' } = {}) {
  try {
    if (hasCourierCollectableLock(order)) return {};
    const live = computeLiveCourierCollectable(order);
    return {
      courierCollectableInr: live.collectable,
      courierDeliveryInr: live.shippingCharges,
      courierFacingTotalInr: live.orderTotal,
      codLockedAt: new Date(),
      codLockSource: String(source || 'push').slice(0, 64)
    };
  } catch {
    return {};
  }
}

/**
 * Mutate order.shipmentInfo in memory with lock (no save). No-op if already locked.
 */
function applyCourierCollectableLock(order, { source = 'push' } = {}) {
  try {
    if (!order) return { applied: false, reason: 'no_order' };
    if (hasCourierCollectableLock(order)) {
      return {
        applied: false,
        reason: 'already_locked',
        collectable: getCustomerFacingCollectableInr(order)
      };
    }
    const fields = buildCourierLockShipmentPayloadFields(order, { source });
    if (!Object.keys(fields).length) {
      return { applied: false, reason: 'empty_fields' };
    }
    order.shipmentInfo = { ...(order.shipmentInfo || {}), ...fields };
    if (typeof order.markModified === 'function') {
      order.markModified('shipmentInfo');
    }
    return { applied: true, ...fields, collectable: fields.courierCollectableInr };
  } catch (err) {
    return { applied: false, reason: 'exception', message: err?.message || String(err) };
  }
}

/**
 * After building nextShipmentInfo from upsert: never wipe an existing lock;
 * allow first-time lock values from payload.
 */
function mergeCourierCollectableLockIntoShipmentInfo({
  prevSi = {},
  nextShipmentInfo = {},
  shipmentPayload = {}
} = {}) {
  try {
    const prev = prevSi && typeof prevSi === 'object' ? prevSi : {};
    const next = nextShipmentInfo && typeof nextShipmentInfo === 'object' ? nextShipmentInfo : {};
    const payload = shipmentPayload && typeof shipmentPayload === 'object' ? shipmentPayload : {};
    const prevLocked = hasCourierCollectableLockOnSi(prev);

    if (prevLocked) {
      for (const key of LOCK_FIELD_KEYS) {
        const prevVal = prev[key];
        if (prevVal == null) continue;
        // Restore if missing, null, or non-finite money fields cleared by overlay
        if (key === 'courierCollectableInr' || key === 'courierDeliveryInr' || key === 'courierFacingTotalInr') {
          const nextMoney = asFiniteMoney(next[key]);
          if (nextMoney == null) {
            next[key] = asFiniteMoney(prevVal) ?? prevVal;
          }
        } else if (next[key] == null || next[key] === '') {
          next[key] = prevVal;
        }
      }
      return next;
    }

    // First-time lock from payload
    if (
      Object.prototype.hasOwnProperty.call(payload, 'courierCollectableInr') &&
      asFiniteMoney(payload.courierCollectableInr) != null
    ) {
      next.courierCollectableInr = asFiniteMoney(payload.courierCollectableInr);
      const delivery = asFiniteMoney(payload.courierDeliveryInr);
      const total = asFiniteMoney(payload.courierFacingTotalInr);
      if (delivery != null) next.courierDeliveryInr = delivery;
      if (total != null) next.courierFacingTotalInr = total;
      next.codLockedAt = payload.codLockedAt ? new Date(payload.codLockedAt) : new Date();
      next.codLockSource = String(payload.codLockSource || 'push').slice(0, 64);
    }

    return next;
  } catch {
    return nextShipmentInfo;
  }
}

/** Admin hint when locked COD differs from live internal due. */
function getAdminCollectableLockDiffHint(order) {
  try {
    if (!hasCourierCollectableLock(order)) return null;
    const locked = getCustomerFacingCollectableInr(order);
    const live = computeLiveCourierCollectable(order).collectable;
    const diff = roundMoney2(Math.abs(locked - live));
    if (diff <= 0.05) return null;
    return {
      lockedCollectableInr: locked,
      liveCollectableInr: live,
      liveBalanceDueInr: roundMoney2(Number(order?.balanceDueInr) || 0),
      diffInr: diff,
      message: `Courier collectable (locked at push): ₹${locked.toFixed(2)}. Internal due differs: ₹${live.toFixed(2)}.`
    };
  } catch {
    return null;
  }
}

function attachCustomerFacingMoneyFields(orderPlain) {
  try {
    if (!orderPlain || typeof orderPlain !== 'object') return orderPlain;
    const locked = hasCourierCollectableLock(orderPlain);
    const collectable = getCustomerFacingCollectableInr(orderPlain);
    const label = getCustomerFacingCollectableLabel(orderPlain);
    orderPlain.customerFacing = {
      collectableLocked: locked,
      collectableInr: collectable,
      deliveryInr: getCustomerFacingDeliveryInr(orderPlain),
      totalInr: getCustomerFacingOrderTotalInr(orderPlain),
      collectableLabel: label
    };
    return orderPlain;
  } catch {
    return orderPlain;
  }
}

module.exports = {
  LOCK_FIELD_KEYS,
  computeLiveCourierCollectable,
  hasCourierCollectableLock,
  hasCourierCollectableLockOnSi,
  getCustomerFacingCollectableInr,
  getCustomerFacingDeliveryInr,
  getCustomerFacingOrderTotalInr,
  getCustomerFacingCollectableLabel,
  buildCourierLockShipmentPayloadFields,
  applyCourierCollectableLock,
  mergeCourierCollectableLockIntoShipmentInfo,
  getAdminCollectableLockDiffHint,
  attachCustomerFacingMoneyFields
};

/**
 * Admin pending-order per-line weight / dimensions edit.
 *
 * - Rebuilds package totals + volumetric weight from overridden lines
 * - Re-quotes courier for admin/ops (adminQuotedDeliveryInr)
 * - Never changes customer checkout shipping / totals from shipping delta
 * - Updated shippingWeightSnapshot is what Shiprocket/Shipmozo createShipment uses
 */

const Order = require('../models/Order');
const logger = require('../utils/logger');
const { roundMoney2 } = require('./checkoutComputation.service');
const {
  validateLineShippingOverride,
  applyLineShippingOverridesToSnapshot,
  rebuildShippingWeightSnapshotFromLines,
  enrichShippingWeightSnapshotDims,
  buildShippingWeightSnapshotFromOrderItems,
  idStr,
  lineKey
} = require('../utils/shippingWeightSnapshot');
const {
  assertEditablePendingOrder,
  createEditError,
  repriceShippingForItems,
  snapshotMoney
} = require('./adminPendingOrderEdit.service');
const {
  ensureCheckoutDeliveryFrozen,
  applyAdminQuotedDelivery,
  syncCustomerDeliveryChargesToLock,
  getCheckoutDeliveryCharges
} = require('../utils/customerDeliveryLock');

function normalizeLineOverrides(rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw createEditError(400, 'OVERRIDES_REQUIRED', 'lineOverrides is required');
  }
  const seen = new Set();
  const out = [];
  const allErrors = [];
  for (let i = 0; i < rawList.length; i += 1) {
    const checked = validateLineShippingOverride(rawList[i]);
    if (!checked.ok) {
      allErrors.push({ index: i, errors: checked.errors });
      continue;
    }
    const key = `${checked.data.productId}:${checked.data.variantId}`;
    if (seen.has(key)) {
      allErrors.push({ index: i, errors: [`Duplicate override for ${key}`] });
      continue;
    }
    seen.add(key);
    out.push(checked.data);
  }
  if (allErrors.length) {
    throw createEditError(400, 'OVERRIDE_VALIDATION_FAILED', 'Invalid lineOverrides', {
      errors: allErrors
    });
  }
  return out;
}

async function ensureOrderWeightSnapshot(order) {
  let snap = order.shippingWeightSnapshot;
  if (!snap?.lines?.length) {
    snap = await buildShippingWeightSnapshotFromOrderItems(order);
    if (!snap?.lines?.length) {
      throw createEditError(
        400,
        'SNAPSHOT_MISSING',
        'Order has no shipping weight data to edit'
      );
    }
    order.shippingWeightSnapshot = snap;
  } else {
    snap = await enrichShippingWeightSnapshotDims(snap);
    order.shippingWeightSnapshot = snap;
  }

  // Align snapshot lines to current order items (qty cuts / id normalization).
  const itemQtyByKey = new Map();
  for (const it of order.items || []) {
    const pid = idStr(it.productId);
    const vid = idStr(it.variantId);
    const key = lineKey(pid, vid);
    if (!pid || !vid) continue;
    itemQtyByKey.set(key, Math.max(0, Number(it.quantity) || 0));
  }

  const alignedByKey = new Map();
  // Prefer exact productId:variantId match; fall back to unique variantId match.
  const snapByVariant = new Map();
  for (const row of snap.lines || []) {
    const vid = idStr(row.variantId);
    if (!vid) continue;
    if (!snapByVariant.has(vid)) snapByVariant.set(vid, []);
    snapByVariant.get(vid).push(row);
  }

  for (const [key, qty] of itemQtyByKey.entries()) {
    if (qty <= 0) continue;
    let row = (snap.lines || []).find((r) => lineKey(r.productId, r.variantId) === key) || null;
    if (!row) {
      const vid = key.split(':')[1] || '';
      const candidates = snapByVariant.get(vid) || [];
      if (candidates.length === 1) row = candidates[0];
    }
    if (!row) continue;
    alignedByKey.set(key, {
      ...row,
      productId: key.split(':')[0],
      variantId: key.split(':')[1],
      quantity: qty
    });
  }

  const missingKeys = [...itemQtyByKey.keys()].filter(
    (k) => itemQtyByKey.get(k) > 0 && !alignedByKey.has(k)
  );

  // Any missing current order lines → rebuild full snapshot from catalog (safe + complete).
  if (missingKeys.length || alignedByKey.size === 0) {
    snap = await buildShippingWeightSnapshotFromOrderItems(order);
    if (!snap?.lines?.length) {
      throw createEditError(400, 'SNAPSHOT_MISSING', 'Could not build shipping weight lines');
    }
    // Normalize ids + qty from order items
    const rebuiltLines = (snap.lines || []).map((row) => {
      const key = lineKey(row.productId, row.variantId);
      const qty = itemQtyByKey.has(key) ? itemQtyByKey.get(key) : Math.max(0, Number(row.quantity) || 0);
      return {
        ...row,
        productId: idStr(row.productId) || row.productId,
        variantId: idStr(row.variantId) || row.variantId,
        quantity: qty
      };
    }).filter((row) => itemQtyByKey.has(lineKey(row.productId, row.variantId)));

    if (!rebuiltLines.length) {
      throw createEditError(
        400,
        'SNAPSHOT_MISSING',
        'Order items could not be matched to shipping weight lines'
      );
    }
    return rebuildShippingWeightSnapshotFromLines(rebuiltLines, {
      source: snap.source || 'catalog_fallback'
    });
  }

  return rebuildShippingWeightSnapshotFromLines([...alignedByKey.values()], {
    source: snap.source || 'checkout'
  });
}

/**
 * @param {{ orderId: string, lineOverrides: Array, commit?: boolean, adminUserId?: string|null, scopeMatch?: object }} opts
 */
async function previewOrApplyShippingMetricsEdit(opts) {
  const orderId = String(opts.orderId || '').trim();
  if (!orderId) {
    throw createEditError(400, 'ORDER_ID_REQUIRED', 'orderId is required');
  }

  const query = { orderId, ...(opts.scopeMatch || {}) };
  const order = await Order.findOne(query);
  if (!order) {
    throw createEditError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }

  assertEditablePendingOrder(order);

  const overrides = normalizeLineOverrides(opts.lineOverrides);
  const beforeSnap = await ensureOrderWeightSnapshot(order);
  const beforeMoney = snapshotMoney(order);
  const lockedBefore = ensureCheckoutDeliveryFrozen(order);

  const applied = applyLineShippingOverridesToSnapshot(beforeSnap, overrides, {
    adminUserId: opts.adminUserId || null
  });
  if (!applied.ok) {
    throw createEditError(400, applied.code || 'OVERRIDE_FAILED', applied.message || 'Override failed');
  }

  const nextSnap = applied.snapshot;
  const priced = await repriceShippingForItems(order, order.items || [], {
    weightSnapshot: nextSnap
  });

  const preview = {
    orderId,
    before: {
      ...beforeMoney,
      checkoutDeliveryCharges: lockedBefore,
      adminQuotedDeliveryInr: order.adminQuotedDeliveryInr ?? null,
      shippingWeightSnapshot: beforeSnap
    },
    after: {
      subtotal: priced.subtotal,
      deliveryCharges: priced.customerDelivery,
      checkoutDeliveryCharges: priced.checkoutDeliveryCharges,
      adminQuotedDeliveryInr: priced.quotedDelivery,
      adminShippingDeltaInr: priced.adminShippingDeltaInr,
      tax: priced.tax,
      discount: priced.discount,
      totalAmount: priced.totalAmount,
      shippingWeightSnapshot: priced.weightSnapshot
    },
    shipping: {
      checkoutDeliveryCharges: priced.checkoutDeliveryCharges,
      customerDelivery: priced.customerDelivery,
      customerShippingLocked: true,
      quotedDelivery: priced.quotedDelivery,
      adminQuotedDeliveryInr: priced.quotedDelivery,
      adminShippingDeltaInr: priced.adminShippingDeltaInr,
      shippingIncreasedAbsorbed: priced.shippingIncreasedAbsorbed,
      courierName: priced.shippingSnapshot.courierName,
      courierCompanyId: priced.shippingSnapshot.courierCompanyId,
      estimatedDays: priced.shippingSnapshot.estimatedDays,
      quotedMock: Boolean(priced.shipMeta?.mock),
      package: {
        totalWeightKg: priced.weightSnapshot?.totalWeightKg ?? null,
        totalDimWeightKg: priced.weightSnapshot?.totalDimWeightKg ?? null,
        dims: priced.weightSnapshot?.dims || null
      }
    },
    lineOverrides: overrides,
    commit: false
  };

  if (!opts.commit) {
    return { success: true, preview };
  }

  // Totals unchanged for customer (same items + locked ship). Only package + admin quote update.
  syncCustomerDeliveryChargesToLock(order);
  applyAdminQuotedDelivery(order, priced.quotedDelivery);
  order.shippingSnapshot = {
    ...(order.shippingSnapshot && typeof order.shippingSnapshot.toObject === 'function'
      ? order.shippingSnapshot.toObject()
      : order.shippingSnapshot || {}),
    ...priced.shippingSnapshot
  };
  order.shippingWeightSnapshot = priced.weightSnapshot;
  order.markModified('shippingSnapshot');
  order.markModified('shippingWeightSnapshot');

  order.adminEditHistory = order.adminEditHistory || [];
  order.adminEditHistory.push({
    action: 'pending_order_shipping_metrics_edited',
    note: 'Admin corrected package weight/dimensions; customer shipping stayed locked at checkout',
    performedBy: opts.adminUserId || null,
    createdAt: new Date(),
    before: beforeMoney,
    after: snapshotMoney(order),
    metadata: {
      lineOverrides: overrides,
      shipping: preview.shipping,
      packageBefore: {
        totalWeightKg: beforeSnap.totalWeightKg,
        totalDimWeightKg: beforeSnap.totalDimWeightKg,
        dims: beforeSnap.dims
      },
      packageAfter: preview.shipping.package
    }
  });
  order.markModified('adminEditHistory');

  await order.save();

  logger.info('[adminPendingShippingMetrics] applied', {
    orderId,
    adminUserId: opts.adminUserId || null,
    overrideCount: overrides.length,
    checkoutDeliveryCharges: getCheckoutDeliveryCharges(order),
    adminQuotedDeliveryInr: order.adminQuotedDeliveryInr,
    totalWeightKg: order.shippingWeightSnapshot?.totalWeightKg
  });

  return {
    success: true,
    committed: true,
    orderId,
    shipping: preview.shipping,
    shippingWeightSnapshot: order.shippingWeightSnapshot,
    checkoutDeliveryCharges: getCheckoutDeliveryCharges(order),
    adminQuotedDeliveryInr: order.adminQuotedDeliveryInr,
    adminShippingDeltaInr: order.adminShippingDeltaInr,
    deliveryCharges: order.deliveryCharges,
    totalAmount: order.totalAmount
  };
}

module.exports = {
  previewOrApplyShippingMetricsEdit,
  normalizeLineOverrides,
  ensureOrderWeightSnapshot
};

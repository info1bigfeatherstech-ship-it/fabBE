/**
 * Admin pending-order shipping metrics edit.
 *
 * Modes:
 * 1) packageOverride — packed-box total weight/dims (recommended for multi-item packs)
 * 2) lineOverrides — per-item weight/dims (rebuild package from lines)
 *
 * - Re-quotes courier for admin/ops (adminQuotedDeliveryInr)
 * - Never changes customer checkout shipping
 * - shippingWeightSnapshot is what Shiprocket/Shipmozo createShipment uses
 */

const Order = require('../models/Order');
const logger = require('../utils/logger');
const { roundMoney2 } = require('./checkoutComputation.service');
const {
  validateLineShippingOverride,
  applyLineShippingOverridesToSnapshot,
  applyPackageShippingOverrideToSnapshot,
  validatePackageShippingOverride,
  rebuildShippingWeightSnapshotFromLines,
  enrichShippingWeightSnapshotDims,
  buildShippingWeightSnapshotFromOrderItems,
  hasPackageOverride,
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

function normalizePackageOverride(raw) {
  if (!raw || typeof raw !== 'object') {
    throw createEditError(400, 'PACKAGE_OVERRIDE_REQUIRED', 'packageOverride is required');
  }
  const checked = validatePackageShippingOverride(raw);
  if (!checked.ok) {
    throw createEditError(400, 'PACKAGE_OVERRIDE_INVALID', 'Invalid packageOverride', {
      errors: checked.errors
    });
  }
  return checked.data;
}

async function ensureOrderWeightSnapshot(order) {
  let snap = order.shippingWeightSnapshot;
  const priorPackageOverride = hasPackageOverride(snap) ? { ...snap.packageOverride } : null;

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

  const itemQtyByKey = new Map();
  for (const it of order.items || []) {
    const pid = idStr(it.productId);
    const vid = idStr(it.variantId);
    const key = lineKey(pid, vid);
    if (!pid || !vid) continue;
    itemQtyByKey.set(key, Math.max(0, Number(it.quantity) || 0));
  }

  const alignedByKey = new Map();
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

  let baseSnap;
  if (missingKeys.length || alignedByKey.size === 0) {
    snap = await buildShippingWeightSnapshotFromOrderItems(order);
    if (!snap?.lines?.length) {
      throw createEditError(400, 'SNAPSHOT_MISSING', 'Could not build shipping weight lines');
    }
    const rebuiltLines = (snap.lines || [])
      .map((row) => {
        const key = lineKey(row.productId, row.variantId);
        const qty = itemQtyByKey.has(key)
          ? itemQtyByKey.get(key)
          : Math.max(0, Number(row.quantity) || 0);
        return {
          ...row,
          productId: idStr(row.productId) || row.productId,
          variantId: idStr(row.variantId) || row.variantId,
          quantity: qty
        };
      })
      .filter((row) => itemQtyByKey.has(lineKey(row.productId, row.variantId)));

    if (!rebuiltLines.length) {
      throw createEditError(
        400,
        'SNAPSHOT_MISSING',
        'Order items could not be matched to shipping weight lines'
      );
    }
    baseSnap = rebuildShippingWeightSnapshotFromLines(rebuiltLines, {
      source: snap.source || 'catalog_fallback'
    });
  } else {
    baseSnap = rebuildShippingWeightSnapshotFromLines([...alignedByKey.values()], {
      source: snap.source || 'checkout'
    });
  }

  // Preserve prior packed-box override on the aligned base (until admin replaces it).
  if (priorPackageOverride) {
    const restored = applyPackageShippingOverrideToSnapshot(baseSnap, priorPackageOverride, {
      adminUserId: priorPackageOverride.overriddenBy || null
    });
    if (restored.ok) {
      restored.snapshot.packageOverride = {
        ...restored.snapshot.packageOverride,
        overriddenAt: priorPackageOverride.overriddenAt || restored.snapshot.packageOverride.overriddenAt,
        overriddenBy: priorPackageOverride.overriddenBy || null
      };
      return restored.snapshot;
    }
  }

  return baseSnap;
}

/**
 * @param {{
 *   orderId: string,
 *   lineOverrides?: Array,
 *   packageOverride?: object,
 *   commit?: boolean,
 *   adminUserId?: string|null,
 *   scopeMatch?: object
 * }} opts
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

  const hasPackage = opts.packageOverride != null && typeof opts.packageOverride === 'object';
  const hasLines = Array.isArray(opts.lineOverrides) && opts.lineOverrides.length > 0;
  if (hasPackage && hasLines) {
    throw createEditError(
      400,
      'OVERRIDE_MODE_CONFLICT',
      'Send either packageOverride (full packed box) or lineOverrides (per item), not both'
    );
  }
  if (!hasPackage && !hasLines) {
    throw createEditError(
      400,
      'OVERRIDES_REQUIRED',
      'Provide packageOverride or lineOverrides'
    );
  }

  const beforeSnap = await ensureOrderWeightSnapshot(order);
  const beforeMoney = snapshotMoney(order);
  const lockedBefore = ensureCheckoutDeliveryFrozen(order);

  let applied;
  let mode;
  let lineOverrides = null;
  let packageOverride = null;

  if (hasPackage) {
    packageOverride = normalizePackageOverride(opts.packageOverride);
    applied = applyPackageShippingOverrideToSnapshot(beforeSnap, packageOverride, {
      adminUserId: opts.adminUserId || null
    });
    mode = 'package';
  } else {
    lineOverrides = normalizeLineOverrides(opts.lineOverrides);
    applied = applyLineShippingOverridesToSnapshot(beforeSnap, lineOverrides, {
      adminUserId: opts.adminUserId || null
    });
    mode = 'lines';
  }

  if (!applied.ok) {
    throw createEditError(400, applied.code || 'OVERRIDE_FAILED', applied.message || 'Override failed', {
      errors: applied.errors
    });
  }

  const nextSnap = applied.snapshot;
  const priced = await repriceShippingForItems(order, order.items || [], {
    weightSnapshot: nextSnap
  });

  const preview = {
    orderId,
    mode,
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
        dims: priced.weightSnapshot?.dims || null,
        packageOverrideApplied: Boolean(priced.weightSnapshot?.packageOverride)
      }
    },
    lineOverrides,
    packageOverride,
    commit: false
  };

  if (!opts.commit) {
    return { success: true, preview };
  }

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
    action:
      mode === 'package'
        ? 'pending_order_package_metrics_edited'
        : 'pending_order_shipping_metrics_edited',
    note:
      mode === 'package'
        ? 'Admin set packed-box weight/dimensions; item lines kept as reference; customer shipping locked'
        : 'Admin corrected per-item weight/dimensions; customer shipping stayed locked at checkout',
    performedBy: opts.adminUserId || null,
    createdAt: new Date(),
    before: beforeMoney,
    after: snapshotMoney(order),
    metadata: {
      mode,
      lineOverrides,
      packageOverride,
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
    mode,
    adminUserId: opts.adminUserId || null,
    checkoutDeliveryCharges: getCheckoutDeliveryCharges(order),
    adminQuotedDeliveryInr: order.adminQuotedDeliveryInr,
    totalWeightKg: order.shippingWeightSnapshot?.totalWeightKg
  });

  return {
    success: true,
    committed: true,
    orderId,
    mode,
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
  normalizePackageOverride,
  ensureOrderWeightSnapshot
};

/**
 * Admin pending-order delivery address / recipient-name edit (before accept / courier create).
 *
 * Safety:
 * - Only `pending` orders without courier shipment refs
 * - Phone stays frozen from existing addressSnapshot
 * - Recipient name may be edited (max 3 words, 50 chars) on THIS order snapshot only
 * - Name-only edits never re-quote shipping and never change totals/refunds
 * - Physical address edits re-quote shipping (never increase customer delivery)
 * - Optionally updates linked Address doc only when it belongs to the same order.userId
 */

const Order = require('../models/Order');
const Address = require('../models/Address');
const logger = require('../utils/logger');
const { roundMoney2 } = require('./checkoutComputation.service');
const { validatePhysicalAddressForSave } = require('../utils/addressValidation');
const { normalizePersonName, parsePersonName } = require('../utils/personName');
const { computeLocalAddressQuality } = require('./addressIntelligence.service');
const {
  assertEditablePendingOrder,
  createEditError,
  repriceShippingForItems,
  settleFinancials,
  attemptAmendmentRefund,
  snapshotMoney
} = require('./adminPendingOrderEdit.service');
const { notifyOrderAmended } = require('./orderAmendmentNotification.service');

const EDITABLE_ADDRESS_FIELDS = Object.freeze([
  'houseNumber',
  'building',
  'floor',
  'area',
  'landmark',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country'
]);

const EDITABLE_CONTACT_FIELDS = Object.freeze(['fullName']);
const FROZEN_CONTACT_FIELDS = Object.freeze(['phone']);

function pickEditableAddressPatch(body) {
  const src = body && typeof body === 'object' ? body : {};
  const patch = {};
  for (const key of EDITABLE_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      patch[key] = src[key];
    }
  }
  return patch;
}

function pickRecipientNamePatch(body) {
  const src = body && typeof body === 'object' ? body : {};
  if (!Object.prototype.hasOwnProperty.call(src, 'fullName')) return {};
  return { fullName: src.fullName };
}

function resolveRecipientName(snapshot, namePatch) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const beforeName = normalizePersonName(snap.fullName || snap.name);

  if (!Object.prototype.hasOwnProperty.call(namePatch, 'fullName')) {
    return { nextName: String(snap.fullName || snap.name || '').trim(), nameChanged: false, beforeName };
  }

  const parsed = parsePersonName(namePatch.fullName);
  if (!parsed.ok) {
    throw createEditError(400, parsed.code || 'INVALID_NAME', parsed.message, {
      errors: [{ field: 'fullName', code: parsed.code, message: parsed.message }]
    });
  }

  return {
    nextName: parsed.value,
    nameChanged: parsed.value !== beforeName,
    beforeName
  };
}

function applyRecipientNameToSnapshot(snapshot, nextName) {
  const next = snapshot && typeof snapshot === 'object' ? { ...snapshot } : {};
  next.fullName = nextName;
  next.name = nextName;
  return next;
}

function buildMergedAddressCandidate(snapshot, patch, namePatch = {}) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const next = { ...snap };
  for (const key of EDITABLE_ADDRESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      next[key] = patch[key];
    }
  }
  next.phone = snap.phone;
  if (Object.prototype.hasOwnProperty.call(namePatch, 'fullName')) {
    next.fullName = namePatch.fullName;
  } else {
    next.fullName = snap.fullName;
  }
  return next;
}

function formatAddressLines(addr) {
  return [
    addr.houseNumber,
    addr.building,
    addr.floor,
    addr.addressLine1,
    addr.addressLine2,
    addr.area,
    addr.landmark,
    addr.city,
    addr.state,
    addr.postalCode,
    addr.country
  ]
    .filter(Boolean)
    .join(', ');
}

function frozenPhone(snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return String(snap.phone || '').replace(/\D/g, '').slice(-10) || snap.phone;
}

function unchangedShippingPreview(order, beforeMoney) {
  const ship = order.shippingSnapshot || {};
  const delivery = roundMoney2(Number(beforeMoney.deliveryCharges) || 0);
  return {
    oldDelivery: delivery,
    quotedDelivery: delivery,
    customerDelivery: delivery,
    shippingIncreasedAbsorbed: false,
    courierName: ship.courierName || null,
    courierCompanyId: ship.courierCompanyId || null,
    estimatedDays: ship.estimatedDays || null,
    requoted: false
  };
}

async function updateSavedAddressBook({
  order,
  orderId,
  alsoUpdateSavedAddress,
  physicalData,
  nextName,
  nameChanged
}) {
  if (!alsoUpdateSavedAddress) return false;
  try {
    const addressId = order.address;
    if (!addressId) return false;
    const saved = await Address.findById(addressId);
    if (!saved) return false;
    if (String(saved.userId) !== String(order.userId)) {
      logger.warn('[adminPendingAddressEdit] skipped Address book update — userId mismatch', {
        orderId,
        orderUserId: String(order.userId),
        addressUserId: String(saved.userId)
      });
      return false;
    }
    if (physicalData) {
      for (const key of EDITABLE_ADDRESS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(physicalData, key)) {
          saved[key] = physicalData[key];
        }
      }
    }
    if (nameChanged) {
      saved.fullName = nextName;
    }
    await saved.save();
    return true;
  } catch (err) {
    logger.error('[adminPendingAddressEdit] Address book update failed', {
      orderId,
      message: err.message
    });
    return false;
  }
}

async function previewOrApplyNameOnlyEdit({
  order,
  orderId,
  nextName,
  beforeSnap,
  beforeMoney,
  commit,
  alsoUpdateSavedAddress,
  adminUserId
}) {
  const nextSnapshot = applyRecipientNameToSnapshot(beforeSnap, nextName);
  nextSnapshot.phone = frozenPhone(beforeSnap);

  const shipping = unchangedShippingPreview(order, beforeMoney);
  const localQuality = computeLocalAddressQuality(nextSnapshot);
  const preview = {
    orderId,
    nameOnly: true,
    shippingRequoted: false,
    before: {
      ...beforeMoney,
      address: formatAddressLines(beforeSnap),
      contactFrozen: {
        fullName: beforeSnap.fullName || beforeSnap.name || null,
        phone: beforeSnap.phone || null
      }
    },
    after: {
      subtotal: beforeMoney.subtotal,
      deliveryCharges: beforeMoney.deliveryCharges,
      tax: beforeMoney.tax,
      discount: beforeMoney.discount,
      totalAmount: beforeMoney.totalAmount,
      amountPaidInr: beforeMoney.amountPaidInr,
      balanceDueInr: beforeMoney.balanceDueInr,
      paymentStatus: beforeMoney.paymentStatus,
      address: formatAddressLines(nextSnapshot),
      addressSnapshot: nextSnapshot,
      contactFrozen: {
        fullName: nextSnapshot.fullName || null,
        phone: nextSnapshot.phone || null
      },
      localAddressQuality: localQuality
    },
    refundInr: 0,
    shipping,
    alsoUpdateSavedAddress: Boolean(alsoUpdateSavedAddress),
    commit: false
  };

  if (!commit) {
    return { success: true, preview };
  }

  order.addressSnapshot = nextSnapshot;
  order.markModified('addressSnapshot');

  const noteMessage = 'The recipient name on your order was updated by our team.';
  order.customerNotes = Array.isArray(order.customerNotes) ? order.customerNotes : [];
  order.customerNotes.push({
    kind: 'recipient_name_updated',
    message: noteMessage,
    createdAt: new Date(),
    metadata: {
      previousName: beforeSnap.fullName || beforeSnap.name || null,
      nextName,
      shippingRequoted: false,
      adminUserId: adminUserId || null
    }
  });
  order.markModified('customerNotes');

  await order.save();

  const savedAddressUpdated = await updateSavedAddressBook({
    order,
    orderId,
    alsoUpdateSavedAddress,
    physicalData: null,
    nextName,
    nameChanged: true
  });

  try {
    await notifyOrderAmended(order, noteMessage, {
      refundInr: 0,
      newTotal: order.totalAmount,
      cancelledEmpty: false
    });
  } catch (notifyErr) {
    logger.warn('[adminPendingAddressEdit] name-only notify failed', { message: notifyErr.message });
  }

  return {
    success: true,
    orderId,
    nameOnly: true,
    shippingRequoted: false,
    refundInr: 0,
    refundWarning: null,
    shipping,
    addressSnapshot: nextSnapshot,
    localAddressQuality: localQuality,
    savedAddressUpdated,
    paymentStatus: order.paymentStatus,
    totalAmount: order.totalAmount,
    deliveryCharges: order.deliveryCharges
  };
}

/**
 * @param {{
 *   orderId: string,
 *   addressPatch: object,
 *   commit: boolean,
 *   alsoUpdateSavedAddress?: boolean,
 *   adminUserId?: string|null
 * }} opts
 */
async function previewOrApplyPendingAddressEdit(opts) {
  const orderId = String(opts.orderId || '').trim();
  if (!orderId) {
    throw createEditError(400, 'ORDER_ID_REQUIRED', 'orderId is required');
  }

  const { mergeOrderScopeFilter } = require('../utils/adminOrderScope');
  const order = await Order.findOne(mergeOrderScopeFilter({ orderId }, opts.scopeMatch || null));
  assertEditablePendingOrder(order);

  const physicalPatch = pickEditableAddressPatch(opts.addressPatch);
  const namePatch = pickRecipientNamePatch(opts.addressPatch);
  const addressChanged = Object.keys(physicalPatch).length > 0;
  const nameProvided = Object.prototype.hasOwnProperty.call(namePatch, 'fullName');

  if (!addressChanged && !nameProvided) {
    throw createEditError(
      400,
      'ADDRESS_PATCH_REQUIRED',
      'Provide at least one editable field (address or recipient name).'
    );
  }

  const beforeSnap =
    order.addressSnapshot && typeof order.addressSnapshot === 'object'
      ? { ...order.addressSnapshot }
      : {};
  const beforeMoney = snapshotMoney(order);
  const { nextName, nameChanged } = resolveRecipientName(beforeSnap, namePatch);

  if (!addressChanged && !nameChanged) {
    throw createEditError(400, 'NO_CHANGES', 'No address or name changes to apply.');
  }

  if (!addressChanged && nameChanged) {
    return previewOrApplyNameOnlyEdit({
      order,
      orderId,
      nextName,
      beforeSnap,
      beforeMoney,
      commit: Boolean(opts.commit),
      alsoUpdateSavedAddress: Boolean(opts.alsoUpdateSavedAddress),
      adminUserId: opts.adminUserId || null
    });
  }

  const mergedRaw = buildMergedAddressCandidate(beforeSnap, physicalPatch, nameChanged ? { fullName: nextName } : {});
  const validated = validatePhysicalAddressForSave({
    ...mergedRaw,
    fullName: nextName || beforeSnap.fullName,
    phone: beforeSnap.phone
  }, { skipPersonNameRules: !nameChanged });
  if (!validated.ok) {
    throw createEditError(400, validated.code || 'ADDRESS_VALIDATION_FAILED', validated.message, {
      errors: validated.errors
    });
  }

  let nextSnapshot = {
    ...beforeSnap,
    ...validated.data,
    phone: frozenPhone(beforeSnap)
  };
  nextSnapshot = applyRecipientNameToSnapshot(nextSnapshot, nameChanged ? nextName : (beforeSnap.fullName || nextSnapshot.fullName));
  nextSnapshot.phone = frozenPhone(beforeSnap);

  const previousSnapshot = order.addressSnapshot;
  order.addressSnapshot = nextSnapshot;
  let priced;
  try {
    priced = await repriceShippingForItems(order, order.items || []);
  } finally {
    order.addressSnapshot = previousSnapshot;
  }

  const settlement = settleFinancials(order, priced.totalAmount);
  const localQuality = computeLocalAddressQuality(nextSnapshot);

  const preview = {
    orderId,
    nameOnly: false,
    shippingRequoted: true,
    before: {
      ...beforeMoney,
      address: formatAddressLines(beforeSnap),
      contactFrozen: {
        fullName: beforeSnap.fullName || beforeSnap.name || null,
        phone: beforeSnap.phone || null
      }
    },
    after: {
      subtotal: priced.subtotal,
      deliveryCharges: priced.customerDelivery,
      tax: priced.tax,
      discount: priced.discount,
      totalAmount: priced.totalAmount,
      amountPaidInr: settlement.amountPaidInr,
      balanceDueInr: settlement.balanceDueInr,
      paymentStatus: settlement.paymentStatus,
      address: formatAddressLines(nextSnapshot),
      addressSnapshot: nextSnapshot,
      contactFrozen: {
        fullName: nextSnapshot.fullName || null,
        phone: nextSnapshot.phone || null
      },
      localAddressQuality: localQuality
    },
    refundInr: settlement.refundInr,
    shipping: {
      oldDelivery: priced.oldDelivery,
      quotedDelivery: priced.quotedDelivery,
      customerDelivery: priced.customerDelivery,
      shippingIncreasedAbsorbed: priced.shippingIncreasedAbsorbed,
      courierName: priced.shippingSnapshot.courierName,
      courierCompanyId: priced.shippingSnapshot.courierCompanyId,
      estimatedDays: priced.shippingSnapshot.estimatedDays,
      requoted: true
    },
    alsoUpdateSavedAddress: Boolean(opts.alsoUpdateSavedAddress),
    commit: false
  };

  if (!opts.commit) {
    return { success: true, preview };
  }

  order.addressSnapshot = nextSnapshot;
  order.markModified('addressSnapshot');
  order.subtotal = priced.subtotal;
  order.deliveryCharges = priced.customerDelivery;
  order.tax = priced.tax;
  order.discount = priced.discount;
  order.totalAmount = priced.totalAmount;
  order.shippingSnapshot = priced.shippingSnapshot;
  order.shippingWeightSnapshot = priced.weightSnapshot;
  order.markModified('shippingSnapshot');
  order.markModified('shippingWeightSnapshot');

  const priorPaymentStatus = order.paymentStatus;
  const refundOutcome = await attemptAmendmentRefund(
    order,
    settlement.refundInr,
    `Address update on order ${orderId}`
  );

  if (settlement.refundInr > 0.005 && refundOutcome.warning) {
    order.paymentStatus = priorPaymentStatus === 'partially_paid' ? 'partially_paid' : 'paid';
    order.paymentInfo = order.paymentInfo || {};
    order.paymentInfo.amendmentRefundFailureReason = refundOutcome.warning;
    order.markModified('paymentInfo');
  } else if (settlement.refundInr > 0.005 && refundOutcome.refund) {
    order.amountPaidInr = settlement.amountPaidInr;
    order.balanceDueInr = 0;
    order.paymentStatus = 'paid';
  } else {
    order.amountPaidInr = settlement.amountPaidInr;
    order.balanceDueInr = settlement.balanceDueInr;
    order.paymentStatus = settlement.paymentStatus;
  }

  const noteMessage =
    settlement.refundInr > 0.005
      ? `Your delivery address was updated by our team for accurate shipping. A refund of ₹${settlement.refundInr.toFixed(2)} was processed for any reduced charges.`
      : 'Your delivery address was updated by our team for accurate shipping.';

  order.customerNotes = Array.isArray(order.customerNotes) ? order.customerNotes : [];
  order.customerNotes.push({
    kind: 'address_updated',
    message: noteMessage,
    createdAt: new Date(),
    metadata: {
      refundInr: settlement.refundInr,
      shipping: preview.shipping,
      nameChanged
    }
  });
  order.markModified('customerNotes');

  await order.save();

  const savedAddressUpdated = await updateSavedAddressBook({
    order,
    orderId,
    alsoUpdateSavedAddress: Boolean(opts.alsoUpdateSavedAddress),
    physicalData: validated.data,
    nextName,
    nameChanged
  });

  try {
    await notifyOrderAmended(order, noteMessage, {
      refundInr: settlement.refundInr,
      newTotal: order.totalAmount,
      cancelledEmpty: false
    });
  } catch (notifyErr) {
    logger.warn('[adminPendingAddressEdit] notify failed', { message: notifyErr.message });
  }

  return {
    success: true,
    orderId,
    nameOnly: false,
    shippingRequoted: true,
    refundInr: settlement.refundInr,
    refundWarning: refundOutcome.warning,
    shipping: preview.shipping,
    addressSnapshot: nextSnapshot,
    localAddressQuality: localQuality,
    savedAddressUpdated,
    paymentStatus: order.paymentStatus,
    totalAmount: order.totalAmount,
    deliveryCharges: order.deliveryCharges
  };
}

module.exports = {
  EDITABLE_ADDRESS_FIELDS,
  EDITABLE_CONTACT_FIELDS,
  FROZEN_CONTACT_FIELDS,
  previewOrApplyPendingAddressEdit,
  pickEditableAddressPatch,
  pickRecipientNamePatch,
  buildMergedAddressCandidate
};

/**
 * Shipmozo Ship Now — production flow:
 * 1) Prefer checkout quoted courier via assign-courier (Shipmozo source of truth)
 * 2) Do NOT block on a secondary rate-calculator pre-check (can be empty/mismatched
 *    while the courier is still bookable on the pushed order in Shipmozo panel)
 * 3) On assign failure → load rates for substitute suggestions (≤ quoted freight preferred)
 *    — always exclude the failed/quoted courier ID so it is never re-suggested
 * 4) confirmSubstitute / courierId override → assign chosen alternative; on assign
 *    failure, try next cheapest alternatives (bounded) without re-using failed IDs
 *
 * Shiprocket orders never enter this module (caller routes by isShipmozoOrder).
 */

const Order = require('../models/Order');
const ShipmozoService = require('../utils/shipmozo');
const logger = require('../utils/logger');
const { SHIPPING_PROVIDERS } = require('../constants/shippingProviders');

/** Cap API hammering if rate list is large / many assign failures. */
const MAX_SUBSTITUTE_ASSIGN_ATTEMPTS = 5;

function quotedCourierFromOrder(order) {
  const snap = order?.shippingSnapshot || {};
  const fromSnap =
    snap.shipmozoCourierId != null && Number.isFinite(Number(snap.shipmozoCourierId))
      ? Number(snap.shipmozoCourierId)
      : snap.courierCompanyId != null && Number.isFinite(Number(snap.courierCompanyId))
        ? Number(snap.courierCompanyId)
        : null;
  const fromAssigned =
    order?.shipmentInfo?.assignedCourierId != null &&
    Number.isFinite(Number(order.shipmentInfo.assignedCourierId))
      ? Number(order.shipmentInfo.assignedCourierId)
      : null;
  return {
    courierId: fromSnap || fromAssigned,
    courierName: String(snap.courierName || '').trim() || null,
    pickupsAutomaticallyScheduled:
      snap.pickupsAutomaticallyScheduled != null
        ? Boolean(snap.pickupsAutomaticallyScheduled)
        : null
  };
}

function quotedFreightInr(order) {
  const snap = order?.shippingSnapshot || {};
  const n = Number(
    snap.freightInr != null
      ? snap.freightInr
      : order?.deliveryFreightInr != null
        ? order.deliveryFreightInr
        : snap.deliveryCharges != null
          ? snap.deliveryCharges
          : snap.shippingCharges != null
            ? snap.shippingCharges
            : order?.deliveryCharges
  );
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isCodOrder(order) {
  return String(order?.paymentInfo?.method || order?.paymentMethod || '')
    .toLowerCase()
    .trim() === 'cod';
}

function mapCourierPublic(c) {
  return {
    courierId: c.courierId,
    courierName: c.courierName,
    totalCharges: c.totalCharges,
    estimatedDays: c.estimatedDays
  };
}

function normalizeExcludeCourierIds(excludeCourierIds) {
  const out = new Set();
  if (excludeCourierIds == null) return out;
  const list = excludeCourierIds instanceof Set
    ? [...excludeCourierIds]
    : Array.isArray(excludeCourierIds)
      ? excludeCourierIds
      : [excludeCourierIds];
  for (const id of list) {
    if (id == null || id === '') continue;
    const n = Number(id);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

/**
 * Prefer cheapest courier with totalCharges <= maxCharge; else overall cheapest.
 * Always skips IDs in excludeCourierIds (failed / quoted courier that already failed assign).
 *
 * @param {Array<object>} available
 * @param {{ codRequired?: boolean, maxCharge?: number|null, excludeCourierIds?: Iterable<number>|number|null }} [opts]
 */
function pickSubstituteCourier(available, { codRequired = false, maxCharge = null, excludeCourierIds = null } = {}) {
  const list = Array.isArray(available) ? available : [];
  const exclude = normalizeExcludeCourierIds(excludeCourierIds);
  let pool = list.filter(
    (c) =>
      c.courierId != null &&
      Number.isFinite(Number(c.courierId)) &&
      Number.isFinite(Number(c.totalCharges)) &&
      !exclude.has(Number(c.courierId))
  );
  if (codRequired) {
    const codPool = pool.filter((c) => c.codAvailable !== false);
    if (codPool.length) pool = codPool;
  }
  if (!pool.length) return null;

  if (maxCharge != null && Number.isFinite(Number(maxCharge))) {
    const cap = Number(maxCharge) + 0.05;
    const under = pool.filter((c) => Number(c.totalCharges) <= cap);
    if (under.length) {
      under.sort((a, b) => a.totalCharges - b.totalCharges);
      return under[0];
    }
  }

  pool.sort((a, b) => a.totalCharges - b.totalCharges);
  return pool[0];
}

function resolveShipmozoAssignOrderId(order) {
  // Prefer IDs Shipmozo knows from push-order; our marketplace orderId is what we pushed as order_id.
  const si = order?.shipmentInfo || {};
  return String(
    si.shipmozoOrderId || order?.orderId || si.shipmentId || si.shipmozoReferenceId || ''
  ).trim();
}

async function loadLiveRatesSafe(order) {
  try {
    const rates = await ShipmozoService.listCouriersForOrder(order);
    const couriers = Array.isArray(rates?.couriers) ? rates.couriers : [];
    if (!couriers.length) {
      logger.warn('[Shipmozo] listCouriersForOrder returned no couriers', {
        orderId: order?.orderId,
        ok: rates?.ok,
        message: rates?.message || null,
        paymentHint: rates?.paymentType || null,
        weightGrams: rates?.weightGrams || null
      });
    }
    return {
      ok: Boolean(rates?.ok),
      couriers,
      message: rates?.message || null,
      raw: rates?.raw || null
    };
  } catch (err) {
    logger.error('[Shipmozo] listCouriersForOrder threw', {
      orderId: order?.orderId,
      message: err.message,
      stack: err.stack
    });
    return { ok: false, couriers: [], message: err.message || 'Rate lookup failed', raw: null };
  }
}

function noSubstitutePayload({ quoted, available, assignMessage, details }) {
  const qLabel = quoted?.courierName || quoted?.courierId || 'checkout courier';
  return {
    success: false,
    code: 'NO_SUBSTITUTE_COURIER',
    message:
      (assignMessage
        ? `${assignMessage} `
        : `Could not assign checkout courier "${qLabel}". `) +
      'No other courier is available via API for this route — assign from the Shipmozo panel. Customer order total is not changed.',
    quotedCourier: quoted?.courierId
      ? { courierId: quoted.courierId, courierName: quoted.courierName }
      : null,
    suggestedCourier: null,
    availableCouriers: (available || []).slice(0, 15).map(mapCourierPublic),
    details: details || null
  };
}

/**
 * @param {import('mongoose').Document} order
 * @param {object} opts
 * @param {number|null} [opts.courierIdOverride]
 * @param {boolean} [opts.confirmSubstitute]
 * @param {function} opts.applyUpsertShipmentInfo
 * @param {function} [opts.evaluateAndPersistShipmentOps]
 */
async function runShipmozoAssignShip(order, opts = {}) {
  const {
    courierIdOverride = null,
    confirmSubstitute = false,
    applyUpsertShipmentInfo,
    evaluateAndPersistShipmentOps
  } = opts;

  try {
    if (!order) {
      return { success: false, code: 'ORDER_REQUIRED', message: 'Order is required.' };
    }

    if (order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber) {
      return {
        success: false,
        code: 'AWB_ALREADY_ASSIGNED',
        message: 'AWB already assigned for this order.'
      };
    }

    const smOrderId = resolveShipmozoAssignOrderId(order);
    if (!smOrderId) {
      return {
        success: false,
        code: 'SHIPMENT_ID_MISSING',
        message: 'Push order to Shipmozo first (missing shipmozo order id).'
      };
    }

    const quoted = quotedCourierFromOrder(order);
    const freightCap = quotedFreightInr(order);
    const codRequired = isCodOrder(order);
    let hasOverride =
      courierIdOverride != null && Number.isFinite(Number(courierIdOverride));

    // Admin confirmed substitute but UI sent the same failed quoted ID — treat as "pick any other".
    if (
      confirmSubstitute &&
      hasOverride &&
      quoted.courierId != null &&
      Number(courierIdOverride) === Number(quoted.courierId)
    ) {
      logger.info('[Shipmozo] Ignoring override that matches failed quoted courier', {
        orderId: order.orderId,
        courierIdOverride: Number(courierIdOverride)
      });
      hasOverride = false;
    }

    let available = [];
    let ratesLoaded = false;

    const ensureRates = async () => {
      if (ratesLoaded) return available;
      const rates = await loadLiveRatesSafe(order);
      available = rates.couriers;
      ratesLoaded = true;
      return available;
    };

    const pickSuggestion = (excludeCourierIds) => {
      const picked = pickSubstituteCourier(available, {
        codRequired,
        maxCharge: freightCap,
        excludeCourierIds
      });
      if (!picked) return null;
      return {
        courierId: picked.courierId,
        courierName: picked.courierName,
        totalCharges: picked.totalCharges,
        estimatedDays: picked.estimatedDays
      };
    };

    // ── Path: no override — try checkout courier FIRST (do not rate-gate) ──
    if (!hasOverride && quoted.courierId != null && !confirmSubstitute) {
      logger.info('[Shipmozo] Ship now: assign quoted courier first', {
        orderId: order.orderId,
        smOrderId,
        quotedCourierId: quoted.courierId,
        quotedCourierName: quoted.courierName
      });

      const direct = await ShipmozoService.assignCourier({
        orderId: smOrderId,
        courierId: Number(quoted.courierId)
      });

      if (direct.success) {
        return finalizeShipmozoAssign({
          order,
          smOrderId,
          targetCourierId: Number(quoted.courierId),
          quoted,
          available: [],
          assign: direct,
          substituted: false,
          substituteMeta: null,
          applyUpsertShipmentInfo,
          evaluateAndPersistShipmentOps
        });
      }

      await ensureRates();
      const excludeQuoted = [quoted.courierId];
      const suggested = pickSuggestion(excludeQuoted);

      logger.warn('[Shipmozo] Quoted assign failed; offering substitute', {
        orderId: order.orderId,
        quotedCourierId: quoted.courierId,
        assignMessage: direct.message,
        rateCount: available.length,
        suggestedCourierId: suggested?.courierId || null
      });

      if (!suggested) {
        return noSubstitutePayload({
          quoted,
          available,
          assignMessage: direct.message,
          details: direct.raw || null
        });
      }

      return {
        success: false,
        code: 'QUOTED_COURIER_UNAVAILABLE',
        message:
          direct.message ||
          `Could not assign checkout courier "${quoted.courierName || quoted.courierId}". Confirm a substitute courier, or assign from the Shipmozo panel.`,
        quotedCourier: {
          courierId: quoted.courierId,
          courierName: quoted.courierName
        },
        suggestedCourier: suggested,
        availableCouriers: available.slice(0, 15).map(mapCourierPublic),
        details: direct.raw || null
      };
    }

    // ── Path: admin confirmed substitute / no quoted / override ─────────────
    await ensureRates();

    const failedIds = normalizeExcludeCourierIds(
      confirmSubstitute && quoted.courierId != null ? [quoted.courierId] : []
    );

    if (!hasOverride && quoted.courierId == null && !confirmSubstitute) {
      const suggested = pickSuggestion(failedIds);
      if (!suggested) {
        return {
          success: false,
          code: 'NO_QUOTED_COURIER',
          message:
            'No checkout courier on this order and no Shipmozo rates returned. Retry shortly or assign from the Shipmozo panel.',
          quotedCourier: null,
          suggestedCourier: null,
          availableCouriers: []
        };
      }
      return {
        success: false,
        code: 'QUOTED_COURIER_UNAVAILABLE',
        message:
          'No checkout courier was stored on this order. Confirm to assign the cheapest available Shipmozo courier, or pass courierId.',
        quotedCourier: null,
        suggestedCourier: suggested,
        availableCouriers: available.slice(0, 15).map(mapCourierPublic)
      };
    }

    if (!hasOverride && !confirmSubstitute) {
      return {
        success: false,
        code: 'COURIER_ID_REQUIRED',
        message: 'courierId is required to assign on Shipmozo.'
      };
    }

    // Build ordered candidate list: preferred override first, then cheapest alternatives.
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (id) => {
      const n = Number(id);
      if (!Number.isFinite(n) || failedIds.has(n) || seen.has(n)) return;
      seen.add(n);
      candidates.push(n);
    };

    if (hasOverride) pushCandidate(courierIdOverride);

    // Seed remaining pool by repeatedly picking cheapest under exclude set
    const seedExclude = new Set(failedIds);
    if (hasOverride) seedExclude.add(Number(courierIdOverride));
    for (let i = 0; i < MAX_SUBSTITUTE_ASSIGN_ATTEMPTS; i++) {
      const next = pickSubstituteCourier(available, {
        codRequired,
        maxCharge: freightCap,
        excludeCourierIds: seedExclude
      });
      if (!next) break;
      pushCandidate(next.courierId);
      seedExclude.add(Number(next.courierId));
    }

    if (!candidates.length) {
      return noSubstitutePayload({
        quoted,
        available,
        assignMessage: null,
        details: null
      });
    }

    let lastAssign = null;
    let lastTriedId = null;

    for (let i = 0; i < candidates.length && i < MAX_SUBSTITUTE_ASSIGN_ATTEMPTS; i++) {
      const targetCourierId = candidates[i];
      lastTriedId = targetCourierId;

      logger.info('[Shipmozo] Ship now: assign target courier', {
        orderId: order.orderId,
        smOrderId,
        targetCourierId,
        attempt: i + 1,
        confirmSubstitute,
        hasOverride
      });

      let assign;
      try {
        assign = await ShipmozoService.assignCourier({
          orderId: smOrderId,
          courierId: Number(targetCourierId)
        });
      } catch (assignErr) {
        logger.error('[Shipmozo] assignCourier threw', {
          orderId: order.orderId,
          targetCourierId,
          message: assignErr.message
        });
        assign = {
          success: false,
          code: 'ASSIGN_COURIER_FAILED',
          message: assignErr.message || 'Shipmozo assign-courier failed',
          raw: null
        };
      }

      lastAssign = assign;
      if (assign.success) {
        const substituted =
          quoted.courierId == null || Number(targetCourierId) !== Number(quoted.courierId);
        const matched = available.find((c) => Number(c.courierId) === Number(targetCourierId));
        const assignedName = assign.courier || matched?.courierName || String(targetCourierId);
        const substituteMeta = substituted
          ? {
              courierAssignNote: quoted.courierId
                ? `Quoted courier ${quoted.courierName || quoted.courierId} could not be assigned; assigned ${assignedName} after admin confirm.`
                : `Assigned ${assignedName} after admin confirm.`,
              courierSubstitutedFromId: quoted.courierId,
              courierSubstitutedFromName: quoted.courierName
            }
          : null;

        return finalizeShipmozoAssign({
          order,
          smOrderId,
          targetCourierId: Number(targetCourierId),
          quoted,
          available,
          assign,
          substituted,
          substituteMeta,
          applyUpsertShipmentInfo,
          evaluateAndPersistShipmentOps
        });
      }

      failedIds.add(Number(targetCourierId));
      logger.warn('[Shipmozo] Substitute assign attempt failed; trying next if any', {
        orderId: order.orderId,
        targetCourierId,
        message: assign.message,
        remainingCandidates: candidates.length - i - 1
      });
    }

    const nextSuggested = pickSuggestion(failedIds);
    if (!nextSuggested) {
      return noSubstitutePayload({
        quoted,
        available,
        assignMessage: lastAssign?.message || null,
        details: lastAssign?.raw || null
      });
    }

    return {
      success: false,
      code: lastAssign?.code || 'ASSIGN_COURIER_FAILED',
      message:
        lastAssign?.message ||
        `Could not assign courier${lastTriedId != null ? ` ${lastTriedId}` : ''}. Confirm another substitute or assign from the Shipmozo panel.`,
      details: lastAssign?.raw || null,
      quotedCourier: quoted.courierId
        ? { courierId: quoted.courierId, courierName: quoted.courierName }
        : null,
      suggestedCourier: nextSuggested,
      availableCouriers: available.slice(0, 15).map(mapCourierPublic)
    };
  } catch (err) {
    logger.error('[Shipmozo] runShipmozoAssignShip unexpected error', {
      orderId: order?.orderId,
      message: err.message,
      stack: err.stack
    });
    return {
      success: false,
      code: 'ASSIGN_INTERNAL_ERROR',
      message: err.message || 'Unexpected error while assigning Shipmozo courier.'
    };
  }
}

async function finalizeShipmozoAssign({
  order,
  smOrderId,
  targetCourierId,
  quoted,
  available,
  assign,
  substituted,
  substituteMeta,
  applyUpsertShipmentInfo,
  evaluateAndPersistShipmentOps
}) {
  let awbCode = assign.awbCode || assign.trackingNumber || null;
  let courierName =
    assign.courier ||
    (available.find((c) => Number(c.courierId) === Number(targetCourierId)) || {}).courierName ||
    quoted.courierName ||
    null;
  let needsManualPickup = quoted.pickupsAutomaticallyScheduled === false;
  const matchedRate = available.find((c) => Number(c.courierId) === Number(targetCourierId));
  if (matchedRate && matchedRate.pickupsAutomaticallyScheduled === false) {
    needsManualPickup = true;
  }

  try {
    if ((!awbCode || needsManualPickup) && needsManualPickup !== false) {
      const shouldSchedule = needsManualPickup === true || !awbCode;
      if (shouldSchedule) {
        const pickup = await ShipmozoService.schedulePickup({ orderId: smOrderId });
        if (pickup.success) {
          awbCode = pickup.awbCode || pickup.trackingNumber || awbCode;
          courierName = pickup.courier || courierName;
          needsManualPickup = false;
        } else if (!awbCode) {
          logger.warn('[Shipmozo] schedule-pickup after assign failed', {
            orderId: order.orderId,
            message: pickup.message
          });
        }
      }
    }

    if (!awbCode) {
      const pickup = await ShipmozoService.schedulePickup({ orderId: smOrderId });
      if (pickup.success) {
        awbCode = pickup.awbCode || pickup.trackingNumber || null;
        courierName = pickup.courier || courierName;
      }
    }
  } catch (pickupErr) {
    logger.warn('[Shipmozo] pickup step after assign threw', {
      orderId: order.orderId,
      message: pickupErr.message
    });
  }

  // Do NOT fetch/store Shipmozo label bytes in Mongo (API returns huge base64 PNGs).
  // Admin Open/Download always pulls live from Shipmozo get-order-label.

  await applyUpsertShipmentInfo({
    order,
    shipmentPayload: {
      shipmentId: order.shipmentInfo?.shipmentId || smOrderId,
      shipmozoOrderId: order.shipmentInfo?.shipmozoOrderId || smOrderId,
      shipmozoReferenceId: order.shipmentInfo?.shipmozoReferenceId || smOrderId,
      provider: SHIPPING_PROVIDERS.SHIPMOZO,
      awbCode: awbCode || null,
      trackingNumber: awbCode || null,
      courier: courierName,
      assignedCourierId: String(targetCourierId),
      providerStatus: awbCode ? 'AWB_ASSIGNED' : 'COURIER_ASSIGNED',
      shipmozoNeedsManualPickup: needsManualPickup === true,
      pickupScheduledAt: awbCode && needsManualPickup !== true ? new Date() : undefined,
      pickupDate:
        awbCode && needsManualPickup !== true
          ? new Date().toISOString().slice(0, 10)
          : undefined,
      events: [],
      ...(substituted && substituteMeta
        ? substituteMeta
        : {
            courierAssignNote: null,
            courierSubstitutedFromId: null,
            courierSubstitutedFromName: null
          })
    },
    trigger: 'admin_shipmozo_assign',
    allowOrderStatusUpdate: Boolean(awbCode)
  });

  let fresh = await Order.findOne({ orderId: order.orderId });
  if (fresh && awbCode) {
    const st = String(fresh.orderStatus || '').toLowerCase();
    if (['pending', 'confirmed'].includes(st)) {
      fresh.orderStatus = 'processing';
      fresh.markModified('orderStatus');
      await fresh.save();
      fresh = await Order.findOne({ orderId: order.orderId });
    }
  }

  if (fresh && typeof evaluateAndPersistShipmentOps === 'function') {
    try {
      await evaluateAndPersistShipmentOps(fresh, { source: 'admin_shipmozo_assign' });
    } catch (_) {
      /* non-fatal */
    }
  }

  if (!awbCode) {
    return {
      success: true,
      pendingAwb: true,
      message:
        'Courier assigned on Shipmozo but AWB not returned yet. Use Schedule pickup / sync, or complete from Shipmozo panel.',
      courierId: targetCourierId,
      order: fresh,
      provider: SHIPPING_PROVIDERS.SHIPMOZO,
      substituted: Boolean(substituted)
    };
  }

  return {
    success: true,
    message: substituted
      ? 'AWB assigned with substitute courier (admin confirmed).'
      : 'AWB assigned with checkout courier.',
    courierId: targetCourierId,
    shipment: {
      awbCode,
      trackingNumber: awbCode,
      courier: courierName
    },
    order: fresh,
    provider: SHIPPING_PROVIDERS.SHIPMOZO,
    substituted: Boolean(substituted)
  };
}

module.exports = {
  runShipmozoAssignShip,
  quotedCourierFromOrder,
  pickSubstituteCourier,
  normalizeExcludeCourierIds,
  MAX_SUBSTITUTE_ASSIGN_ATTEMPTS
};

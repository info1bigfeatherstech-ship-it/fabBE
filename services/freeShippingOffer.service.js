/**
 * Free-shipping offer evaluation — production-safe, used by checkout totals.
 * Does not mutate coupons; only decides whether customer deliveryCharges should be waived.
 *
 * Exclusivity (one benefit per checkout):
 * A successfully applied coupon OR referral blocks auto free-shipping waiver.
 * Loyalty points and free-gift offers are independent of this rule.
 */
const FreeShippingOffer = require('../models/FreeShippingOffer');
const logger = require('../utils/logger');

const FREE_SHIPPING_BLOCK_REASON = 'COUPON_OR_REFERRAL_EXCLUSIVE';

const roundMoney2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Offer is currently live: active flag + optional endDate not passed.
 * @param {object|null} offer
 * @param {Date} [now]
 */
function isOfferCurrentlyLive(offer, now = new Date()) {
  if (!offer || offer.isActive !== true) return false;
  if (offer.endDate != null) {
    const end = new Date(offer.endDate);
    if (!Number.isFinite(end.getTime())) return false;
    if (now.getTime() >= end.getTime()) return false;
  }
  return true;
}

/**
 * True when checkout already has a coupon or referral promo (exclusive vs free shipping).
 * @param {{ appliedCouponCode?: string|null, appliedReferral?: object|null }} [opts]
 */
function isExclusivePromoActive({ appliedCouponCode = null, appliedReferral = null } = {}) {
  if (String(appliedCouponCode || '').trim()) return true;
  if (appliedReferral && typeof appliedReferral === 'object') {
    if (String(appliedReferral.code || appliedReferral.referralCode || '').trim()) return true;
  }
  return false;
}

/**
 * Pure decision after threshold evaluation — easy to unit-test without DB.
 * @param {{
 *   thresholdMet: boolean,
 *   offer: object|null,
 *   minCartValue: number|null,
 *   shortfallInr: number|null,
 *   exclusivePromoActive?: boolean
 * }} opts
 */
function decideFreeShippingWaiver({
  thresholdMet,
  offer,
  minCartValue = null,
  shortfallInr = null,
  exclusivePromoActive = false
} = {}) {
  if (!offer || thresholdMet !== true) {
    return {
      applied: false,
      offer: offer || null,
      minCartValue: minCartValue != null ? roundMoney2(Number(minCartValue) || 0) : null,
      shortfallInr:
        shortfallInr != null && Number.isFinite(Number(shortfallInr))
          ? roundMoney2(Number(shortfallInr))
          : null,
      blockedByExclusivePromo: false,
      blockReason: null
    };
  }

  if (exclusivePromoActive) {
    return {
      applied: false,
      offer,
      minCartValue: roundMoney2(Number(minCartValue) || 0),
      shortfallInr: 0,
      blockedByExclusivePromo: true,
      blockReason: FREE_SHIPPING_BLOCK_REASON
    };
  }

  return {
    applied: true,
    offer,
    minCartValue: roundMoney2(Number(minCartValue) || 0),
    shortfallInr: 0,
    blockedByExclusivePromo: false,
    blockReason: null
  };
}

/**
 * If a locked quote waived shipping but a coupon/referral is now active, restore charges.
 * Fail-safe: never leave freeShippingApplied true alongside an exclusive promo.
 *
 * @param {{
 *   deliveryCharges: number,
 *   deliveryMeta?: object|null,
 *   exclusivePromoActive?: boolean
 * }} opts
 */
function applyExclusivePromoToDeliveryState({
  deliveryCharges,
  deliveryMeta = null,
  exclusivePromoActive = false
} = {}) {
  const meta =
    deliveryMeta && typeof deliveryMeta === 'object' ? { ...deliveryMeta } : {};
  const charged = roundMoney2(Number(deliveryCharges) || 0);
  const wasWaived = Boolean(meta.freeShippingApplied);

  if (!exclusivePromoActive) {
    return {
      deliveryCharges: charged,
      deliveryMeta: meta,
      freeShippingApplied: wasWaived,
      freeShippingOffer: wasWaived ? meta.freeShippingOffer || null : null,
      freeShippingBlockedByPromo: false,
      freeShippingBlockReason: null,
      originalDeliveryCharges:
        meta.originalDeliveryCharges != null && Number.isFinite(Number(meta.originalDeliveryCharges))
          ? roundMoney2(Number(meta.originalDeliveryCharges))
          : charged
    };
  }

  let restoredCharges = charged;
  if (wasWaived) {
    const fromOriginal =
      meta.originalDeliveryCharges != null && Number.isFinite(Number(meta.originalDeliveryCharges))
        ? roundMoney2(Number(meta.originalDeliveryCharges))
        : null;
    const fromSplits = roundMoney2(
      (Number(meta.freightInr) || 0) + (Number(meta.codFeeInr) || 0)
    );
    if (fromOriginal != null && fromOriginal > 0) {
      restoredCharges = fromOriginal;
    } else if (fromSplits > 0) {
      restoredCharges = fromSplits;
    } else {
      // Cannot recover a positive rate — keep charged amount but never claim free shipping.
      restoredCharges = charged;
    }
  }

  const originalDeliveryCharges =
    meta.originalDeliveryCharges != null && Number.isFinite(Number(meta.originalDeliveryCharges))
      ? roundMoney2(Number(meta.originalDeliveryCharges))
      : restoredCharges > 0
        ? restoredCharges
        : charged;

  const nextMeta = {
    ...meta,
    originalDeliveryCharges,
    freeShippingApplied: false,
    freeShippingOffer: null,
    freeShippingBlockedByPromo: true,
    freeShippingBlockReason: FREE_SHIPPING_BLOCK_REASON
  };

  return {
    deliveryCharges: restoredCharges,
    deliveryMeta: nextMeta,
    freeShippingApplied: false,
    freeShippingOffer: null,
    freeShippingBlockedByPromo: true,
    freeShippingBlockReason: FREE_SHIPPING_BLOCK_REASON,
    originalDeliveryCharges
  };
}

/**
 * Load the single live free-shipping offer (if any).
 * Prefers most recently updated active offer; controller keeps only one active.
 */
async function getLiveFreeShippingOffer(now = new Date()) {
  try {
    const candidates = await FreeShippingOffer.find({ isActive: true })
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean();
    for (const offer of candidates) {
      if (isOfferCurrentlyLive(offer, now)) return offer;
    }
    return null;
  } catch (err) {
    logger.error('[FreeShippingOffer] getLiveFreeShippingOffer failed', {
      message: err.message,
      stack: err.stack
    });
    // Fail closed: never waive shipping if lookup fails.
    return null;
  }
}

/**
 * @param {{
 *   itemsSubtotal: number,
 *   now?: Date,
 *   exclusivePromoActive?: boolean
 * }} opts
 * @returns {Promise<{
 *   applied: boolean,
 *   offer: object|null,
 *   minCartValue: number|null,
 *   shortfallInr: number|null,
 *   blockedByExclusivePromo: boolean,
 *   blockReason: string|null
 * }>}
 */
async function evaluateFreeShippingForSubtotal({
  itemsSubtotal,
  now = new Date(),
  exclusivePromoActive = false
} = {}) {
  const subtotal = roundMoney2(Number(itemsSubtotal) || 0);
  let offer = null;
  try {
    offer = await getLiveFreeShippingOffer(now);
  } catch (err) {
    logger.error('[FreeShippingOffer] evaluateFreeShippingForSubtotal lookup failed', {
      message: err?.message,
      stack: err?.stack
    });
    return {
      applied: false,
      offer: null,
      minCartValue: null,
      shortfallInr: null,
      blockedByExclusivePromo: false,
      blockReason: null
    };
  }

  if (!offer) {
    return {
      applied: false,
      offer: null,
      minCartValue: null,
      shortfallInr: null,
      blockedByExclusivePromo: false,
      blockReason: null
    };
  }

  const minCartValue = roundMoney2(Number(offer.minCartValue) || 0);
  const thresholdMet = subtotal + 0.005 >= minCartValue;
  const shortfallInr = thresholdMet
    ? 0
    : roundMoney2(Math.max(0, minCartValue - subtotal));

  return decideFreeShippingWaiver({
    thresholdMet,
    offer,
    minCartValue,
    shortfallInr,
    exclusivePromoActive: Boolean(exclusivePromoActive)
  });
}

/**
 * When activating one offer, deactivate all others (single active campaign).
 * @param {import('mongoose').Types.ObjectId|string} keepOfferId
 * @param {import('mongoose').ClientSession|null} [session]
 */
async function deactivateOtherOffers(keepOfferId, session = null) {
  const filter = {
    _id: { $ne: keepOfferId },
    isActive: true
  };
  let q = FreeShippingOffer.updateMany(filter, { $set: { isActive: false } });
  if (session) q = q.session(session);
  await q;
}

/**
 * Public/admin-safe projection.
 */
function mapOfferPublic(offer) {
  if (!offer) return null;
  return {
    id: String(offer._id),
    name: offer.name,
    description: offer.description || '',
    minCartValue: roundMoney2(Number(offer.minCartValue) || 0),
    endDate: offer.endDate || null,
    isActive: Boolean(offer.isActive),
    isLive: isOfferCurrentlyLive(offer),
    createdAt: offer.createdAt || null,
    updatedAt: offer.updatedAt || null
  };
}

module.exports = {
  FREE_SHIPPING_BLOCK_REASON,
  roundMoney2,
  isOfferCurrentlyLive,
  isExclusivePromoActive,
  decideFreeShippingWaiver,
  applyExclusivePromoToDeliveryState,
  getLiveFreeShippingOffer,
  evaluateFreeShippingForSubtotal,
  deactivateOtherOffers,
  mapOfferPublic
};

/**
 * Free-shipping offer evaluation — production-safe, used by checkout totals.
 * Does not mutate coupons; only decides whether customer deliveryCharges should be waived.
 */
const FreeShippingOffer = require('../models/FreeShippingOffer');
const logger = require('../utils/logger');

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
 * @param {{ itemsSubtotal: number, now?: Date }} opts
 * @returns {Promise<{
 *   applied: boolean,
 *   offer: object|null,
 *   minCartValue: number|null,
 *   shortfallInr: number|null
 * }>}
 */
async function evaluateFreeShippingForSubtotal({ itemsSubtotal, now = new Date() } = {}) {
  const subtotal = roundMoney2(Number(itemsSubtotal) || 0);
  const offer = await getLiveFreeShippingOffer(now);
  if (!offer) {
    return { applied: false, offer: null, minCartValue: null, shortfallInr: null };
  }

  const minCartValue = roundMoney2(Number(offer.minCartValue) || 0);
  if (!(subtotal + 0.005 >= minCartValue)) {
    return {
      applied: false,
      offer,
      minCartValue,
      shortfallInr: roundMoney2(Math.max(0, minCartValue - subtotal))
    };
  }

  return {
    applied: true,
    offer,
    minCartValue,
    shortfallInr: 0
  };
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
  roundMoney2,
  isOfferCurrentlyLive,
  getLiveFreeShippingOffer,
  evaluateFreeShippingForSubtotal,
  deactivateOtherOffers,
  mapOfferPublic
};

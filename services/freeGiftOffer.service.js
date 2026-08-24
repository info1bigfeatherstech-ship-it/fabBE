/**
 * Free Gift offer — evaluation helpers. No JSX. Mirrors freeShippingOffer.service.js pattern.
 * Free Gift and Free Shipping are independent; both can be live simultaneously.
 */
const FreeGiftOffer = require('../models/FreeGiftOffer');
const logger = require('../utils/logger');

/**
 * Is the offer currently live: active flag + endDate not passed.
 * @param {object|null} offer
 * @param {Date} [now]
 */
function isGiftOfferCurrentlyLive(offer, now = new Date()) {
  if (!offer || offer.isActive !== true) return false;
  if (offer.endDate != null) {
    const end = new Date(offer.endDate);
    if (!Number.isFinite(end.getTime())) return false;
    if (now.getTime() >= end.getTime()) return false;
  }
  return true;
}

/**
 * Load the single live free-gift offer (if any).
 * Prefers most recently updated active offer.
 * Fail-closed on DB error.
 */
async function getLiveFreeGiftOffer(now = new Date()) {
  try {
    const candidates = await FreeGiftOffer.find({ isActive: true })
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean();
    for (const offer of candidates) {
      if (isGiftOfferCurrentlyLive(offer, now)) return offer;
    }
    return null;
  } catch (err) {
    logger.error('[FreeGiftOffer] getLiveFreeGiftOffer failed', {
      message: err.message,
      stack: err.stack
    });
    return null; // fail closed — never apply gift on error
  }
}

/**
 * Evaluate whether the free-gift offer applies at checkout/order time.
 * No min-cart check — every order qualifies when offer is live.
 * @returns {Promise<{ applied: boolean, offer: object|null }>}
 */
async function evaluateFreeGiftForOrder(now = new Date()) {
  const offer = await getLiveFreeGiftOffer(now);
  if (!offer) return { applied: false, offer: null };
  return { applied: true, offer };
}

/**
 * When activating one gift offer, deactivate all others (single active campaign).
 * @param {import('mongoose').Types.ObjectId|string} keepOfferId
 * @param {import('mongoose').ClientSession|null} [session]
 */
async function deactivateOtherGiftOffers(keepOfferId, session = null) {
  let q = FreeGiftOffer.updateMany(
    { _id: { $ne: keepOfferId }, isActive: true },
    { $set: { isActive: false } }
  );
  if (session) q = q.session(session);
  await q;
}

/**
 * Public/admin-safe projection.
 */
function mapGiftOfferPublic(offer) {
  if (!offer) return null;
  return {
    id: String(offer._id),
    name: offer.name,
    description: offer.description || '',
    endDate: offer.endDate || null,
    isActive: Boolean(offer.isActive),
    isLive: isGiftOfferCurrentlyLive(offer),
    createdAt: offer.createdAt || null,
    updatedAt: offer.updatedAt || null
  };
}

module.exports = {
  isGiftOfferCurrentlyLive,
  getLiveFreeGiftOffer,
  evaluateFreeGiftForOrder,
  deactivateOtherGiftOffers,
  mapGiftOfferPublic
};

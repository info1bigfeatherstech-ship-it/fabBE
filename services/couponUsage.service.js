/**
 * Per-user coupon limit enforcement (production-safe).
 *
 * - Order history (non-cancelled / non-payment_failed) is the durable source of truth.
 * - CouponUserUsage provides an atomic claim so two parallel checkouts cannot both pass.
 * - Cancel / payment_failed must call releaseUserCouponSlotForOrder so the user can retry.
 */
const mongoose = require('mongoose');
const Order = require('../models/Order');
const CouponUserUsage = require('../models/CouponUserUsage');
const logger = require('../utils/logger');

/** Orders in these statuses do not consume a per-user coupon slot. */
const COUPON_USAGE_EXCLUDED_STATUSES = Object.freeze(['cancelled', 'payment_failed']);

function normalizeCouponCode(code) {
  return String(code || '').trim().toUpperCase();
}

/**
 * @param {object|null|undefined} coupon
 * @returns {number|null} Positive limit, or null when unlimited / not applicable.
 */
function resolvePerUserLimit(coupon) {
  if (!coupon || typeof coupon !== 'object') return null;
  const raw = coupon.perUserLimit;
  if (raw === null || raw === undefined || raw === '') return 1; // schema default
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n <= 0) return null; // treat non-positive as unlimited (admin escape hatch)
  return Math.floor(n);
}

function perUserLimitError(used, limit, couponCode) {
  const err = new Error(
    limit <= 1
      ? 'You have already used this coupon'
      : `You have already used this coupon ${used} time${used === 1 ? '' : 's'} (limit ${limit})`
  );
  err.statusCode = 409;
  err.code = 'COUPON_PER_USER_LIMIT';
  err.details = {
    couponCode: normalizeCouponCode(couponCode) || null,
    used,
    limit
  };
  return err;
}

/**
 * Count orders that still consume a per-user slot for this user + code.
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {string} couponCode
 * @param {import('mongoose').ClientSession|null} [session]
 */
async function countActiveCouponOrders(userId, couponCode, session = null) {
  if (!userId) return 0;
  const code = normalizeCouponCode(couponCode);
  if (!code) return 0;

  const filter = {
    userId,
    'appliedCoupon.code': code,
    orderStatus: { $nin: [...COUPON_USAGE_EXCLUDED_STATUSES] }
  };

  try {
    let q = Order.countDocuments(filter);
    if (session) q = q.session(session);
    return Math.max(0, Number(await q) || 0);
  } catch (err) {
    logger.error('[couponUsage] countActiveCouponOrders failed', {
      message: err?.message,
      stack: err?.stack,
      userId: String(userId),
      couponCode: code
    });
    // Fail closed: treat as exhausted so we never under-count on DB errors during check.
    throw err;
  }
}

/**
 * Effective usage = max(order history, atomic counter).
 * Counter can briefly lead during in-flight checkout; orders catch up after commit.
 */
async function getEffectiveUserCouponUsage(userId, couponCode, session = null) {
  const code = normalizeCouponCode(couponCode);
  if (!userId || !code) return 0;

  const orderUsed = await countActiveCouponOrders(userId, code, session);

  let counterUsed = 0;
  try {
    let uq = CouponUserUsage.findOne({ userId, couponCode: code }).select('usageCount').lean();
    if (session) uq = uq.session(session);
    const doc = await uq;
    counterUsed = Math.max(0, Number(doc?.usageCount) || 0);
  } catch (err) {
    logger.error('[couponUsage] counter read failed', {
      message: err?.message,
      stack: err?.stack
    });
    // Fall back to order count only.
  }

  return Math.max(orderUsed, counterUsed);
}

/**
 * Soft check — does not claim a slot. Used by validate / quote / available list.
 * @returns {{ ok: boolean, used: number, limit: number|null, remaining: number|null }}
 */
async function evaluatePerUserCouponAvailability(userId, coupon, session = null) {
  const limit = resolvePerUserLimit(coupon);
  const code = normalizeCouponCode(coupon?.code || coupon?.couponCode);
  if (!userId || !code) {
    return { ok: true, used: 0, limit, remaining: limit };
  }
  if (limit == null) {
    return { ok: true, used: 0, limit: null, remaining: null };
  }

  const used = await getEffectiveUserCouponUsage(userId, code, session);
  const remaining = Math.max(0, limit - used);
  return {
    ok: used < limit,
    used,
    limit,
    remaining
  };
}

/**
 * Throws COUPON_PER_USER_LIMIT when the user cannot use this coupon again.
 */
async function assertUserMayUseCoupon(userId, coupon, session = null) {
  const evalResult = await evaluatePerUserCouponAvailability(userId, coupon, session);
  if (!evalResult.ok) {
    throw perUserLimitError(
      evalResult.used,
      evalResult.limit,
      coupon?.code || coupon?.couponCode
    );
  }
  return evalResult;
}

/**
 * Atomically claim one per-user slot. Call only when consumeUsage=true (order create).
 * Must run inside the same Mongo session/transaction as order insert when available.
 */
async function consumeUserCouponSlot({ userId, coupon, session = null } = {}) {
  if (!userId || !coupon) return { skipped: true, reason: 'missing' };

  const limit = resolvePerUserLimit(coupon);
  const code = normalizeCouponCode(coupon.code || coupon.couponCode);
  if (!code) return { skipped: true, reason: 'no_code' };
  if (limit == null) return { skipped: true, reason: 'unlimited' };

  const couponId =
    coupon._id && mongoose.Types.ObjectId.isValid(coupon._id) ? coupon._id : null;

  // Align counter floor with durable order history before claiming.
  const orderUsed = await countActiveCouponOrders(userId, code, session);
  if (orderUsed >= limit) {
    throw perUserLimitError(orderUsed, limit, code);
  }

  // Seed + floor sync MUST be separate updates — Mongo forbids two operators
  // on the same path in one update (e.g. $setOnInsert.usageCount + $max.usageCount).
  const sessionOpt = session || undefined;
  try {
    const insertFields = {
      userId,
      couponCode: code,
      usageCount: orderUsed
    };
    if (couponId) insertFields.couponId = couponId;

    await CouponUserUsage.updateOne(
      { userId, couponCode: code },
      { $setOnInsert: insertFields },
      { upsert: true, session: sessionOpt }
    );
  } catch (err) {
    // Parallel upserts can hit duplicate key — safe to continue.
    if (err?.code !== 11000) {
      logger.error('[couponUsage] seed upsert failed', {
        message: err?.message,
        stack: err?.stack
      });
      throw err;
    }
  }

  try {
    const floorUpdate = { $max: { usageCount: orderUsed } };
    if (couponId) floorUpdate.$set = { couponId };
    let floorQ = CouponUserUsage.updateOne({ userId, couponCode: code }, floorUpdate);
    if (session) floorQ = floorQ.session(session);
    await floorQ;
  } catch (err) {
    logger.error('[couponUsage] floor sync failed', {
      message: err?.message,
      stack: err?.stack
    });
    throw err;
  }

  let upd;
  try {
    let q = CouponUserUsage.updateOne(
      { userId, couponCode: code, usageCount: { $lt: limit } },
      { $inc: { usageCount: 1 } }
    );
    if (session) q = q.session(session);
    upd = await q;
  } catch (err) {
    logger.error('[couponUsage] consume $inc failed', {
      message: err?.message,
      stack: err?.stack
    });
    throw err;
  }

  if (!upd || upd.modifiedCount !== 1) {
    const used = await getEffectiveUserCouponUsage(userId, code, session);
    throw perUserLimitError(Math.max(used, limit), limit, code);
  }

  return { skipped: false, claimed: true, limit };
}

/**
 * Release one slot when an order that used the coupon is cancelled / payment_failed.
 * Idempotent best-effort — never throws to callers (cancel must not fail on this).
 */
async function releaseUserCouponSlotForOrder(order, session = null) {
  try {
    if (!order) return { skipped: true, reason: 'no_order' };
    const userId = order.userId;
    const code = normalizeCouponCode(order.appliedCoupon?.code);
    if (!userId || !code) return { skipped: true, reason: 'no_coupon' };

    let q = CouponUserUsage.updateOne(
      { userId, couponCode: code, usageCount: { $gt: 0 } },
      { $inc: { usageCount: -1 } }
    );
    if (session) q = q.session(session);
    const upd = await q;
    return {
      skipped: false,
      released: Boolean(upd?.modifiedCount === 1),
      couponCode: code
    };
  } catch (err) {
    logger.error('[couponUsage] releaseUserCouponSlotForOrder failed', {
      message: err?.message,
      stack: err?.stack,
      orderId: order?.orderId || null
    });
    return { skipped: true, reason: 'error', error: err?.message };
  }
}

/**
 * True when order status change should free a coupon slot.
 */
function shouldReleaseCouponSlotForStatus(nextStatus) {
  const st = String(nextStatus || '').trim().toLowerCase();
  return COUPON_USAGE_EXCLUDED_STATUSES.includes(st);
}

/**
 * If transitioning into cancelled/payment_failed from an active status, release once.
 */
async function maybeReleaseCouponSlotOnStatusChange(order, previousStatus, nextStatus, session = null) {
  const prev = String(previousStatus || '').trim().toLowerCase();
  const next = String(nextStatus || '').trim().toLowerCase();
  if (!shouldReleaseCouponSlotForStatus(next)) return { skipped: true, reason: 'not_terminal' };
  if (shouldReleaseCouponSlotForStatus(prev)) return { skipped: true, reason: 'already_terminal' };
  return releaseUserCouponSlotForOrder(order, session);
}

module.exports = {
  COUPON_USAGE_EXCLUDED_STATUSES,
  normalizeCouponCode,
  resolvePerUserLimit,
  countActiveCouponOrders,
  getEffectiveUserCouponUsage,
  evaluatePerUserCouponAvailability,
  assertUserMayUseCoupon,
  consumeUserCouponSlot,
  releaseUserCouponSlotForOrder,
  shouldReleaseCouponSlotForStatus,
  maybeReleaseCouponSlotOnStatusChange,
  perUserLimitError
};

/**
 * Loyalty points (redeem / earn / clawback) — separate from badge tiers in loyalty.service.js.
 * Production rules:
 * - Master switch off → no discount, no ledger writes (checkout math unchanged).
 * - Redeem stacks with coupon when settings.stackWithCoupon is true.
 * - Final payable / COD / advance split use total after loyalty discount.
 * - Earn on first money-capture (online) or COD delivered; clawback on RTO / return refund.
 * - All ledger writes are idempotent via userId + idempotencyKey.
 */
const mongoose = require('mongoose');
const LoyaltyPointsSettings = require('../models/LoyaltyPointsSettings');
const LoyaltyEarnRule = require('../models/LoyaltyEarnRule');
const LoyaltyPointLedger = require('../models/LoyaltyPointLedger');
const User = require('../models/User');
const logger = require('../utils/logger');

const SETTINGS_CACHE_MS = 30_000;
const settingsCache = new Map();

function roundMoney2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function floorPoints(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.floor(x);
}

function normalizeStorefront(sf) {
  return sf === 'wholesale' ? 'wholesale' : 'ecomm';
}

function defaultSettingsDoc(storefront) {
  return {
    storefront: normalizeStorefront(storefront),
    enabled: false,
    earnPointsPerRupee: 1,
    redeemRupeePerPoint: 1,
    minOrderSubtotalToEarn: 0,
    minOrderSubtotalToRedeem: 0,
    minRedeemPoints: 1,
    maxRedeemPercentOfPayable: 50,
    maxRedeemPointsPerOrder: null,
    expiryDays: 365,
    earnOnShipping: false,
    earnOnTax: false,
    stackWithCoupon: true,
    termsHtml: ''
  };
}

async function getSettings(storefront = 'ecomm', { bypassCache = false } = {}) {
  const sf = normalizeStorefront(storefront);
  const now = Date.now();
  const cached = settingsCache.get(sf);
  if (!bypassCache && cached && now - cached.at < SETTINGS_CACHE_MS) {
    return cached.doc;
  }
  let doc = await LoyaltyPointsSettings.findOne({ storefront: sf }).lean();
  if (!doc) {
    try {
      doc = (await LoyaltyPointsSettings.create(defaultSettingsDoc(sf))).toObject();
    } catch (err) {
      // Race: another instance created it
      doc = await LoyaltyPointsSettings.findOne({ storefront: sf }).lean();
      if (!doc) throw err;
    }
  }
  settingsCache.set(sf, { at: now, doc });
  return doc;
}

function invalidateSettingsCache(storefront) {
  if (storefront) settingsCache.delete(normalizeStorefront(storefront));
  else settingsCache.clear();
}

async function updateSettings(storefront, patch, updatedBy = null) {
  const sf = normalizeStorefront(storefront);
  const allowed = [
    'enabled',
    'earnPointsPerRupee',
    'redeemRupeePerPoint',
    'minOrderSubtotalToEarn',
    'minOrderSubtotalToRedeem',
    'minRedeemPoints',
    'maxRedeemPercentOfPayable',
    'maxRedeemPointsPerOrder',
    'expiryDays',
    'earnOnShipping',
    'earnOnTax',
    'stackWithCoupon',
    'termsHtml'
  ];
  const $set = {};
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    $set[key] = patch[key];
  }
  if (updatedBy) $set.updatedBy = updatedBy;
  const doc = await LoyaltyPointsSettings.findOneAndUpdate(
    { storefront: sf },
    { $set, $setOnInsert: { storefront: sf } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  invalidateSettingsCache(sf);
  return doc;
}

function publicSettingsView(settings) {
  const s = settings || defaultSettingsDoc('ecomm');
  return {
    enabled: Boolean(s.enabled),
    earnPointsPerRupee: Number(s.earnPointsPerRupee) || 0,
    redeemRupeePerPoint: Number(s.redeemRupeePerPoint) || 0,
    minOrderSubtotalToEarn: roundMoney2(s.minOrderSubtotalToEarn || 0),
    minOrderSubtotalToRedeem: roundMoney2(s.minOrderSubtotalToRedeem || 0),
    minRedeemPoints: floorPoints(s.minRedeemPoints || 0) || 0,
    maxRedeemPercentOfPayable: Math.min(100, Math.max(0, Number(s.maxRedeemPercentOfPayable) || 0)),
    maxRedeemPointsPerOrder:
      s.maxRedeemPointsPerOrder != null && Number(s.maxRedeemPointsPerOrder) > 0
        ? floorPoints(s.maxRedeemPointsPerOrder)
        : null,
    expiryDays: Math.max(0, Math.floor(Number(s.expiryDays) || 0)),
    earnOnShipping: Boolean(s.earnOnShipping),
    earnOnTax: Boolean(s.earnOnTax),
    stackWithCoupon: s.stackWithCoupon !== false,
    termsHtml: s.termsHtml || ''
  };
}

async function getUserPointsBalance(userId, session = null) {
  if (!userId) return 0;
  // Outside transactions, heal wiped balances from ledger before quoting redeem.
  if (!session) {
    await ensureUserPointsBalanceSynced(userId);
  }
  const q = User.findById(userId).select('loyalty.pointsBalance');
  if (session) q.session(session);
  const user = await q.lean();
  return Math.max(0, floorPoints(user?.loyalty?.pointsBalance || 0));
}

/**
 * Quote how many points can be applied and ₹ discount for a pre-loyalty payable.
 * Does not mutate balance.
 */
function computeRedeemQuote({
  settings,
  balancePoints,
  pointsRequested,
  preLoyaltyPayable,
  itemsSubtotal,
  couponDiscount = 0
}) {
  const empty = {
    pointsRequested: 0,
    pointsApplied: 0,
    loyaltyDiscount: 0,
    maxRedeemablePoints: 0,
    balancePoints: Math.max(0, floorPoints(balancePoints)),
    applied: false,
    reason: null
  };

  if (!settings?.enabled) {
    return { ...empty, reason: 'disabled' };
  }

  const rate = Number(settings.redeemRupeePerPoint) || 0;
  if (!(rate > 0)) {
    return { ...empty, reason: 'invalid_rate' };
  }

  if (
    settings.stackWithCoupon === false &&
    roundMoney2(couponDiscount) > 0
  ) {
    return { ...empty, reason: 'coupon_no_stack' };
  }

  const subtotal = roundMoney2(itemsSubtotal);
  if (subtotal + 0.001 < roundMoney2(settings.minOrderSubtotalToRedeem || 0)) {
    return { ...empty, reason: 'min_subtotal' };
  }

  const payable = Math.max(0, roundMoney2(preLoyaltyPayable));
  if (!(payable > 0)) {
    return { ...empty, reason: 'zero_payable' };
  }

  const pct = Math.min(100, Math.max(0, Number(settings.maxRedeemPercentOfPayable) || 0));
  const maxByPercentInr = roundMoney2((payable * pct) / 100);
  let maxByPoints = floorPoints(maxByPercentInr / rate);
  const hardCap =
    settings.maxRedeemPointsPerOrder != null && Number(settings.maxRedeemPointsPerOrder) > 0
      ? floorPoints(settings.maxRedeemPointsPerOrder)
      : null;
  if (hardCap != null) maxByPoints = Math.min(maxByPoints, hardCap);

  const balance = Math.max(0, floorPoints(balancePoints));
  const maxRedeemablePoints = Math.min(balance, maxByPoints);
  const minPts = Math.max(0, floorPoints(settings.minRedeemPoints || 0));

  const requested = floorPoints(pointsRequested);
  if (!(requested > 0)) {
    return {
      ...empty,
      maxRedeemablePoints,
      balancePoints: balance,
      reason: 'none_requested'
    };
  }

  if (minPts > 0 && requested < minPts) {
    return {
      ...empty,
      maxRedeemablePoints,
      balancePoints: balance,
      reason: 'below_min_redeem'
    };
  }

  const pointsApplied = Math.min(requested, maxRedeemablePoints);
  if (!(pointsApplied > 0)) {
    return {
      ...empty,
      maxRedeemablePoints,
      balancePoints: balance,
      reason: 'insufficient_or_capped'
    };
  }

  let loyaltyDiscount = roundMoney2(pointsApplied * rate);
  if (loyaltyDiscount > payable) {
    loyaltyDiscount = payable;
  }

  return {
    pointsRequested: requested,
    pointsApplied,
    loyaltyDiscount,
    maxRedeemablePoints,
    balancePoints: balance,
    applied: loyaltyDiscount > 0,
    reason: null
  };
}

/**
 * Apply redeem quote onto checkout totals object (mutates copy-style return fields).
 */
async function attachLoyaltyDiscountToTotals(totals, {
  storefront,
  userId,
  loyaltyPointsToRedeem = 0,
  session = null
} = {}) {
  const base = {
    loyaltyDiscount: 0,
    loyaltyPointsRedeemed: 0,
    loyaltyPointsRequested: 0,
    loyaltyMaxRedeemable: 0,
    loyaltyBalance: 0,
    loyaltyEnabled: false,
    loyaltyRedeemReason: null
  };

  const settings = await getSettings(storefront);
  const pub = publicSettingsView(settings);
  base.loyaltyEnabled = pub.enabled;

  const preLoyalty = roundMoney2(
    Number(totals.subtotal || 0) +
      Number(totals.deliveryCharges || 0) +
      Number(totals.tax || 0) -
      Number(totals.discount || 0)
  );

  if (!settings.enabled) {
    return {
      ...totals,
      ...base,
      totalAmount: Math.max(0, preLoyalty),
      preLoyaltyAmount: preLoyalty
    };
  }

  const balance = userId ? await getUserPointsBalance(userId, session) : 0;
  const quote = computeRedeemQuote({
    settings,
    balancePoints: balance,
    pointsRequested: loyaltyPointsToRedeem,
    preLoyaltyPayable: preLoyalty,
    itemsSubtotal: totals.subtotal,
    couponDiscount: totals.discount
  });

  const totalAmount = Math.max(0, roundMoney2(preLoyalty - quote.loyaltyDiscount));

  return {
    ...totals,
    loyaltyDiscount: quote.loyaltyDiscount,
    loyaltyPointsRedeemed: quote.pointsApplied,
    loyaltyPointsRequested: quote.pointsRequested,
    loyaltyMaxRedeemable: quote.maxRedeemablePoints,
    loyaltyBalance: quote.balancePoints,
    loyaltyEnabled: true,
    loyaltyRedeemReason: quote.reason,
    preLoyaltyAmount: preLoyalty,
    totalAmount,
    redeemRupeePerPoint: Number(settings.redeemRupeePerPoint) || 0,
    earnPointsPerRupee: Number(settings.earnPointsPerRupee) || 0
  };
}

async function applyLedgerDelta({
  userId,
  storefront,
  type,
  points,
  idempotencyKey,
  orderId = null,
  orderMongoId = null,
  rupeeValue = 0,
  expiresAt = null,
  meta = {},
  note = '',
  createdBy = null,
  session = null
}) {
  const delta = Math.trunc(Number(points) || 0);
  if (!userId || !idempotencyKey || delta === 0) {
    return { skipped: true, reason: 'noop' };
  }

  const existing = await LoyaltyPointLedger.findOne({ userId, idempotencyKey })
    .session(session || null)
    .lean();
  if (existing) {
    return { skipped: true, reason: 'idempotent', entry: existing };
  }

  const userQuery = User.findById(userId).select('loyalty');
  if (session) userQuery.session(session);
  const user = await userQuery;
  if (!user) {
    const err = new Error('User not found for loyalty points');
    err.statusCode = 404;
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  if (!user.loyalty || typeof user.loyalty !== 'object') {
    user.loyalty = {};
  }
  const prev = Math.max(0, floorPoints(user.loyalty.pointsBalance || 0));
  let next = prev + delta;
  if (next < 0) {
    const err = new Error('Insufficient loyalty points');
    err.statusCode = 400;
    err.code = 'LOYALTY_INSUFFICIENT_POINTS';
    throw err;
  }
  next = Math.max(0, next);

  user.loyalty.pointsBalance = next;
  if (delta > 0 && (type === 'earn' || type === 'adjust' || type === 'redeem_restore')) {
    user.loyalty.pointsLifetimeEarned = Math.max(
      0,
      floorPoints(user.loyalty.pointsLifetimeEarned || 0) + (type === 'earn' ? delta : 0)
    );
  }
  if (delta < 0 && type === 'redeem') {
    user.loyalty.pointsLifetimeRedeemed = Math.max(
      0,
      floorPoints(user.loyalty.pointsLifetimeRedeemed || 0) + Math.abs(delta)
    );
  }
  user.markModified('loyalty');
  await user.save(session ? { session } : undefined);

  try {
    const entry = await LoyaltyPointLedger.create(
      [
        {
          userId,
          storefront: normalizeStorefront(storefront),
          type,
          points: delta,
          balanceAfter: next,
          orderId: orderId || null,
          orderMongoId: orderMongoId || null,
          idempotencyKey,
          rupeeValue: roundMoney2(rupeeValue),
          expiresAt: expiresAt || null,
          meta,
          note: note || '',
          createdBy: createdBy || null
        }
      ],
      session ? { session } : undefined
    );
    return { skipped: false, entry: Array.isArray(entry) ? entry[0] : entry, balance: next };
  } catch (err) {
    // Unique race — treat as idempotent
    if (err && (err.code === 11000 || String(err.message || '').includes('duplicate'))) {
      const again = await LoyaltyPointLedger.findOne({ userId, idempotencyKey })
        .session(session || null)
        .lean();
      return { skipped: true, reason: 'idempotent_race', entry: again };
    }
    // Roll balance back best-effort if ledger insert failed for other reasons
    try {
      user.loyalty.pointsBalance = prev;
      user.markModified('loyalty');
      await user.save(session ? { session } : undefined);
    } catch (_) {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Debit redeemed points at order create (inside order transaction when possible).
 */
async function debitRedeemForOrder(order, { session = null } = {}) {
  const points = floorPoints(order?.loyaltyPoints?.redeemed || order?.loyaltyPointsRedeemed || 0);
  if (!(points > 0) || !order?.userId) return { skipped: true, reason: 'none' };

  const settings = await getSettings(order.storefront || 'ecomm');
  if (!settings.enabled) return { skipped: true, reason: 'disabled' };

  const orderId = order.orderId;
  const result = await applyLedgerDelta({
    userId: order.userId,
    storefront: order.storefront || 'ecomm',
    type: 'redeem',
    points: -points,
    idempotencyKey: `redeem:${orderId}`,
    orderId,
    orderMongoId: order._id || null,
    rupeeValue: roundMoney2(order?.loyaltyPoints?.discountInr || 0),
    meta: { phase: 'order_create' },
    session
  });

  if (!result.skipped && order.loyaltyPoints) {
    order.loyaltyPoints.redeemStatus = 'debited';
    order.loyaltyPoints.redeemLedgerId = result.entry?._id || null;
    if (typeof order.markModified === 'function') order.markModified('loyaltyPoints');
  }
  return result;
}

async function restoreRedeemForOrder(order, { reason = 'restore', session = null } = {}) {
  const points = floorPoints(order?.loyaltyPoints?.redeemed || 0);
  if (!(points > 0) || !order?.userId) return { skipped: true, reason: 'none' };
  if (String(order.loyaltyPoints?.redeemStatus || '') === 'restored') {
    return { skipped: true, reason: 'already_restored' };
  }
  // Only restore if we previously debited (or legacy orders that had redeemed set)
  const status = String(order.loyaltyPoints?.redeemStatus || '');
  if (status && status !== 'debited' && status !== 'pending') {
    return { skipped: true, reason: `status_${status}` };
  }

  const orderId = order.orderId;
  const result = await applyLedgerDelta({
    userId: order.userId,
    storefront: order.storefront || 'ecomm',
    type: 'redeem_restore',
    points,
    idempotencyKey: `redeem_restore:${orderId}`,
    orderId,
    orderMongoId: order._id || null,
    rupeeValue: roundMoney2(order?.loyaltyPoints?.discountInr || 0),
    meta: { reason },
    session
  });

  if (!result.skipped && order.loyaltyPoints) {
    order.loyaltyPoints.redeemStatus = 'restored';
    if (typeof order.markModified === 'function') order.markModified('loyaltyPoints');
  }
  return result;
}

function computeEarnPointsForOrder(order, settings) {
  if (!settings?.enabled) return 0;
  const rate = Number(settings.earnPointsPerRupee) || 0;
  if (!(rate > 0)) return 0;

  const subtotal = roundMoney2(order.subtotal || 0);
  if (subtotal + 0.001 < roundMoney2(settings.minOrderSubtotalToEarn || 0)) return 0;

  // Cash payable after coupon + loyalty (what customer actually pays online/COD).
  let base = roundMoney2(order.totalAmount || 0);
  if (!settings.earnOnShipping) {
    base = roundMoney2(base - Number(order.deliveryCharges || 0));
  }
  if (!settings.earnOnTax) {
    base = roundMoney2(base - Number(order.tax || 0));
  }
  base = Math.max(0, base);

  return floorPoints(base * rate);
}

async function creditEarnForOrder(order, { session = null, reason = 'payment_success' } = {}) {
  if (!order?.userId || !order?.orderId) return { skipped: true, reason: 'no_order' };

  const earnStatus = String(order.loyaltyPoints?.earnStatus || '');
  if (earnStatus === 'credited' || earnStatus === 'clawed_back') {
    return { skipped: true, reason: earnStatus };
  }

  const settings = await getSettings(order.storefront || 'ecomm');
  if (!settings.enabled) return { skipped: true, reason: 'disabled' };

  const points = computeEarnPointsForOrder(order, settings);
  if (!(points > 0)) {
    if (order.loyaltyPoints) {
      order.loyaltyPoints.earnStatus = 'skipped';
      order.loyaltyPoints.earned = 0;
      if (typeof order.markModified === 'function') order.markModified('loyaltyPoints');
    }
    return { skipped: true, reason: 'zero_earn' };
  }

  let expiresAt = null;
  const days = Math.max(0, Math.floor(Number(settings.expiryDays) || 0));
  if (days > 0) {
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const result = await applyLedgerDelta({
    userId: order.userId,
    storefront: order.storefront || 'ecomm',
    type: 'earn',
    points,
    idempotencyKey: `earn:${order.orderId}`,
    orderId: order.orderId,
    orderMongoId: order._id || null,
    rupeeValue: roundMoney2(order.totalAmount || 0),
    expiresAt,
    meta: { reason },
    session
  });

  if (!result.skipped) {
    order.loyaltyPoints = order.loyaltyPoints || {};
    order.loyaltyPoints.earned = points;
    order.loyaltyPoints.earnStatus = 'credited';
    order.loyaltyPoints.earnLedgerId = result.entry?._id || null;
    order.loyaltyPoints.earnCreditedAt = new Date();
    if (typeof order.markModified === 'function') order.markModified('loyaltyPoints');
  }
  return result;
}

async function clawbackEarnForOrder(order, { session = null, reason = 'clawback' } = {}) {
  if (!order?.userId || !order?.orderId) return { skipped: true, reason: 'no_order' };

  const earnStatus = String(order.loyaltyPoints?.earnStatus || '');
  if (earnStatus === 'clawed_back') return { skipped: true, reason: 'already_clawed' };
  if (earnStatus !== 'credited') {
    // Still try restore redeem below via caller; earn nothing to claw
    return { skipped: true, reason: `earn_${earnStatus || 'none'}` };
  }

  const points = floorPoints(order.loyaltyPoints?.earned || 0);
  if (!(points > 0)) return { skipped: true, reason: 'zero' };

  // Cap clawback to available balance (never go negative)
  const balance = await getUserPointsBalance(order.userId, session);
  const claw = Math.min(points, balance);
  if (!(claw > 0)) {
    order.loyaltyPoints.earnStatus = 'clawed_back';
    if (typeof order.markModified === 'function') order.markModified('loyaltyPoints');
    return { skipped: true, reason: 'balance_empty' };
  }

  const result = await applyLedgerDelta({
    userId: order.userId,
    storefront: order.storefront || 'ecomm',
    type: 'earn_clawback',
    points: -claw,
    idempotencyKey: `earn_clawback:${order.orderId}`,
    orderId: order.orderId,
    orderMongoId: order._id || null,
    meta: { reason, requested: points, applied: claw },
    session
  });

  if (!result.skipped) {
    order.loyaltyPoints.earnStatus = 'clawed_back';
    order.loyaltyPoints.clawbackLedgerId = result.entry?._id || null;
    order.loyaltyPoints.clawedBackAt = new Date();
    if (typeof order.markModified === 'function') order.markModified('loyaltyPoints');
  }
  return result;
}

/**
 * Non-blocking side-effects after order state is persisted.
 * - Money captured / COD delivered → credit earn
 * - RTO or return refunded → clawback earn + restore redeem
 * - Unpaid cancel / payment failed → restore redeem only
 */
function scheduleLoyaltyPointsSideEffectsForOrder(order, options = {}) {
  try {
    if (!order?.userId || !order?.orderId) return Promise.resolve(null);

    const pay = String(order.paymentStatus || '').toLowerCase();
    const status = String(order.orderStatus || '').toLowerCase();
    const method = String(order?.paymentInfo?.method || '').trim().toLowerCase();
    const returnStatus = String(order?.returnInfo?.status || '').toLowerCase();

    const paidLike = pay === 'paid' || pay === 'partially_paid';
    const codDelivered = method === 'cod' && status === 'delivered';
    const isRto = status === 'rto';
    const isReturnRefunded = returnStatus === 'refunded';
    const unpaidDead =
      status === 'cancelled' ||
      status === 'payment_failed' ||
      pay === 'failed';

    const run = async () => {
      try {
        // Re-load lean flags if needed — work on the in-memory order when possible
        if (isRto || isReturnRefunded) {
          await clawbackEarnForOrder(order, { reason: isRto ? 'rto' : 'return_refund' });
          await restoreRedeemForOrder(order, { reason: isRto ? 'rto' : 'return_refund' });
          if (typeof order.save === 'function' && order.isModified?.('loyaltyPoints')) {
            await order.save();
          }
          return;
        }

        if (unpaidDead && !paidLike) {
          await restoreRedeemForOrder(order, { reason: options.reason || 'unpaid_cancel' });
          if (typeof order.save === 'function' && order.isModified?.('loyaltyPoints')) {
            await order.save();
          }
          return;
        }

        if (paidLike || codDelivered) {
          await creditEarnForOrder(order, { reason: options.reason || 'payment_success' });
          if (typeof order.save === 'function' && order.isModified?.('loyaltyPoints')) {
            await order.save();
          }
        }
      } catch (err) {
        logger.error('[loyaltyPoints] side-effect failed', {
          orderId: order.orderId,
          message: err?.message || String(err)
        });
      }
    };

    // Fire-and-forget; never throw into payment path
    const p = run();
    if (typeof p?.catch === 'function') {
      p.catch((err) => {
        logger.error('[loyaltyPoints] side-effect promise rejection', {
          orderId: order.orderId,
          message: err?.message || String(err)
        });
      });
    }
    return p;
  } catch (err) {
    logger.error('[loyaltyPoints] schedule failed', { message: err?.message || String(err) });
    return Promise.resolve(null);
  }
}

async function adminAdjustPoints({
  userId,
  points,
  note = '',
  createdBy = null,
  storefront = 'ecomm'
}) {
  const delta = Math.trunc(Number(points) || 0);
  if (!userId || delta === 0) {
    const err = new Error('points must be a non-zero integer');
    err.statusCode = 400;
    err.code = 'INVALID_POINTS';
    throw err;
  }
  const key = `adjust:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  return applyLedgerDelta({
    userId,
    storefront,
    type: 'adjust',
    points: delta,
    idempotencyKey: key,
    note,
    createdBy,
    meta: { admin: true }
  });
}

async function listLedgerForUser(userId, { page = 1, limit = 20 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = { userId };
  const [items, total] = await Promise.all([
    LoyaltyPointLedger.find(filter)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    LoyaltyPointLedger.countDocuments(filter)
  ]);
  return { items, total, page: p, limit: l };
}

async function listEarnRules(storefront = 'ecomm') {
  return LoyaltyEarnRule.find({ storefront: normalizeStorefront(storefront) })
    .sort({ priority: -1, createdAt: -1 })
    .lean();
}

async function upsertEarnRule(id, body, storefront = 'ecomm') {
  const payload = {
    storefront: normalizeStorefront(storefront),
    name: String(body.name || '').trim(),
    scope: body.scope || 'global',
    categorySlug: body.categorySlug || null,
    productId: body.productId || null,
    earnMultiplier: Number(body.earnMultiplier) || 1,
    earnPointsPerRupeeOverride:
      body.earnPointsPerRupeeOverride != null ? Number(body.earnPointsPerRupeeOverride) : null,
    priority: Math.max(0, Number(body.priority) || 0),
    isActive: body.isActive !== false,
    startsAt: body.startsAt ? new Date(body.startsAt) : null,
    endsAt: body.endsAt ? new Date(body.endsAt) : null
  };
  if (!payload.name) {
    const err = new Error('name is required');
    err.statusCode = 400;
    throw err;
  }
  if (id) {
    return LoyaltyEarnRule.findByIdAndUpdate(id, { $set: payload }, { new: true }).lean();
  }
  return (await LoyaltyEarnRule.create(payload)).toObject();
}

async function deleteEarnRule(id) {
  await LoyaltyEarnRule.findByIdAndDelete(id);
  return { ok: true };
}

function buildOrderLoyaltySnapshot({
  pointsRedeemed = 0,
  discountInr = 0,
  redeemStatus = 'pending'
} = {}) {
  return {
    redeemed: floorPoints(pointsRedeemed),
    discountInr: roundMoney2(discountInr),
    redeemStatus: pointsRedeemed > 0 ? redeemStatus : 'none',
    earned: 0,
    earnStatus: 'pending',
    redeemLedgerId: null,
    earnLedgerId: null,
    clawbackLedgerId: null,
    earnCreditedAt: null,
    clawedBackAt: null
  };
}

function publicUserPointsView(user, settings) {
  const loyalty = user?.loyalty || {};
  const bal = Math.max(0, floorPoints(loyalty.pointsBalance || 0));
  const pub = publicSettingsView(settings);
  return {
    balance: bal,
    lifetimeEarned: Math.max(0, floorPoints(loyalty.pointsLifetimeEarned || 0)),
    lifetimeRedeemed: Math.max(0, floorPoints(loyalty.pointsLifetimeRedeemed || 0)),
    settings: pub.enabled
      ? {
          enabled: true,
          earnPointsPerRupee: pub.earnPointsPerRupee,
          redeemRupeePerPoint: pub.redeemRupeePerPoint,
          minRedeemPoints: pub.minRedeemPoints,
          maxRedeemPercentOfPayable: pub.maxRedeemPercentOfPayable,
          expiryDays: pub.expiryDays,
          stackWithCoupon: pub.stackWithCoupon
        }
      : { enabled: false }
  };
}

function toUserObjectId(userId) {
  if (!userId) return null;
  if (userId instanceof mongoose.Types.ObjectId) return userId;
  const raw = String(userId);
  if (!mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
}

/**
 * Rebuild User.loyalty.points* from ledger (source of truth for deltas + balanceAfter).
 * Fixes balances wiped by older badge recompute that replaced the whole loyalty subdoc.
 */
async function repairUserPointsBalanceFromLedger(userId, { force = false } = {}) {
  const oid = toUserObjectId(userId);
  if (!oid) return { repaired: false, reason: 'invalid_user' };

  const latest = await LoyaltyPointLedger.findOne({ userId: oid })
    .sort({ createdAt: -1, _id: -1 })
    .select('balanceAfter points type createdAt')
    .lean();

  if (!latest) {
    return { repaired: false, reason: 'no_ledger', balance: 0 };
  }

  const expectedBalance = Math.max(0, floorPoints(latest.balanceAfter));
  const user = await User.findById(oid).select('loyalty.pointsBalance loyalty.pointsLifetimeEarned loyalty.pointsLifetimeRedeemed').lean();
  if (!user) return { repaired: false, reason: 'user_not_found' };

  const currentBalance = Math.max(0, floorPoints(user.loyalty?.pointsBalance || 0));
  const currentEarned = Math.max(0, floorPoints(user.loyalty?.pointsLifetimeEarned || 0));
  const currentRedeemed = Math.max(0, floorPoints(user.loyalty?.pointsLifetimeRedeemed || 0));

  const [agg] = await LoyaltyPointLedger.aggregate([
    { $match: { userId: oid } },
    {
      $group: {
        _id: null,
        lifetimeEarned: {
          $sum: {
            $cond: [{ $eq: ['$type', 'earn'] }, { $max: ['$points', 0] }, 0]
          }
        },
        lifetimeRedeemed: {
          $sum: {
            $cond: [{ $eq: ['$type', 'redeem'] }, { $abs: '$points' }, 0]
          }
        }
      }
    }
  ]);

  const lifetimeEarned = Math.max(0, floorPoints(agg?.lifetimeEarned || 0));
  const lifetimeRedeemed = Math.max(0, floorPoints(agg?.lifetimeRedeemed || 0));

  const needsRepair =
    force ||
    currentBalance !== expectedBalance ||
    currentEarned !== lifetimeEarned ||
    currentRedeemed !== lifetimeRedeemed;

  if (!needsRepair) {
    return {
      repaired: false,
      reason: 'in_sync',
      balance: currentBalance,
      lifetimeEarned: currentEarned,
      lifetimeRedeemed: currentRedeemed
    };
  }

  await User.updateOne(
    { _id: oid },
    {
      $set: {
        'loyalty.pointsBalance': expectedBalance,
        'loyalty.pointsLifetimeEarned': lifetimeEarned,
        'loyalty.pointsLifetimeRedeemed': lifetimeRedeemed
      }
    }
  );

  logger.info('[loyaltyPoints] repaired user balance from ledger', {
    userId: String(oid),
    previousBalance: currentBalance,
    balance: expectedBalance,
    lifetimeEarned,
    lifetimeRedeemed
  });

  return {
    repaired: true,
    previousBalance: currentBalance,
    balance: expectedBalance,
    lifetimeEarned,
    lifetimeRedeemed
  };
}

/** Best-effort sync used on read paths (profile / checkout). Never throws. */
async function ensureUserPointsBalanceSynced(userId) {
  try {
    return await repairUserPointsBalanceFromLedger(userId, { force: false });
  } catch (err) {
    logger.error('[loyaltyPoints] ensure balance sync failed', {
      userId: String(userId || ''),
      message: err?.message || String(err)
    });
    return { repaired: false, reason: 'error', message: err?.message || String(err) };
  }
}

/**
 * Batch repair for users whose cached balance drifted from latest ledger.balanceAfter.
 * Production ops / one-shot after badge-wipe bug.
 */
async function repairAllStalePointsBalances({ limit = 500 } = {}) {
  const lim = Math.min(2000, Math.max(1, Math.floor(Number(limit) || 500)));
  const rows = await LoyaltyPointLedger.aggregate([
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: '$userId',
        balanceAfter: { $first: '$balanceAfter' }
      }
    },
    { $limit: lim }
  ]);

  const results = { checked: 0, repaired: 0, skipped: 0, errors: 0 };
  for (const row of rows) {
    results.checked += 1;
    try {
      const out = await repairUserPointsBalanceFromLedger(row._id, { force: false });
      if (out.repaired) results.repaired += 1;
      else results.skipped += 1;
    } catch (_) {
      results.errors += 1;
    }
  }
  return results;
}

module.exports = {
  roundMoney2,
  floorPoints,
  getSettings,
  updateSettings,
  invalidateSettingsCache,
  publicSettingsView,
  getUserPointsBalance,
  computeRedeemQuote,
  attachLoyaltyDiscountToTotals,
  applyLedgerDelta,
  debitRedeemForOrder,
  restoreRedeemForOrder,
  computeEarnPointsForOrder,
  creditEarnForOrder,
  clawbackEarnForOrder,
  scheduleLoyaltyPointsSideEffectsForOrder,
  adminAdjustPoints,
  listLedgerForUser,
  listEarnRules,
  upsertEarnRule,
  deleteEarnRule,
  buildOrderLoyaltySnapshot,
  publicUserPointsView,
  defaultSettingsDoc,
  repairUserPointsBalanceFromLedger,
  ensureUserPointsBalanceSynced,
  repairAllStalePointsBalances
};

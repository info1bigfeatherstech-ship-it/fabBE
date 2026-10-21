/**
 * Customer referral codes (RF-001…) — separate from coupons and loyalty earn rules.
 * Discount is applied at checkout (exclusive with coupons).
 * Reward points credit the code owner via the existing loyalty ledger
 * after prepaid/partial capture at checkout, or when a full COD order is delivered.
 */
const mongoose = require('mongoose');
const ReferralSettings = require('../models/ReferralSettings');
const ReferralCounter = require('../models/ReferralCounter');
const ReferralCode = require('../models/ReferralCode');
const ReferralRedemption = require('../models/ReferralRedemption');
const User = require('../models/User');
const loyaltyPointsService = require('./loyaltyPoints.service');
const logger = require('../utils/logger');

const SETTINGS_CACHE_MS = 15_000;
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

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function isReferralCodeFormat(code) {
  return /^RF-\d+$/i.test(String(code || '').trim());
}

function formatReferralCode(seq) {
  const n = Math.max(1, Math.floor(Number(seq) || 0));
  return `RF-${String(n).padStart(3, '0')}`;
}

function promoError(code, message, statusCode = 400, details) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
}

function defaultSettingsDoc(storefront) {
  return {
    storefront: normalizeStorefront(storefront),
    enabled: true,
    discountType: 'percentage',
    discountValue: 8,
    maxDiscountAmount: null,
    minOrderValue: 0,
    rewardPoints: 80
  };
}

async function getSettings(storefront = 'ecomm', { bypassCache = false } = {}) {
  const sf = normalizeStorefront(storefront);
  const now = Date.now();
  const cached = settingsCache.get(sf);
  if (!bypassCache && cached && now - cached.at < SETTINGS_CACHE_MS) {
    return cached.doc;
  }
  let doc = await ReferralSettings.findOne({ storefront: sf }).lean();
  if (!doc) {
    try {
      doc = (await ReferralSettings.create(defaultSettingsDoc(sf))).toObject();
    } catch (err) {
      doc = await ReferralSettings.findOne({ storefront: sf }).lean();
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

async function attachWalletRedeemRate(settingsDoc, storefront) {
  const sf = normalizeStorefront(storefront || settingsDoc?.storefront);
  let rate = 0;
  try {
    const loyalty = await loyaltyPointsService.getSettings(sf, { bypassCache: true });
    rate = roundMoney2(Number(loyalty?.redeemRupeePerPoint) || 0);
  } catch (err) {
    logger.error('[referral] attach wallet redeem rate failed', {
      storefront: sf,
      message: err?.message || String(err)
    });
  }
  return { ...(settingsDoc || {}), redeemRupeePerPoint: rate };
}

async function getAdminSettings(storefront = 'ecomm') {
  const settings = await getSettings(storefront, { bypassCache: true });
  return attachWalletRedeemRate(settings, storefront);
}

async function updateSettings(storefront, patch, updatedBy = null) {
  const sf = normalizeStorefront(storefront);
  const $set = {};
  if (patch.enabled !== undefined) $set.enabled = Boolean(patch.enabled);
  if (patch.discountType !== undefined) {
    const t = String(patch.discountType || '').toLowerCase();
    if (t !== 'percentage' && t !== 'fixed') {
      throw promoError('INVALID_DISCOUNT_TYPE', 'Discount type must be percentage or fixed');
    }
    $set.discountType = t;
  }
  if (patch.discountValue !== undefined) {
    const v = Number(patch.discountValue);
    if (!Number.isFinite(v) || v < 0) {
      throw promoError('INVALID_DISCOUNT_VALUE', 'Discount value must be 0 or more');
    }
    $set.discountValue = v;
  }
  if (patch.maxDiscountAmount !== undefined) {
    if (patch.maxDiscountAmount == null || patch.maxDiscountAmount === '') {
      $set.maxDiscountAmount = null;
    } else {
      const cap = Number(patch.maxDiscountAmount);
      if (!Number.isFinite(cap) || cap < 0) {
        throw promoError('INVALID_MAX_DISCOUNT', 'Max discount must be 0 or more');
      }
      $set.maxDiscountAmount = cap > 0 ? cap : null;
    }
  }
  if (patch.minOrderValue !== undefined) {
    const min = Number(patch.minOrderValue);
    if (!Number.isFinite(min) || min < 0) {
      throw promoError('INVALID_MIN_ORDER', 'Min order value must be 0 or more');
    }
    $set.minOrderValue = min;
  }
  if (patch.rewardPoints !== undefined) {
    const pts = Math.floor(Number(patch.rewardPoints));
    if (!Number.isFinite(pts) || pts < 0) {
      throw promoError('INVALID_REWARD_POINTS', 'Reward points must be 0 or more');
    }
    $set.rewardPoints = pts;
  }
  if (updatedBy) $set.updatedBy = updatedBy;

  const current = await getSettings(sf, { bypassCache: true });
  const nextType = $set.discountType || current.discountType || 'percentage';
  const nextVal = $set.discountValue !== undefined ? $set.discountValue : Number(current.discountValue) || 0;
  if (nextType === 'percentage' && nextVal > 100) {
    throw promoError('INVALID_DISCOUNT_VALUE', 'Percentage discount cannot exceed 100');
  }

  // Shared wallet rate — never stored on ReferralSettings.
  let nextRate = null;
  if (patch.redeemRupeePerPoint !== undefined) {
    try {
      nextRate = loyaltyPointsService.normalizeRedeemRupeePerPoint(patch.redeemRupeePerPoint);
    } catch (err) {
      throw promoError(err?.code || 'INVALID_REDEEM_RATE', err?.message || 'Invalid ₹ per point');
    }
  }

  if (nextRate != null) {
    await loyaltyPointsService.updateSettings(
      sf,
      { redeemRupeePerPoint: nextRate },
      updatedBy
    );
  }

  const doc = await ReferralSettings.findOneAndUpdate(
    { storefront: sf },
    { $set, $setOnInsert: { storefront: sf } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  invalidateSettingsCache(sf);
  return attachWalletRedeemRate(doc, sf);
}

function capturedAmountInr(order) {
  const n = Number(order?.amountPaidInr || 0);
  return Number.isFinite(n) ? n : 0;
}

function paymentMethodOf(order) {
  return String(order?.paymentInfo?.method || '').trim().toLowerCase();
}

/**
 * Money captured on prepaid / partial — independent of admin accept / orderStatus.
 * orderStatus pending (awaiting approval) must still credit.
 */
function isPrepaidOrPartialPaid(order) {
  const pay = String(order?.paymentStatus || '').toLowerCase();
  if (pay === 'paid' || pay === 'partially_paid') return true;
  const method = paymentMethodOf(order);
  if (method === 'cod') return false;
  return capturedAmountInr(order) > 0.01;
}

function isFullCodOrder(order) {
  return paymentMethodOf(order) === 'cod' && !isPrepaidOrPartialPaid(order);
}

function isCodDelivered(order) {
  const status = String(order?.orderStatus || '').toLowerCase();
  return isFullCodOrder(order) && status === 'delivered';
}

function canCreditReferralReward(order) {
  return isPrepaidOrPartialPaid(order) || isCodDelivered(order);
}

function humanizeSyncReason(code, order) {
  const key = String(code || '').trim();
  if (!key) return '';
  if (key === 'awaiting_cod_delivery' || key === 'reopened_until_delivered') {
    return 'COD — points credit when the order is delivered';
  }
  if (key === 'not_eligible_yet') {
    return isFullCodOrder(order)
      ? 'COD — points credit when the order is delivered'
      : 'Waiting for prepaid / partial payment';
  }
  if (key === 'order_missing') return 'Order was not found';
  if (key === 'no_redemption') return 'Referral was not reserved on this order';
  if (key === 'no_order') return 'Order is missing';
  if (key === 'already_completed' || key === 'already_credited') return '';
  if (key === 'zero_points') return 'Reward points are set to 0';
  if (key === 'clawed_back' || key === 'already_clawed') return 'Points were reversed';
  if (key === 'voided' || key === 'already_voided') return 'Referral was cancelled';
  if (key === 'unpaid_cancel') return 'Order was cancelled before payment';
  return key.replace(/_/g, ' ');
}

/** Wallet points actually given (skipped COD rows have rewardCredited=false). */
function awardedPointsFromRedemption(row) {
  if (!row) return 0;
  if (row.rewardCredited === false) return 0;
  return floorPoints(row.rewardPoints || 0);
}

const AWARDED_POINTS_SUM = {
  $sum: {
    $cond: [{ $eq: ['$rewardCredited', false] }, 0, '$rewardPoints']
  }
};

function publicSettingsView(settings) {
  const s = settings || defaultSettingsDoc('ecomm');
  return {
    enabled: Boolean(s.enabled),
    discountType: s.discountType === 'fixed' ? 'fixed' : 'percentage',
    discountValue: Number(s.discountValue) || 0,
    maxDiscountAmount:
      s.maxDiscountAmount != null && Number(s.maxDiscountAmount) > 0
        ? roundMoney2(s.maxDiscountAmount)
        : null,
    minOrderValue: roundMoney2(s.minOrderValue || 0),
    rewardPoints: floorPoints(s.rewardPoints || 0)
  };
}

function computeDiscountFromSettings(settings, subtotal) {
  const sub = roundMoney2(subtotal);
  if (!(sub > 0)) return 0;
  const min = roundMoney2(settings.minOrderValue || 0);
  if (min > 0 && sub + 0.001 < min) return 0;
  const val = Number(settings.discountValue) || 0;
  if (!(val > 0)) return 0;
  let discount = 0;
  if (settings.discountType === 'fixed') {
    discount = val;
  } else {
    discount = (sub * val) / 100;
    const cap = Number(settings.maxDiscountAmount);
    if (Number.isFinite(cap) && cap > 0) discount = Math.min(discount, cap);
  }
  return roundMoney2(Math.min(discount, sub));
}

async function generateCodeForUser(userId, storefront = 'ecomm') {
  const sf = normalizeStorefront(storefront);
  if (!userId) throw promoError('UNAUTHORIZED', 'Please log in', 401);
  const settings = await getSettings(sf);
  if (!settings.enabled) {
    throw promoError('REFERRAL_DISABLED', 'Referrals are not available right now', 400);
  }

  const existing = await ReferralCode.findOne({ storefront: sf, ownerUserId: userId }).lean();
  if (existing) return existing;

  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const counter = await ReferralCounter.findOneAndUpdate(
      { storefront: sf },
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    const seq = Math.max(1, Number(counter.seq) || 1);
    const code = formatReferralCode(seq);
    try {
      return (await ReferralCode.create({
        storefront: sf,
        code,
        seq,
        ownerUserId: userId,
        generatedAt: new Date()
      })).toObject();
    } catch (err) {
      lastErr = err;
      if (err && err.code === 11000) {
        const raced = await ReferralCode.findOne({ storefront: sf, ownerUserId: userId }).lean();
        if (raced) return raced;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || promoError(
    'REFERRAL_GENERATE_FAILED',
    'Could not generate a referral code. Please try again.',
    503
  );
}

async function getCodeForUser(userId, storefront = 'ecomm') {
  if (!userId) return null;
  return ReferralCode.findOne({
    storefront: normalizeStorefront(storefront),
    ownerUserId: userId
  }).lean();
}

async function persistReferralOrderFlags(order) {
  if (
    order &&
    typeof order.save === 'function' &&
    (order.isModified?.('appliedReferral') || order.isModified?.('loyaltyPoints'))
  ) {
    await order.save();
  }
}

async function stampRedemptionSync(orderId, reason, { clear = false } = {}) {
  if (!orderId) return;
  try {
    const $set = { lastSyncedAt: new Date() };
    if (clear) $set.lastSyncReason = null;
    else if (reason) $set.lastSyncReason = String(reason).slice(0, 120);
    await ReferralRedemption.updateOne({ orderId }, { $set });
  } catch (err) {
    logger.warn('[referral] stamp sync reason failed', {
      orderId,
      message: err?.message || String(err)
    });
  }
}

function noteFromSyncResult(order, result) {
  if (!result) {
    return {
      code: 'no_sync',
      message: humanizeSyncReason('not_eligible_yet', order)
    };
  }
  const code = result.reason || (result.skipped ? 'skipped' : 'credited');
  if (!result.skipped || code === 'already_completed' || code === 'already_credited' || code === 'idempotent') {
    return null;
  }
  return { code, message: humanizeSyncReason(code, order) || result.message || code };
}

async function ensureRedemptionFromAppliedOrder(order) {
  if (!order?.orderId || !order.appliedReferral?.code) return null;
  const existing = await ReferralRedemption.findOne({ orderId: order.orderId });
  if (existing) return existing;
  const sf = normalizeStorefront(order.storefront || 'ecomm');
  const code = normalizeCode(order.appliedReferral.code);
  const row = await ReferralCode.findOne({ storefront: sf, code }).lean();
  if (!row) return null;
  const settings = await getSettings(sf);
  await reserveRedemptionForOrder(order, {
    code: row.code,
    referralCodeId: row._id,
    ownerUserId: order.appliedReferral.ownerUserId || row.ownerUserId,
    discount: order.appliedReferral.discount,
    discountType: order.appliedReferral.discountType,
    discountValue: order.appliedReferral.discountValue,
    rewardPoints: order.appliedReferral.rewardPoints || settings.rewardPoints
  });
  return ReferralRedemption.findOne({ orderId: order.orderId });
}

async function reconcileReservedRedemptions(code, storefront, notes) {
  const sf = normalizeStorefront(storefront);
  const reserved = await ReferralRedemption.find({
    storefront: sf,
    code,
    $or: [
      { status: 'reserved' },
      { status: 'completed', rewardCredited: false }
    ]
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  if (!reserved.length) return;

  const Order = require('../models/Order');
  const orderIds = reserved.map((r) => r.orderId).filter(Boolean);
  const orders = await Order.find({ orderId: { $in: orderIds } });
  const byOrderId = new Map(orders.map((o) => [String(o.orderId), o]));

  for (const row of reserved) {
    const orderId = String(row.orderId || '');
    const order = byOrderId.get(orderId);
    if (!order) {
      logger.warn('[referral] reconcile skipped — order missing', { orderId, code });
      await stampRedemptionSync(orderId, 'order_missing');
      notes?.set(orderId, { code: 'order_missing', message: 'Order was not found' });
      continue;
    }
    try {
      const result = await syncReferralForOrder(order, { reason: 'reconcile_reserved' });
      await persistReferralOrderFlags(order);
      const note = noteFromSyncResult(order, result);
      if (note) {
        await stampRedemptionSync(orderId, note.code);
        notes?.set(orderId, note);
      } else {
        await stampRedemptionSync(orderId, null, { clear: true });
      }
      logger.info('[referral] reconcile reserved', {
        orderId,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        skipped: Boolean(result?.skipped),
        reason: result?.reason || null
      });
    } catch (err) {
      logger.error('[referral] reconcile reserved failed', {
        orderId,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        message: err?.message || String(err)
      });
      await stampRedemptionSync(orderId, 'sync_failed');
      notes?.set(orderId, {
        code: 'sync_failed',
        message: err?.message || 'Could not credit points'
      });
    }
  }
}

async function healOwnerReferralState(code, storefront) {
  const sf = normalizeStorefront(storefront);
  const notes = new Map();
  await reconcileReservedRedemptions(code, sf, notes);

  const Order = require('../models/Order');
  const appliedOrders = await Order.find({
    storefront: sf,
    'appliedReferral.code': code,
    $or: [
      { paymentStatus: { $in: ['paid', 'partially_paid'] } },
      { amountPaidInr: { $gt: 0.01 } },
      { orderStatus: 'delivered' }
    ]
  })
    .sort({ createdAt: -1 })
    .limit(50);

  for (const order of appliedOrders) {
    const orderId = String(order?.orderId || '');
    try {
      await ensureRedemptionFromAppliedOrder(order);
      const result = await syncReferralForOrder(order, { reason: 'heal_applied_order' });
      await persistReferralOrderFlags(order);
      const note = noteFromSyncResult(order, result);
      if (note) {
        await stampRedemptionSync(orderId, note.code);
        notes.set(orderId, note);
      } else {
        await stampRedemptionSync(orderId, null, { clear: true });
      }
    } catch (err) {
      logger.error('[referral] heal applied order failed', {
        orderId,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        message: err?.message || String(err)
      });
      await stampRedemptionSync(orderId, 'sync_failed');
      notes.set(orderId, {
        code: 'sync_failed',
        message: err?.message || 'Could not credit points'
      });
    }
  }
  return notes;
}

function publicLedgerRow(row) {
  if (!row) return null;
  const pts = Math.trunc(Number(row.points) || 0);
  const type = String(row.type || 'adjust');
  const hidesRefereeOrder =
    type === 'referral_reward' || type === 'referral_clawback';
  return {
    id: String(row._id),
    type,
    points: pts,
    orderId: hidesRefereeOrder ? null : row.orderId || null,
    rupeeValue: roundMoney2(row.rupeeValue || 0),
    note: row.note || '',
    createdAt: row.createdAt || null
  };
}

async function walletViewForUser(userId, storefront) {
  const empty = {
    balance: 0,
    lifetimeEarned: 0,
    lifetimeRedeemed: 0,
    approxInr: 0,
    usedApproxInr: 0,
    redeemRupeePerPoint: 0,
    loyaltyEnabled: false,
    canRedeem: false
  };
  try {
    const loyaltySettings = await loyaltyPointsService.getSettings(storefront);
    if (userId && typeof loyaltyPointsService.ensureUserPointsBalanceSynced === 'function') {
      await loyaltyPointsService.ensureUserPointsBalanceSynced(userId);
    }
    let balance = 0;
    let lifetimeEarned = 0;
    let lifetimeRedeemed = 0;
    if (userId) {
      const user = await User.findById(userId)
        .select('loyalty.pointsBalance loyalty.pointsLifetimeEarned loyalty.pointsLifetimeRedeemed')
        .lean();
      balance = floorPoints(user?.loyalty?.pointsBalance || 0);
      lifetimeEarned = floorPoints(user?.loyalty?.pointsLifetimeEarned || 0);
      lifetimeRedeemed = floorPoints(user?.loyalty?.pointsLifetimeRedeemed || 0);
    }
    const rate = Number(loyaltySettings?.redeemRupeePerPoint) || 0;
    const approxInr = rate > 0 ? roundMoney2(balance * rate) : 0;
    const usedApproxInr = rate > 0 ? roundMoney2(lifetimeRedeemed * rate) : 0;
    return {
      balance,
      lifetimeEarned,
      lifetimeRedeemed,
      approxInr,
      usedApproxInr,
      redeemRupeePerPoint: rate,
      loyaltyEnabled: Boolean(loyaltySettings?.enabled),
      canRedeem: balance > 0 && rate > 0
    };
  } catch (err) {
    logger.error('[referral] wallet view failed', {
      userId: userId ? String(userId) : '',
      message: err?.message || String(err)
    });
    return empty;
  }
}

async function getMyReferral(userId, storefront = 'ecomm') {
  const sf = normalizeStorefront(storefront);
  const settings = await getSettings(sf);
  const codeDoc = userId ? await getCodeForUser(userId, sf) : null;
  const used = userId ? await refereeHasUsedReferral(sf, userId) : null;
  let stats = { completedUses: 0, pendingUses: 0, pointsAwarded: 0 };
  if (codeDoc?.code) {
    try {
      await healOwnerReferralState(codeDoc.code, sf);
    } catch (err) {
      logger.error('[referral] heal owner state failed', {
        userId: String(userId),
        code: codeDoc.code,
        message: err?.message || String(err)
      });
    }
    const [completed, pendingUses] = await Promise.all([
      ReferralRedemption.aggregate([
        { $match: { storefront: sf, code: codeDoc.code, status: 'completed' } },
        { $group: { _id: null, count: { $sum: 1 }, points: AWARDED_POINTS_SUM } }
      ]),
      ReferralRedemption.countDocuments({ storefront: sf, code: codeDoc.code, status: 'reserved' })
    ]);
    stats = {
      completedUses: completed[0]?.count || 0,
      pendingUses: pendingUses || 0,
      pointsAwarded: floorPoints(completed[0]?.points || 0)
    };
  }
  const wallet = await walletViewForUser(userId, sf);
  let ledger = { items: [], total: 0, failed: false };
  if (userId) {
    try {
      const raw = await loyaltyPointsService.listLedgerForUser(userId, { page: 1, limit: 30 });
      ledger = {
        items: (raw.items || []).map(publicLedgerRow).filter(Boolean),
        total: Number(raw.total) || 0,
        failed: false
      };
    } catch (err) {
      logger.error('[referral] ledger fetch failed', {
        userId: String(userId),
        message: err?.message || String(err)
      });
      ledger = { items: [], total: 0, failed: true };
    }
  }
  return {
    settings: publicSettingsView(settings),
    code: codeDoc
      ? { code: codeDoc.code, generatedAt: codeDoc.generatedAt || codeDoc.createdAt }
      : null,
    stats: {
      ...stats,
      pointsUsed: wallet.lifetimeRedeemed || 0
    },
    wallet,
    activity: [],
    ledger,
    alreadyUsedAsReferee: Boolean(used)
  };
}

async function refereeHasUsedReferral(storefront, refereeUserId) {
  if (!refereeUserId) return false;
  const found = await ReferralRedemption.findOne({
    storefront: normalizeStorefront(storefront),
    refereeUserId,
    status: { $in: ['reserved', 'completed', 'clawed_back'] }
  })
    .select('_id status orderId')
    .lean();
  return found || null;
}

async function quoteDiscount({ code, subtotal, refereeUserId, storefront = 'ecomm' }) {
  const sf = normalizeStorefront(storefront);
  const normalized = normalizeCode(code);
  if (!normalized) {
    throw promoError('REFERRAL_CODE_REQUIRED', 'Enter a referral code');
  }
  if (!isReferralCodeFormat(normalized)) {
    throw promoError('REFERRAL_CODE_INVALID', 'That is not a valid referral code');
  }
  if (!refereeUserId) {
    throw promoError('UNAUTHORIZED', 'Please log in to apply a referral code', 401);
  }

  const settings = await getSettings(sf);
  if (!settings.enabled) {
    throw promoError('REFERRAL_DISABLED', 'Referrals are not available right now');
  }

  const row = await ReferralCode.findOne({ storefront: sf, code: normalized }).lean();
  if (!row) {
    throw promoError('REFERRAL_NOT_FOUND', 'Referral code not found');
  }
  if (String(row.ownerUserId) === String(refereeUserId)) {
    throw promoError('REFERRAL_OWN_CODE', 'You cannot use your own referral code');
  }

  const used = await refereeHasUsedReferral(sf, refereeUserId);
  if (used) {
    throw promoError(
      'REFERRAL_ALREADY_USED',
      'You have already used a referral code. Each customer can use one referral once.'
    );
  }

  const min = roundMoney2(settings.minOrderValue || 0);
  const sub = roundMoney2(subtotal);
  if (min > 0 && sub + 0.001 < min) {
    throw promoError(
      'REFERRAL_MIN_ORDER_NOT_MET',
      `Minimum order value of ₹${min} required to use this referral code`,
      400,
      { minOrderValue: min, subtotal: sub }
    );
  }

  const discount = computeDiscountFromSettings(settings, sub);
  if (!(discount > 0)) {
    throw promoError('REFERRAL_NO_DISCOUNT', 'This referral does not add a discount on this bag');
  }

  return {
    code: row.code,
    referralCodeId: row._id,
    ownerUserId: row.ownerUserId,
    discount,
    discountType: settings.discountType,
    discountValue: settings.discountValue,
    maxDiscountAmount: settings.maxDiscountAmount || null,
    minOrderValue: min,
    rewardPoints: floorPoints(settings.rewardPoints || 0)
  };
}

async function reserveRedemptionForOrder(order, quoted, { session = null } = {}) {
  if (!order?.orderId || !quoted?.code || !order.userId) {
    return { skipped: true, reason: 'missing' };
  }
  const sf = normalizeStorefront(order.storefront || 'ecomm');
  const payload = {
    storefront: sf,
    code: quoted.code,
    referralCodeId: quoted.referralCodeId,
    ownerUserId: quoted.ownerUserId,
    refereeUserId: order.userId,
    orderId: order.orderId,
    orderMongoId: order._id || null,
    discountInr: roundMoney2(quoted.discount || 0),
    discountType: quoted.discountType || 'percentage',
    discountValue: Number(quoted.discountValue) || 0,
    rewardPoints: floorPoints(quoted.rewardPoints || 0),
    status: 'reserved'
  };

  try {
    const created = await ReferralRedemption.create(
      [payload],
      session ? { session } : undefined
    );
    return { skipped: false, redemption: Array.isArray(created) ? created[0] : created };
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await ReferralRedemption.findOne({ orderId: order.orderId })
        .session(session || null)
        .lean();
      if (existing) return { skipped: true, reason: 'idempotent', redemption: existing };
      throw promoError(
        'REFERRAL_ALREADY_USED',
        'You have already used a referral code. Each customer can use one referral once.',
        409
      );
    }
    throw err;
  }
}

async function creditReferrerForOrder(order, { session = null, reason = 'payment_success' } = {}) {
  if (!order?.orderId) return { skipped: true, reason: 'no_order' };
  if (!canCreditReferralReward(order)) {
    const skipReason = isFullCodOrder(order) ? 'awaiting_cod_delivery' : 'not_eligible_yet';
    logger.info('[referral] credit skipped', {
      orderId: order.orderId,
      reason: skipReason,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      amountPaidInr: order.amountPaidInr || 0
    });
    await stampRedemptionSync(order.orderId, skipReason);
    return { skipped: true, reason: skipReason };
  }
  const redemption = await ReferralRedemption.findOne({ orderId: order.orderId }).session(
    session || null
  );
  if (!redemption) {
    logger.warn('[referral] credit skipped — no redemption', { orderId: order.orderId });
    return { skipped: true, reason: 'no_redemption' };
  }
  if (redemption.status === 'clawed_back') return { skipped: true, reason: 'clawed_back' };
  if (redemption.status === 'voided') return { skipped: true, reason: 'voided' };
  if (redemption.status === 'completed') {
    const credited = redemption.rewardCredited === true || Boolean(redemption.rewardLedgerId);
    if (credited) return { skipped: true, reason: 'already_completed' };
  }

  const points = floorPoints(redemption.rewardPoints);
  if (!(points > 0)) {
    redemption.status = 'completed';
    redemption.completedAt = new Date();
    redemption.rewardCredited = false;
    redemption.rewardSkipReason = 'zero_points';
    await redemption.save(session ? { session } : undefined);
    if (order.appliedReferral && typeof order.appliedReferral === 'object') {
      order.appliedReferral.rewardStatus = 'skipped';
      if (typeof order.markModified === 'function') order.markModified('appliedReferral');
    }
    return { skipped: true, reason: 'zero_points' };
  }

  let rupeeValue = 0;
  try {
    const loyaltySettings = await loyaltyPointsService.getSettings(redemption.storefront);
    const rate = Number(loyaltySettings?.redeemRupeePerPoint) || 0;
    if (rate > 0) rupeeValue = roundMoney2(points * rate);
  } catch (_) {
    rupeeValue = 0;
  }

  const result = await loyaltyPointsService.applyLedgerDelta({
    userId: redemption.ownerUserId,
    storefront: redemption.storefront,
    type: 'referral_reward',
    points,
    idempotencyKey: `referral_reward:${order.orderId}`,
    orderId: order.orderId,
    orderMongoId: order._id || redemption.orderMongoId || null,
    rupeeValue,
    meta: {
      reason,
      refereeUserId: String(redemption.refereeUserId),
      referralCode: redemption.code
    },
    note: `Referral reward (${redemption.code})`,
    session
  });

  if (!result.skipped || result.reason === 'idempotent' || result.reason === 'idempotent_race') {
    redemption.status = 'completed';
    redemption.completedAt = new Date();
    redemption.rewardCredited = true;
    redemption.rewardSkipReason = null;
    redemption.rewardLedgerId = result.entry?._id || redemption.rewardLedgerId;
    await redemption.save(session ? { session } : undefined);
    await stampRedemptionSync(order.orderId, null, { clear: true });
    if (order.appliedReferral && typeof order.appliedReferral === 'object') {
      order.appliedReferral.rewardStatus = 'credited';
      if (typeof order.markModified === 'function') order.markModified('appliedReferral');
    }
    logger.info('[referral] credited', {
      orderId: order.orderId,
      points,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus
    });
    return result;
  }

  logger.warn('[referral] ledger did not apply', {
    orderId: order.orderId,
    reason: result.reason || null
  });
  await stampRedemptionSync(order.orderId, result.reason || 'ledger_skipped');
  return result;
}

async function voidRedemptionForOrder(order, { session = null, reason = 'void' } = {}) {
  if (!order?.orderId) return { skipped: true, reason: 'no_order' };
  const redemption = await ReferralRedemption.findOne({ orderId: order.orderId }).session(
    session || null
  );
  if (!redemption) return { skipped: true, reason: 'no_redemption' };
  if (redemption.status === 'clawed_back') {
    return { skipped: true, reason: redemption.status };
  }
  if (redemption.status === 'completed') {
    const credited = redemption.rewardCredited === true || Boolean(redemption.rewardLedgerId);
    if (credited) return { skipped: true, reason: 'completed' };
  }
  if (redemption.status === 'voided') return { skipped: true, reason: 'already_voided' };
  redemption.status = 'voided';
  redemption.voidedAt = new Date();
  await redemption.save(session ? { session } : undefined);
  if (order.appliedReferral && typeof order.appliedReferral === 'object') {
    order.appliedReferral.rewardStatus = 'voided';
    if (typeof order.markModified === 'function') order.markModified('appliedReferral');
  }
  logger.info('[referral] voided redemption', { orderId: order.orderId, reason });
  return { skipped: false, reason };
}

async function clawbackReferrerForOrder(order, { session = null, reason = 'clawback' } = {}) {
  if (!order?.orderId) return { skipped: true, reason: 'no_order' };
  const redemption = await ReferralRedemption.findOne({ orderId: order.orderId }).session(
    session || null
  );
  if (!redemption) return { skipped: true, reason: 'no_redemption' };
  if (redemption.status === 'clawed_back') return { skipped: true, reason: 'already_clawed' };
  if (redemption.status === 'voided') return { skipped: true, reason: 'voided' };
  if (redemption.status !== 'completed') {
    return voidRedemptionForOrder(order, { session, reason });
  }

  const credited = redemption.rewardCredited === true || Boolean(redemption.rewardLedgerId);
  if (!credited) {
    redemption.status = 'clawed_back';
    redemption.clawedBackAt = new Date();
    await redemption.save(session ? { session } : undefined);
    if (order.appliedReferral && typeof order.appliedReferral === 'object') {
      order.appliedReferral.rewardStatus = 'clawed_back';
      if (typeof order.markModified === 'function') order.markModified('appliedReferral');
    }
    return { skipped: true, reason: 'no_points_to_claw' };
  }

  const points = floorPoints(redemption.rewardPoints);
  if (points > 0) {
    const balance = await loyaltyPointsService.getUserPointsBalance(
      redemption.ownerUserId,
      session
    );
    const claw = Math.min(points, balance);
    if (claw > 0) {
      await loyaltyPointsService.applyLedgerDelta({
        userId: redemption.ownerUserId,
        storefront: redemption.storefront,
        type: 'referral_clawback',
        points: -claw,
        idempotencyKey: `referral_clawback:${order.orderId}`,
        orderId: order.orderId,
        orderMongoId: order._id || redemption.orderMongoId || null,
        meta: { reason, requested: points, applied: claw, referralCode: redemption.code },
        note: `Referral reward reversed (${redemption.code})`,
        session
      });
    }
  }

  redemption.status = 'clawed_back';
  redemption.clawedBackAt = new Date();
  await redemption.save(session ? { session } : undefined);
  if (order.appliedReferral && typeof order.appliedReferral === 'object') {
    order.appliedReferral.rewardStatus = 'clawed_back';
    if (typeof order.markModified === 'function') order.markModified('appliedReferral');
  }
  return { skipped: false, reason };
}

async function finalizeRedemptionWithoutReward(order, { session = null, reason = 'cod_no_reward' } = {}) {
  if (!order?.orderId) return { skipped: true, reason: 'no_order' };
  const redemption = await ReferralRedemption.findOne({ orderId: order.orderId }).session(
    session || null
  );
  if (!redemption) return { skipped: true, reason: 'no_redemption' };
  if (redemption.status === 'completed') return { skipped: true, reason: 'already_completed' };
  if (redemption.status === 'clawed_back') return { skipped: true, reason: 'clawed_back' };
  if (redemption.status === 'voided') return { skipped: true, reason: 'already_voided' };

  redemption.status = 'completed';
  redemption.completedAt = new Date();
  redemption.rewardCredited = false;
  redemption.rewardSkipReason = reason || 'cod_no_reward';
  await redemption.save(session ? { session } : undefined);

  if (order.appliedReferral && typeof order.appliedReferral === 'object') {
    order.appliedReferral.rewardStatus = 'skipped';
    if (typeof order.markModified === 'function') order.markModified('appliedReferral');
  }
  logger.info('[referral] completed without reward', { orderId: order.orderId, reason });
  return { skipped: true, reason: redemption.rewardSkipReason };
}

async function reopenSkippedCodRedemption(order, { session = null } = {}) {
  if (!order?.orderId) return { skipped: true, reason: 'no_order' };
  const redemption = await ReferralRedemption.findOne({ orderId: order.orderId }).session(
    session || null
  );
  if (!redemption) return { skipped: true, reason: 'no_redemption' };
  if (redemption.status !== 'completed') return { skipped: true, reason: redemption.status };
  const credited = redemption.rewardCredited === true || Boolean(redemption.rewardLedgerId);
  if (credited) return { skipped: true, reason: 'already_credited' };

  redemption.status = 'reserved';
  redemption.completedAt = null;
  redemption.rewardCredited = false;
  redemption.rewardSkipReason = null;
  await redemption.save(session ? { session } : undefined);
  if (order.appliedReferral && typeof order.appliedReferral === 'object') {
    order.appliedReferral.rewardStatus = 'pending';
    if (typeof order.markModified === 'function') order.markModified('appliedReferral');
  }
  logger.info('[referral] reopened skipped COD until delivered', { orderId: order.orderId });
  return { skipped: false, reason: 'reopened_until_delivered' };
}

async function syncReferralForOrder(order, options = {}) {
  try {
    if (!order?.orderId) return null;
    const pay = String(order.paymentStatus || '').toLowerCase();
    const status = String(order.orderStatus || '').toLowerCase();
    const returnStatus = String(order?.returnInfo?.status || '').toLowerCase();

    const paidLike = isPrepaidOrPartialPaid(order);
    const isRto = status === 'rto';
    const isReturnRefunded = returnStatus === 'refunded';
    const unpaidDead =
      status === 'cancelled' ||
      status === 'payment_failed' ||
      pay === 'failed';

    if (isRto || isReturnRefunded) {
      return clawbackReferrerForOrder(order, { reason: isRto ? 'rto' : 'return_refund' });
    }
    if (unpaidDead && !paidLike) {
      return voidRedemptionForOrder(order, { reason: options.reason || 'unpaid_cancel' });
    }
    if (paidLike) {
      return creditReferrerForOrder(order, { reason: options.reason || 'payment_success' });
    }
    if (isCodDelivered(order)) {
      return creditReferrerForOrder(order, { reason: options.reason || 'cod_delivered' });
    }
    if (isFullCodOrder(order)) {
      return reopenSkippedCodRedemption(order);
    }
    logger.info('[referral] sync idle', {
      orderId: order.orderId,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus
    });
    return { skipped: true, reason: 'not_eligible_yet' };
  } catch (err) {
    logger.error('[referral] sync failed', {
      orderId: order?.orderId,
      paymentStatus: order?.paymentStatus,
      orderStatus: order?.orderStatus,
      message: err?.message || String(err)
    });
    return { skipped: true, reason: 'sync_failed', message: err?.message || String(err) };
  }
}

function scheduleReferralSideEffectsForOrder(order, options = {}) {
  const p = Promise.resolve()
    .then(() => syncReferralForOrder(order, options))
    .catch((err) => {
      logger.error('[referral] side-effect rejected', {
        orderId: order?.orderId,
        message: err?.message || String(err)
      });
    });
  return p;
}

async function listCodesForAdmin({ storefront = 'ecomm', page = 1, limit = 20, search = '' } = {}) {
  const sf = normalizeStorefront(storefront);
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const q = String(search || '').trim();
  const filter = { storefront: sf };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (mongoose.Types.ObjectId.isValid(q) && String(new mongoose.Types.ObjectId(q)) === q) {
      filter.$or = [{ code: rx }, { ownerUserId: q }];
    } else {
      filter.code = rx;
    }
  }

  const [rows, total] = await Promise.all([
    ReferralCode.find(filter)
      .sort({ seq: 1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    ReferralCode.countDocuments(filter)
  ]);

  const ownerIds = rows.map((r) => r.ownerUserId).filter(Boolean);
  const users = ownerIds.length
    ? await User.find({ _id: { $in: ownerIds } }).select('name email phone').lean()
    : [];
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const codes = rows.map((r) => r.code);
  const [completed, reserved] = await Promise.all([
    ReferralRedemption.aggregate([
      { $match: { storefront: sf, code: { $in: codes }, status: 'completed' } },
      { $group: { _id: '$code', count: { $sum: 1 }, points: AWARDED_POINTS_SUM } }
    ]),
    ReferralRedemption.aggregate([
      { $match: { storefront: sf, code: { $in: codes }, status: 'reserved' } },
      { $group: { _id: '$code', count: { $sum: 1 } } }
    ])
  ]);
  const completedMap = new Map(completed.map((x) => [x._id, x]));
  const reservedMap = new Map(reserved.map((x) => [x._id, x]));

  const items = rows.map((row) => {
    const owner = userMap.get(String(row.ownerUserId));
    const done = completedMap.get(row.code);
    return {
      id: String(row._id),
      code: row.code,
      seq: row.seq,
      generatedAt: row.generatedAt || row.createdAt,
      owner: owner
        ? {
            id: String(owner._id),
            name: owner.name || '',
            email: owner.email || '',
            phone: owner.phone || ''
          }
        : { id: String(row.ownerUserId), name: '', email: '', phone: '' },
      completedUses: done?.count || 0,
      pendingUses: reservedMap.get(row.code)?.count || 0,
      pointsAwarded: done?.points || 0
    };
  });

  return { items, total, page: p, limit: l };
}

async function getCodeDetailForAdmin(code, storefront = 'ecomm') {
  const sf = normalizeStorefront(storefront);
  const normalized = normalizeCode(code);
  const row = await ReferralCode.findOne({ storefront: sf, code: normalized }).lean();
  if (!row) return null;
  const owner = await User.findById(row.ownerUserId).select('name email phone').lean();
  const redemptions = await ReferralRedemption.find({ storefront: sf, code: normalized })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  const refereeIds = redemptions.map((r) => r.refereeUserId).filter(Boolean);
  const referees = refereeIds.length
    ? await User.find({ _id: { $in: refereeIds } }).select('name email phone').lean()
    : [];
  const refereeMap = new Map(referees.map((u) => [String(u._id), u]));

  return {
    code: row.code,
    seq: row.seq,
    generatedAt: row.generatedAt || row.createdAt,
    owner: owner
      ? {
          id: String(owner._id),
          name: owner.name || '',
          email: owner.email || '',
          phone: owner.phone || ''
        }
      : { id: String(row.ownerUserId), name: '', email: '', phone: '' },
    uses: redemptions.map((r) => {
      const u = refereeMap.get(String(r.refereeUserId));
      return {
        id: String(r._id),
        status: r.status,
        orderId: r.orderId,
        discountInr: roundMoney2(r.discountInr || 0),
        rewardPoints: awardedPointsFromRedemption(r),
        rewardCredited: r.rewardCredited !== false && Boolean(r.rewardLedgerId || r.rewardCredited),
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        referee: u
          ? {
              id: String(u._id),
              name: u.name || '',
              email: u.email || '',
              phone: u.phone || ''
            }
          : { id: String(r.refereeUserId), name: '', email: '', phone: '' }
      };
    })
  };
}

async function listRedemptionsForAdmin({
  storefront = 'ecomm',
  page = 1,
  limit = 20,
  status = '',
  search = ''
} = {}) {
  const sf = normalizeStorefront(storefront);
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = { storefront: sf };
  const st = String(status || '').trim().toLowerCase();
  if (['reserved', 'completed', 'voided', 'clawed_back'].includes(st)) {
    filter.status = st;
  }
  const q = String(search || '').trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ code: rx }, { orderId: rx }];
  }

  const [rows, total] = await Promise.all([
    ReferralRedemption.find(filter)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    ReferralRedemption.countDocuments(filter)
  ]);

  const userIds = [
    ...rows.map((r) => r.ownerUserId),
    ...rows.map((r) => r.refereeUserId)
  ].filter(Boolean);
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } }).select('name email phone').lean()
    : [];
  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const toUser = (id) => {
    const u = userMap.get(String(id));
    return u
      ? { id: String(u._id), name: u.name || '', email: u.email || '', phone: u.phone || '' }
      : { id: String(id || ''), name: '', email: '', phone: '' };
  };

  return {
    items: rows.map((r) => ({
      id: String(r._id),
      code: r.code,
      status: r.status,
      orderId: r.orderId,
      discountInr: roundMoney2(r.discountInr || 0),
      rewardPoints: awardedPointsFromRedemption(r),
      rewardCredited: r.rewardCredited !== false && Boolean(r.rewardLedgerId || r.rewardCredited),
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      owner: toUser(r.ownerUserId),
      referee: toUser(r.refereeUserId)
    })),
    total,
    page: p,
    limit: l
  };
}

module.exports = {
  isReferralCodeFormat,
  normalizeCode,
  formatReferralCode,
  getSettings,
  getAdminSettings,
  updateSettings,
  publicSettingsView,
  generateCodeForUser,
  getCodeForUser,
  getMyReferral,
  quoteDiscount,
  computeDiscountFromSettings,
  reserveRedemptionForOrder,
  creditReferrerForOrder,
  finalizeRedemptionWithoutReward,
  voidRedemptionForOrder,
  clawbackReferrerForOrder,
  isPrepaidOrPartialPaid,
  syncReferralForOrder,
  scheduleReferralSideEffectsForOrder,
  listCodesForAdmin,
  getCodeDetailForAdmin,
  listRedemptionsForAdmin,
  defaultSettingsDoc
};

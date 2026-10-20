/**
 * Customer referral codes (RF-001…) — separate from coupons and loyalty earn rules.
 * Discount is applied at checkout (exclusive with coupons).
 * Reward points credit the code owner via the existing loyalty ledger.
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

  const doc = await ReferralSettings.findOneAndUpdate(
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

async function getMyReferral(userId, storefront = 'ecomm') {
  const sf = normalizeStorefront(storefront);
  const settings = await getSettings(sf);
  const codeDoc = userId ? await getCodeForUser(userId, sf) : null;
  const used = userId ? await refereeHasUsedReferral(sf, userId) : null;
  let stats = { completedUses: 0, pendingUses: 0, pointsAwarded: 0 };
  if (codeDoc?.code) {
    const [completed, pendingUses] = await Promise.all([
      ReferralRedemption.aggregate([
        { $match: { storefront: sf, code: codeDoc.code, status: 'completed' } },
        { $group: { _id: null, count: { $sum: 1 }, points: { $sum: '$rewardPoints' } } }
      ]),
      ReferralRedemption.countDocuments({ storefront: sf, code: codeDoc.code, status: 'reserved' })
    ]);
    stats = {
      completedUses: completed[0]?.count || 0,
      pendingUses: pendingUses || 0,
      pointsAwarded: floorPoints(completed[0]?.points || 0)
    };
  }
  return {
    settings: publicSettingsView(settings),
    code: codeDoc
      ? { code: codeDoc.code, generatedAt: codeDoc.generatedAt || codeDoc.createdAt }
      : null,
    stats,
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
  const redemption = await ReferralRedemption.findOne({ orderId: order.orderId }).session(
    session || null
  );
  if (!redemption) return { skipped: true, reason: 'no_redemption' };
  if (redemption.status === 'completed') return { skipped: true, reason: 'already_completed' };
  if (redemption.status === 'clawed_back') return { skipped: true, reason: 'clawed_back' };
  if (redemption.status === 'voided') return { skipped: true, reason: 'voided' };

  const points = floorPoints(redemption.rewardPoints);
  if (!(points > 0)) {
    redemption.status = 'completed';
    redemption.completedAt = new Date();
    await redemption.save(session ? { session } : undefined);
    return { skipped: true, reason: 'zero_points' };
  }

  const result = await loyaltyPointsService.applyLedgerDelta({
    userId: redemption.ownerUserId,
    storefront: redemption.storefront,
    type: 'referral_reward',
    points,
    idempotencyKey: `referral_reward:${order.orderId}`,
    orderId: order.orderId,
    orderMongoId: order._id || redemption.orderMongoId || null,
    rupeeValue: 0,
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
    redemption.rewardLedgerId = result.entry?._id || redemption.rewardLedgerId;
    await redemption.save(session ? { session } : undefined);
  }

  if (order.appliedReferral && typeof order.appliedReferral === 'object') {
    order.appliedReferral.rewardStatus = 'credited';
    if (typeof order.markModified === 'function') order.markModified('appliedReferral');
  }
  return result;
}

async function voidRedemptionForOrder(order, { session = null, reason = 'void' } = {}) {
  if (!order?.orderId) return { skipped: true, reason: 'no_order' };
  const redemption = await ReferralRedemption.findOne({ orderId: order.orderId }).session(
    session || null
  );
  if (!redemption) return { skipped: true, reason: 'no_redemption' };
  if (redemption.status === 'completed' || redemption.status === 'clawed_back') {
    return { skipped: true, reason: redemption.status };
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

async function syncReferralForOrder(order, options = {}) {
  try {
    if (!order?.orderId) return null;
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

    if (isRto || isReturnRefunded) {
      return clawbackReferrerForOrder(order, { reason: isRto ? 'rto' : 'return_refund' });
    }
    if (unpaidDead && !paidLike) {
      return voidRedemptionForOrder(order, { reason: options.reason || 'unpaid_cancel' });
    }
    if (paidLike || codDelivered) {
      return creditReferrerForOrder(order, { reason: options.reason || 'payment_success' });
    }
    return null;
  } catch (err) {
    logger.error('[referral] sync failed', {
      orderId: order?.orderId,
      message: err?.message || String(err)
    });
    return null;
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
      { $group: { _id: '$code', count: { $sum: 1 }, points: { $sum: '$rewardPoints' } } }
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
        rewardPoints: floorPoints(r.rewardPoints || 0),
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
      rewardPoints: floorPoints(r.rewardPoints || 0),
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
  updateSettings,
  publicSettingsView,
  generateCodeForUser,
  getCodeForUser,
  getMyReferral,
  quoteDiscount,
  computeDiscountFromSettings,
  reserveRedemptionForOrder,
  creditReferrerForOrder,
  voidRedemptionForOrder,
  clawbackReferrerForOrder,
  syncReferralForOrder,
  scheduleReferralSideEffectsForOrder,
  listCodesForAdmin,
  getCodeDetailForAdmin,
  listRedemptionsForAdmin,
  defaultSettingsDoc
};

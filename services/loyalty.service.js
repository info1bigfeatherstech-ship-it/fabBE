/**
 * Loyalty: recompute lifetime spend / order count and assign best matching badge.
 * Rank: lower number = better tier (1 = Gold/best, 2 = Silver, 3 = Bronze) — podium style.
 * Supports optional per-badge member caps (first N holders by badgeGrantedAt).
 * Failures are logged and never throw into payment/checkout critical paths when called via safe helpers.
 */
const Order = require('../models/Order');
const User = require('../models/User');
const LoyaltyBadge = require('../models/LoyaltyBadge');

const EXCLUDED_ORDER_STATUSES = new Set(['cancelled', 'payment_failed', 'rto']);
const PAID_PAYMENT_STATUSES = new Set(['paid', 'partially_paid', 'partially_refunded']);

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** null = unlimited; invalid/0 treated as unlimited */
function normalizeMaxMembers(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Sort comparator: lower rank number wins (1 beats 2).
 * Tie-break: higher spend threshold, then higher order threshold, then slug (stable).
 */
function compareBadgeTier(a, b) {
  const rankA = Number(a?.rank);
  const rankB = Number(b?.rank);
  const safeA = Number.isFinite(rankA) ? rankA : Number.POSITIVE_INFINITY;
  const safeB = Number.isFinite(rankB) ? rankB : Number.POSITIVE_INFINITY;
  if (safeA !== safeB) return safeA - safeB;

  const spendA = Number(a?.minLifetimeSpendInr) || 0;
  const spendB = Number(b?.minLifetimeSpendInr) || 0;
  if (spendA !== spendB) return spendB - spendA;

  const ordersA = Number(a?.minOrderCount) || 0;
  const ordersB = Number(b?.minOrderCount) || 0;
  if (ordersA !== ordersB) return ordersB - ordersA;

  return String(a?.slug || '').localeCompare(String(b?.slug || ''));
}

function sortBadgesBestFirst(badges) {
  const list = Array.isArray(badges) ? badges.slice() : [];
  list.sort(compareBadgeTier);
  return list;
}

function isCodOrder(order) {
  const method = String(order?.paymentInfo?.method || '').trim().toLowerCase();
  return method === 'cod';
}

function isLoyaltyQualifyingOrder(order) {
  if (!order) return false;
  const status = String(order.orderStatus || '').toLowerCase();
  if (EXCLUDED_ORDER_STATUSES.has(status)) return false;

  const pay = String(order.paymentStatus || '').toLowerCase();
  if (PAID_PAYMENT_STATUSES.has(pay)) return true;

  if (isCodOrder(order) && status === 'delivered') return true;
  return false;
}

function orderSpendInr(order) {
  const paid = Number(order?.amountPaidInr);
  if (Number.isFinite(paid) && paid > 0) return roundMoney2(paid);
  const total = Number(order?.totalAmount);
  if (Number.isFinite(total) && total > 0) return roundMoney2(total);
  return 0;
}

function badgeMatchesStats(badge, { lifetimeSpendInr, lifetimeOrderCount }) {
  if (!badge || badge.isActive === false) return false;
  const spendOk = lifetimeSpendInr >= Number(badge.minLifetimeSpendInr || 0);
  const ordersOk = lifetimeOrderCount >= Number(badge.minOrderCount || 0);
  const mode = String(badge.criteriaMode || 'spend');

  switch (mode) {
    case 'orders':
      return ordersOk;
    case 'spend_and_orders':
      return spendOk && ordersOk;
    case 'spend_or_orders':
      return spendOk || ordersOk;
    case 'spend':
    default:
      return spendOk;
  }
}

/**
 * Best (lowest-rank) active badge that matches stats (ignores capacity).
 * Prefer pickBestBadgeWithCapacity for real assignment.
 */
function pickBestBadge(badges, stats, { excludeSlugs = [] } = {}) {
  const excluded = new Set((excludeSlugs || []).map((s) => normalizeSlug(s)).filter(Boolean));
  const list = sortBadgesBestFirst(badges);
  for (const badge of list) {
    if (excluded.has(normalizeSlug(badge.slug))) continue;
    if (badgeMatchesStats(badge, stats)) return badge;
  }
  return null;
}

async function countBadgeHolders(badgeSlug, { excludeUserId = null } = {}) {
  const slug = normalizeSlug(badgeSlug);
  if (!slug) return 0;
  const filter = { 'loyalty.badgeSlug': slug };
  if (excludeUserId) filter._id = { $ne: excludeUserId };
  return User.countDocuments(filter);
}

/**
 * Best matching badge that still has capacity (or user already holds it).
 * Iterates best→worst (rank 1 first) so Silver holders upgrade to Gold when they qualify.
 */
async function pickBestBadgeWithCapacity(badges, stats, { userId, currentSlug, excludeSlugs = [] } = {}) {
  const excluded = new Set((excludeSlugs || []).map((s) => normalizeSlug(s)).filter(Boolean));
  const list = sortBadgesBestFirst(badges);
  const current = normalizeSlug(currentSlug);

  for (const badge of list) {
    const slug = normalizeSlug(badge.slug);
    if (!slug || excluded.has(slug)) continue;
    if (!badgeMatchesStats(badge, stats)) continue;

    // Already holding this tier — keep (does not consume a new capped slot)
    if (current && current === slug) return badge;

    const max = normalizeMaxMembers(badge.maxMembers);
    if (max == null) return badge;

    try {
      const holders = await countBadgeHolders(slug, { excludeUserId: userId });
      if (holders < max) return badge;
    } catch (err) {
      console.error('[loyalty] capacity check failed:', err?.message || err);
      // Fail closed for limited badges — try next lower tier
      continue;
    }
  }
  return null;
}

/**
 * If a limited badge has more holders than maxMembers, keep earliest grants and demote the rest.
 */
async function reconcileBadgeCapacity(badge, { skipUserId = null } = {}) {
  if (!badge?.slug) return { demoted: 0 };
  const max = normalizeMaxMembers(badge.maxMembers);
  if (max == null) return { demoted: 0 };

  const holders = await User.find({ 'loyalty.badgeSlug': normalizeSlug(badge.slug) })
    .select('_id loyalty.badgeGrantedAt')
    .sort({ 'loyalty.badgeGrantedAt': 1, _id: 1 })
    .lean();

  if (holders.length <= max) return { demoted: 0 };

  const excess = holders.slice(max);
  let demoted = 0;
  for (const holder of excess) {
    if (skipUserId && String(holder._id) === String(skipUserId)) continue;
    try {
      await recomputeUserLoyalty(holder._id, {
        excludeBadgeSlugs: [badge.slug],
        skipReconcile: true
      });
      demoted += 1;
    } catch (err) {
      console.error('[loyalty] demote excess holder failed:', holder._id, err?.message || err);
    }
  }
  return { demoted };
}

async function aggregateUserLoyaltyStats(userId, { storefront = null } = {}) {
  if (!userId) {
    return { lifetimeSpendInr: 0, lifetimeOrderCount: 0 };
  }

  const filter = {
    userId,
    orderStatus: { $nin: Array.from(EXCLUDED_ORDER_STATUSES) },
    $and: [
      {
        $or: [
          { paymentStatus: { $in: Array.from(PAID_PAYMENT_STATUSES) } },
          {
            'paymentInfo.method': { $regex: /^cod$/i },
            orderStatus: 'delivered'
          }
        ]
      }
    ]
  };

  // ecomm: include legacy rows missing storefront (pre-field orders still count).
  if (storefront === 'wholesale') {
    filter.$and.push({ storefront: 'wholesale' });
  } else if (storefront === 'ecomm') {
    filter.$and.push({
      $or: [
        { storefront: 'ecomm' },
        { storefront: { $exists: false } },
        { storefront: null },
        { storefront: '' }
      ]
    });
  } else if (storefront) {
    filter.$and.push({ storefront: String(storefront) });
  }

  const orders = await Order.find(filter)
    .select('totalAmount amountPaidInr paymentStatus orderStatus paymentInfo.method storefront')
    .lean();

  let lifetimeSpendInr = 0;
  let lifetimeOrderCount = 0;
  for (const order of orders) {
    if (!isLoyaltyQualifyingOrder(order)) continue;
    lifetimeOrderCount += 1;
    lifetimeSpendInr = roundMoney2(lifetimeSpendInr + orderSpendInr(order));
  }

  return { lifetimeSpendInr, lifetimeOrderCount };
}

function buildLoyaltyCache(stats, badge, { previousLoyalty = null } = {}) {
  const prevSlug = normalizeSlug(previousLoyalty?.badgeSlug);
  const nextSlug = normalizeSlug(badge?.slug);
  let badgeGrantedAt = null;
  if (nextSlug) {
    if (prevSlug && prevSlug === nextSlug && previousLoyalty?.badgeGrantedAt) {
      badgeGrantedAt = previousLoyalty.badgeGrantedAt;
    } else {
      badgeGrantedAt = new Date();
    }
  }

  // Preserve redeemable points fields — badge recompute must NEVER wipe them.
  // (Older code $set the whole `loyalty` object and zeroed balances after earn.)
  const pointsBalance = Math.max(0, Math.floor(Number(previousLoyalty?.pointsBalance) || 0));
  const pointsLifetimeEarned = Math.max(
    0,
    Math.floor(Number(previousLoyalty?.pointsLifetimeEarned) || 0)
  );
  const pointsLifetimeRedeemed = Math.max(
    0,
    Math.floor(Number(previousLoyalty?.pointsLifetimeRedeemed) || 0)
  );

  return {
    lifetimeSpendInr: roundMoney2(stats.lifetimeSpendInr || 0),
    lifetimeOrderCount: Math.max(0, Math.floor(Number(stats.lifetimeOrderCount) || 0)),
    badgeId: badge?._id || null,
    badgeSlug: badge?.slug || null,
    badgeName: badge?.name || null,
    badgeColor: badge?.color || null,
    badgeRank: badge ? Number(badge.rank || 0) : 0,
    badgeGrantedAt,
    recomputedAt: new Date(),
    pointsBalance,
    pointsLifetimeEarned,
    pointsLifetimeRedeemed
  };
}

/**
 * Safe projection after loyalty writes — never load password / refresh tokens / OTP / security answers.
 * Positive include only (avoids Mongoose path collision with nested select:false on refreshTokens.token).
 */
const LOYALTY_USER_SAFE_SELECT = '_id name email phone loyalty status accountScope role';

/**
 * Recompute + persist loyalty cache on the user.
 */
async function recomputeUserLoyalty(userId, options = {}) {
  if (!userId) {
    throw new Error('recomputeUserLoyalty: userId required');
  }

  const previous = await User.findById(userId).select('loyalty').lean();
  if (!previous) {
    throw new Error('recomputeUserLoyalty: user not found');
  }

  const stats = await aggregateUserLoyaltyStats(userId, {
    storefront: options.storefront != null ? options.storefront : 'ecomm'
  });

  const badges = await LoyaltyBadge.find({ isActive: true }).sort({ rank: 1, minLifetimeSpendInr: -1 }).lean();
  const badge = await pickBestBadgeWithCapacity(badges, stats, {
    userId,
    currentSlug: previous.loyalty?.badgeSlug,
    excludeSlugs: options.excludeBadgeSlugs || []
  });

  const loyalty = buildLoyaltyCache(stats, badge, { previousLoyalty: previous.loyalty });

  // Dot-path $set for badge/spend fields ONLY.
  // Never touch loyalty.pointsBalance / lifetime earned|redeemed — those are owned by
  // loyaltyPoints.service ledger writes. Replacing the whole `loyalty` subdoc previously
  // wiped balances after payment earn (ledger still showed credits).
  const updateResult = await User.updateOne(
    { _id: userId },
    {
      $set: {
        'loyalty.lifetimeSpendInr': loyalty.lifetimeSpendInr,
        'loyalty.lifetimeOrderCount': loyalty.lifetimeOrderCount,
        'loyalty.badgeId': loyalty.badgeId,
        'loyalty.badgeSlug': loyalty.badgeSlug,
        'loyalty.badgeName': loyalty.badgeName,
        'loyalty.badgeColor': loyalty.badgeColor,
        'loyalty.badgeRank': loyalty.badgeRank,
        'loyalty.badgeGrantedAt': loyalty.badgeGrantedAt,
        'loyalty.recomputedAt': loyalty.recomputedAt
      }
    }
  );
  if (!updateResult || (updateResult.matchedCount === 0 && updateResult.n === 0)) {
    throw new Error('recomputeUserLoyalty: user not found');
  }

  const user = await User.findById(userId).select(LOYALTY_USER_SAFE_SELECT).lean();
  if (!user) {
    throw new Error('recomputeUserLoyalty: user not found after update');
  }

  // If we newly took a limited slot, demote any overflow (keep earliest grants).
  if (!options.skipReconcile && badge && normalizeMaxMembers(badge.maxMembers) != null) {
    try {
      await reconcileBadgeCapacity(badge, { skipUserId: userId });
    } catch (err) {
      console.error('[loyalty] reconcile after assign failed:', err?.message || err);
    }
  }

  return { user, stats, badge, loyalty };
}

function recomputeUserLoyaltySafe(userId, options = {}) {
  if (!userId) return Promise.resolve(null);
  return recomputeUserLoyalty(userId, options).catch((err) => {
    console.error('[loyalty] recompute failed:', err?.message || err, options?.reason || '');
    return null;
  });
}

/**
 * Schedule loyalty refresh AFTER the order document is persisted.
 * Call only once the DB row reflects paid / delivered state — never before order.save().
 * Non-blocking: never throws into payment / shipment critical paths.
 */
function scheduleLoyaltyRecomputeForOrder(order, options = {}) {
  try {
    if (!order?.userId) return Promise.resolve(null);

    const pay = String(order.paymentStatus || '').toLowerCase();
    const status = String(order.orderStatus || '').toLowerCase();
    const method = String(order?.paymentInfo?.method || '').trim().toLowerCase();
    const paidLike = PAID_PAYMENT_STATUSES.has(pay);
    const codDelivered = method === 'cod' && status === 'delivered';

    if (!paidLike && !codDelivered) return Promise.resolve(null);

    const storefront =
      options.storefront != null
        ? options.storefront
        : order.storefront === 'wholesale'
          ? 'wholesale'
          : 'ecomm';

    return recomputeUserLoyaltySafe(order.userId, {
      storefront,
      reason: options.reason || 'order_persisted'
    });
  } catch (err) {
    console.error('[loyalty] scheduleLoyaltyRecomputeForOrder failed:', err?.message || err);
    return Promise.resolve(null);
  }
}

function couponLoyaltyEligible(coupon, userLoyaltySlug) {
  const allowed = Array.isArray(coupon?.allowedLoyaltyBadges)
    ? coupon.allowedLoyaltyBadges.map((s) => normalizeSlug(s)).filter(Boolean)
    : [];
  if (!allowed.length) return true;
  const slug = normalizeSlug(userLoyaltySlug);
  if (!slug) return false;
  return allowed.includes(slug);
}

function publicLoyaltyView(user) {
  const loyalty = user?.loyalty || {};
  if (
    !loyalty.badgeSlug &&
    !(Number(loyalty.lifetimeSpendInr) > 0) &&
    !(Number(loyalty.lifetimeOrderCount) > 0)
  ) {
    return {
      lifetimeSpendInr: 0,
      lifetimeOrderCount: 0,
      badge: null
    };
  }
  return {
    lifetimeSpendInr: roundMoney2(loyalty.lifetimeSpendInr || 0),
    lifetimeOrderCount: Math.max(0, Math.floor(Number(loyalty.lifetimeOrderCount) || 0)),
    badge: loyalty.badgeSlug
      ? {
          id: loyalty.badgeId || null,
          slug: loyalty.badgeSlug,
          name: loyalty.badgeName,
          color: loyalty.badgeColor,
          rank: Number(loyalty.badgeRank || 0),
          grantedAt: loyalty.badgeGrantedAt || null
        }
      : null,
    recomputedAt: loyalty.recomputedAt || null
  };
}

async function getBadgeMemberCounts(slugs = []) {
  const match = Array.isArray(slugs) && slugs.length
    ? { 'loyalty.badgeSlug': { $in: slugs.map(normalizeSlug).filter(Boolean) } }
    : { 'loyalty.badgeSlug': { $type: 'string', $ne: '' } };

  const rows = await User.aggregate([
    { $match: match },
    { $group: { _id: '$loyalty.badgeSlug', count: { $sum: 1 } } }
  ]);
  const map = {};
  for (const row of rows) {
    if (row._id) map[row._id] = row.count;
  }
  return map;
}

module.exports = {
  CRITERIA_MODES: LoyaltyBadge.CRITERIA_MODES,
  EXCLUDED_ORDER_STATUSES,
  PAID_PAYMENT_STATUSES,
  normalizeSlug,
  normalizeMaxMembers,
  compareBadgeTier,
  sortBadgesBestFirst,
  isLoyaltyQualifyingOrder,
  orderSpendInr,
  badgeMatchesStats,
  pickBestBadge,
  pickBestBadgeWithCapacity,
  countBadgeHolders,
  reconcileBadgeCapacity,
  aggregateUserLoyaltyStats,
  recomputeUserLoyalty,
  recomputeUserLoyaltySafe,
  scheduleLoyaltyRecomputeForOrder,
  couponLoyaltyEligible,
  publicLoyaltyView,
  getBadgeMemberCounts
};

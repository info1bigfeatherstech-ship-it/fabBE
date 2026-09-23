/**
 * Admin CRUD for loyalty badges + recompute helpers.
 */
const mongoose = require('mongoose');
const LoyaltyBadge = require('../models/LoyaltyBadge');
const User = require('../models/User');
const { ACCOUNT_SCOPES } = require('../utils/accountScope');
const {
  CRITERIA_MODES,
  normalizeSlug,
  normalizeMaxMembers,
  recomputeUserLoyalty,
  publicLoyaltyView,
  getBadgeMemberCounts,
  reconcileBadgeCapacity
} = require('../services/loyalty.service');

function loyaltyError(res, statusCode, code, message, extras = {}) {
  return res.status(statusCode).json({
    success: false,
    code,
    message,
    ...extras
  });
}

function parseNonNegNumber(raw, field, { required = false, integer = false } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    if (required) {
      const err = new Error(`${field} is required`);
      err.statusCode = 400;
      err.code = 'FIELD_REQUIRED';
      throw err;
    }
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(`${field} must be a non-negative number`);
    err.statusCode = 400;
    err.code = 'INVALID_NUMBER';
    throw err;
  }
  return integer ? Math.floor(n) : Math.round((n + Number.EPSILON) * 100) / 100;
}

function validateBadgeBody(body, { partial = false } = {}) {
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) {
      const err = new Error('Badge name is required');
      err.statusCode = 400;
      err.code = 'BADGE_NAME_REQUIRED';
      throw err;
    }
    out.name = name.slice(0, 80);
  }

  if (!partial || body.slug !== undefined) {
    const slug = normalizeSlug(body.slug || body.name);
    if (!slug) {
      const err = new Error('Badge slug is required');
      err.statusCode = 400;
      err.code = 'BADGE_SLUG_REQUIRED';
      throw err;
    }
    out.slug = slug;
  }

  if (!partial || body.description !== undefined) {
    out.description = String(body.description || '').trim().slice(0, 300);
  }

  if (!partial || body.criteriaMode !== undefined) {
    const mode = String(body.criteriaMode || 'spend').trim();
    if (!CRITERIA_MODES.includes(mode)) {
      const err = new Error(`criteriaMode must be one of: ${CRITERIA_MODES.join(', ')}`);
      err.statusCode = 400;
      err.code = 'INVALID_CRITERIA_MODE';
      throw err;
    }
    out.criteriaMode = mode;
  }

  if (!partial || body.minLifetimeSpendInr !== undefined) {
    out.minLifetimeSpendInr = parseNonNegNumber(body.minLifetimeSpendInr ?? 0, 'minLifetimeSpendInr') ?? 0;
  }

  if (!partial || body.minOrderCount !== undefined) {
    out.minOrderCount = parseNonNegNumber(body.minOrderCount ?? 0, 'minOrderCount', { integer: true }) ?? 0;
  }

  if (!partial || body.rank !== undefined) {
    out.rank = parseNonNegNumber(body.rank ?? 0, 'rank', { integer: true, required: !partial }) ?? 0;
  }

  if (!partial || body.color !== undefined) {
    out.color = String(body.color || '#C9A227').trim().slice(0, 32) || '#C9A227';
  }

  if (!partial || body.icon !== undefined) {
    out.icon = String(body.icon || '').trim().slice(0, 80);
  }

  if (!partial || body.maxMembers !== undefined) {
    // Empty / null / 0 => unlimited
    if (body.maxMembers === null || body.maxMembers === '' || body.maxMembers === undefined) {
      out.maxMembers = null;
    } else {
      const max = parseNonNegNumber(body.maxMembers, 'maxMembers', { integer: true });
      out.maxMembers = max === 0 ? null : max;
    }
  }

  if (!partial || body.isActive !== undefined) {
    out.isActive = body.isActive === true || body.isActive === 'true' || body.isActive === 1;
  }

  // Logical consistency: spend modes need spend threshold or orders need order threshold
  const mode = out.criteriaMode;
  if (mode === 'spend' || mode === 'spend_and_orders' || mode === 'spend_or_orders') {
    if (out.minLifetimeSpendInr !== undefined && out.minLifetimeSpendInr <= 0 && mode === 'spend') {
      // allow 0 for entry badge
    }
  }
  if (mode === 'orders' && out.minOrderCount !== undefined && out.minOrderCount < 0) {
    const err = new Error('minOrderCount must be >= 0');
    err.statusCode = 400;
    err.code = 'INVALID_MIN_ORDER_COUNT';
    throw err;
  }

  return out;
}

function mapBadge(doc, { memberCount = null } = {}) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  const maxMembers = normalizeMaxMembers(o.maxMembers);
  return {
    id: o._id,
    _id: o._id,
    name: o.name,
    slug: o.slug,
    description: o.description || '',
    criteriaMode: o.criteriaMode,
    minLifetimeSpendInr: o.minLifetimeSpendInr,
    minOrderCount: o.minOrderCount,
    rank: o.rank,
    color: o.color,
    icon: o.icon || '',
    maxMembers,
    memberCount: memberCount != null ? Number(memberCount) || 0 : undefined,
    seatsRemaining:
      maxMembers == null
        ? null
        : Math.max(0, maxMembers - (Number(memberCount) || 0)),
    isActive: o.isActive !== false,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt
  };
}

const createBadge = async (req, res) => {
  try {
    const data = validateBadgeBody(req.body || {}, { partial: false });
    if (data.isActive === undefined) data.isActive = true;

    const existing = await LoyaltyBadge.findOne({ slug: data.slug });
    if (existing) {
      return loyaltyError(res, 400, 'BADGE_SLUG_EXISTS', 'A badge with this slug already exists');
    }

    const badge = await LoyaltyBadge.create(data);
    return res.status(201).json({
      success: true,
      message: 'Loyalty badge created',
      badge: mapBadge(badge)
    });
  } catch (error) {
    console.error('Create loyalty badge error:', error);
    return loyaltyError(
      res,
      error.statusCode || 500,
      error.code || 'BADGE_CREATE_FAILED',
      error.message || 'Error creating loyalty badge'
    );
  }
};

const listBadges = async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};
    if (status === 'active') query.isActive = true;
    if (status === 'inactive') query.isActive = false;

    const badges = await LoyaltyBadge.find(query).sort({ rank: 1, createdAt: 1 });
    let counts = {};
    try {
      counts = await getBadgeMemberCounts(badges.map((b) => b.slug));
    } catch (countErr) {
      console.error('[loyalty] member counts failed:', countErr?.message || countErr);
      counts = {};
    }

    return res.json({
      success: true,
      badges: badges.map((b) => mapBadge(b, { memberCount: counts[b.slug] || 0 })),
      criteriaModes: CRITERIA_MODES
    });
  } catch (error) {
    console.error('List loyalty badges error:', error);
    return loyaltyError(res, 500, 'BADGE_LIST_FAILED', 'Error fetching loyalty badges');
  }
};

const getBadgeById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return loyaltyError(res, 400, 'INVALID_ID', 'Invalid badge id');
    }
    const badge = await LoyaltyBadge.findById(id);
    if (!badge) return loyaltyError(res, 404, 'BADGE_NOT_FOUND', 'Loyalty badge not found');
    return res.json({ success: true, badge: mapBadge(badge) });
  } catch (error) {
    console.error('Get loyalty badge error:', error);
    return loyaltyError(res, 500, 'BADGE_GET_FAILED', 'Error fetching loyalty badge');
  }
};

const updateBadge = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return loyaltyError(res, 400, 'INVALID_ID', 'Invalid badge id');
    }

    const data = validateBadgeBody(req.body || {}, { partial: true });
    if (data.slug) {
      const clash = await LoyaltyBadge.findOne({ slug: data.slug, _id: { $ne: id } });
      if (clash) {
        return loyaltyError(res, 400, 'BADGE_SLUG_EXISTS', 'A badge with this slug already exists');
      }
    }

    const badge = await LoyaltyBadge.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true });
    if (!badge) return loyaltyError(res, 404, 'BADGE_NOT_FOUND', 'Loyalty badge not found');

    // If admin lowered the cap, demote excess holders (keep earliest grants).
    if (Object.prototype.hasOwnProperty.call(data, 'maxMembers')) {
      try {
        await reconcileBadgeCapacity(badge.toObject ? badge.toObject() : badge);
      } catch (recErr) {
        console.error('[loyalty] reconcile after maxMembers update failed:', recErr?.message || recErr);
      }
    }

    let memberCount = 0;
    try {
      const counts = await getBadgeMemberCounts([badge.slug]);
      memberCount = counts[badge.slug] || 0;
    } catch (_) {
      memberCount = 0;
    }

    return res.json({
      success: true,
      message: 'Loyalty badge updated',
      badge: mapBadge(badge, { memberCount })
    });
  } catch (error) {
    console.error('Update loyalty badge error:', error);
    return loyaltyError(
      res,
      error.statusCode || 500,
      error.code || 'BADGE_UPDATE_FAILED',
      error.message || 'Error updating loyalty badge'
    );
  }
};

const deleteBadge = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return loyaltyError(res, 400, 'INVALID_ID', 'Invalid badge id');
    }
    const badge = await LoyaltyBadge.findByIdAndDelete(id);
    if (!badge) return loyaltyError(res, 404, 'BADGE_NOT_FOUND', 'Loyalty badge not found');

    // Clear cache refs on users holding this badge (non-blocking best-effort)
    User.updateMany(
      { 'loyalty.badgeId': badge._id },
      {
        $set: {
          'loyalty.badgeId': null,
          'loyalty.badgeSlug': null,
          'loyalty.badgeName': null,
          'loyalty.badgeColor': null,
          'loyalty.badgeRank': 0,
          'loyalty.badgeGrantedAt': null
        }
      }
    ).catch((err) => console.error('[loyalty] clear badge refs failed:', err?.message || err));

    return res.json({ success: true, message: 'Loyalty badge deleted' });
  } catch (error) {
    console.error('Delete loyalty badge error:', error);
    return loyaltyError(res, 500, 'BADGE_DELETE_FAILED', 'Error deleting loyalty badge');
  }
};

const toggleBadge = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return loyaltyError(res, 400, 'INVALID_ID', 'Invalid badge id');
    }
    const badge = await LoyaltyBadge.findById(id);
    if (!badge) return loyaltyError(res, 404, 'BADGE_NOT_FOUND', 'Loyalty badge not found');
    badge.isActive = !badge.isActive;
    await badge.save();
    return res.json({
      success: true,
      message: `Badge ${badge.isActive ? 'activated' : 'deactivated'}`,
      badge: mapBadge(badge)
    });
  } catch (error) {
    console.error('Toggle loyalty badge error:', error);
    return loyaltyError(res, 500, 'BADGE_TOGGLE_FAILED', 'Error toggling loyalty badge');
  }
};

/** Admin: recompute one customer's loyalty from orders (by userId param). */
const recomputeUser = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return loyaltyError(res, 400, 'INVALID_USER_ID', 'Invalid user id');
    }
    const result = await recomputeUserLoyalty(userId, { storefront: 'ecomm' });
    if (!result?.user) {
      return loyaltyError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }
    return res.json({
      success: true,
      message: 'Loyalty recomputed',
      userId: result.user._id,
      email: result.user.email || null,
      loyalty: publicLoyaltyView(result.user),
      stats: result.stats
    });
  } catch (error) {
    console.error('Recompute user loyalty error:', error);
    const msg = String(error?.message || '');
    if (/path collision/i.test(msg)) {
      return loyaltyError(
        res,
        500,
        'LOYALTY_RECOMPUTE_FAILED',
        'Could not update loyalty cache. Please retry.'
      );
    }
    if (/user not found/i.test(msg)) {
      return loyaltyError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }
    return loyaltyError(res, 500, 'LOYALTY_RECOMPUTE_FAILED', 'Recompute failed');
  }
};

/**
 * Admin: recompute by email or userId in body.
 * Production-safe single-user repair for missed payment-hook races / manual DB edits.
 * Email lookup prefers ecomm storefront account (never returns secrets).
 */
const recomputeUserLookup = async (req, res) => {
  try {
    const body = req.body || {};
    const rawUserId = body.userId != null ? String(body.userId).trim() : '';
    const email = String(body.email || '').trim().toLowerCase();

    let user = null;
    if (rawUserId && mongoose.Types.ObjectId.isValid(rawUserId)) {
      user = await User.findById(rawUserId).select('_id email accountScope').lean();
    } else if (email && email.includes('@') && email.length <= 254) {
      const emailRx = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      user = await User.findOne({
        email: emailRx,
        accountScope: ACCOUNT_SCOPES.ECOMM
      })
        .select('_id email accountScope')
        .lean();
      // Legacy rows without accountScope still treated as ecomm
      if (!user) {
        user = await User.findOne({
          email: emailRx,
          $or: [{ accountScope: { $exists: false } }, { accountScope: null }, { accountScope: '' }]
        })
          .select('_id email accountScope')
          .lean();
      }
    } else {
      return loyaltyError(
        res,
        400,
        'LOOKUP_REQUIRED',
        'Provide a valid userId or customer email'
      );
    }

    if (!user) {
      return loyaltyError(res, 404, 'USER_NOT_FOUND', 'No customer found for that userId/email');
    }

    const result = await recomputeUserLoyalty(user._id, { storefront: 'ecomm' });
    if (!result?.user) {
      return loyaltyError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }

    return res.json({
      success: true,
      message: 'Loyalty recomputed',
      userId: result.user._id,
      email: result.user.email || user.email || null,
      loyalty: publicLoyaltyView(result.user),
      stats: result.stats
    });
  } catch (error) {
    console.error('Recompute user loyalty (lookup) error:', error);
    const msg = String(error?.message || '');
    if (/path collision/i.test(msg)) {
      return loyaltyError(
        res,
        500,
        'LOYALTY_RECOMPUTE_FAILED',
        'Could not update loyalty cache. Please retry.'
      );
    }
    if (/user not found/i.test(msg)) {
      return loyaltyError(res, 404, 'USER_NOT_FOUND', 'User not found');
    }
    return loyaltyError(res, 500, 'LOYALTY_RECOMPUTE_FAILED', 'Recompute failed');
  }
};

/** Admin: paginated customers holding a badge. */
const listBadgeMembers = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return loyaltyError(res, 400, 'INVALID_ID', 'Invalid badge id');
    }

    const badge = await LoyaltyBadge.findById(id).lean();
    if (!badge) return loyaltyError(res, 404, 'BADGE_NOT_FOUND', 'Loyalty badge not found');

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = String(req.query.search || '').trim();

    const filter = { 'loyalty.badgeSlug': normalizeSlug(badge.slug) };
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
    }

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select('name email phone loyalty status createdAt')
        .sort({ 'loyalty.badgeGrantedAt': 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);

    const members = users.map((u) => ({
      id: u._id,
      _id: u._id,
      name: u.name || '',
      email: u.email || '',
      phone: u.phone || '',
      status: u.status || 'active',
      lifetimeSpendInr: Number(u.loyalty?.lifetimeSpendInr) || 0,
      lifetimeOrderCount: Number(u.loyalty?.lifetimeOrderCount) || 0,
      badgeGrantedAt: u.loyalty?.badgeGrantedAt || null,
      createdAt: u.createdAt || null
    }));

    return res.json({
      success: true,
      badge: mapBadge(badge, { memberCount: total }),
      members,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (error) {
    console.error('List badge members error:', error);
    return loyaltyError(res, 500, 'BADGE_MEMBERS_FAILED', 'Error fetching badge members');
  }
};

module.exports = {
  createBadge,
  listBadges,
  getBadgeById,
  updateBadge,
  deleteBadge,
  toggleBadge,
  recomputeUser,
  recomputeUserLookup,
  listBadgeMembers
};

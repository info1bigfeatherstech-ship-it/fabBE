const mongoose = require('mongoose');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');

const ENGAGEMENT_VALUES = new Set([
  'all',
  'push_on',
  'push_off',
  'pwa_on',
  'pwa_off',
  'push_and_pwa',
]);

function normalizeEngagement(raw) {
  const v = String(raw || 'all')
    .trim()
    .toLowerCase();
  return ENGAGEMENT_VALUES.has(v) ? v : 'all';
}

function isPwaInstalled(user) {
  const at = user?.pwaInstall?.installedAt;
  if (!at) return false;
  const d = at instanceof Date ? at : new Date(at);
  return !Number.isNaN(d.getTime());
}

function emptyPushStats() {
  return {
    notificationsEnabled: false,
    pushDeviceCount: 0,
    pushSubscribedAt: null,
    pushLastPushAt: null,
  };
}

function emptyPwaStats(user) {
  const installed = isPwaInstalled(user);
  return {
    pwaInstalled: installed,
    pwaInstalledAt: installed ? user.pwaInstall.installedAt : null,
    pwaLastConfirmedAt: installed ? user.pwaInstall?.lastConfirmedAt || null : null,
  };
}

/**
 * Batch push engagement for a page of users (one aggregation — no N+1).
 * @param {Array<import('mongoose').Types.ObjectId|string>} userIds
 */
async function getPushStatsByUserIds(userIds = []) {
  const ids = (Array.isArray(userIds) ? userIds : [])
    .map((id) => {
      try {
        return new mongoose.Types.ObjectId(String(id));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const map = new Map();
  if (!ids.length) return map;

  const rows = await PushSubscription.aggregate([
    { $match: { userId: { $in: ids }, isActive: true } },
    {
      $group: {
        _id: '$userId',
        pushDeviceCount: { $sum: 1 },
        pushSubscribedAt: { $min: '$createdAt' },
        pushLastPushAt: { $max: '$lastPushAt' },
      },
    },
  ]);

  for (const row of rows) {
    map.set(String(row._id), {
      notificationsEnabled: true,
      pushDeviceCount: Number(row.pushDeviceCount) || 0,
      pushSubscribedAt: row.pushSubscribedAt || null,
      pushLastPushAt: row.pushLastPushAt || null,
    });
  }
  return map;
}

function attachEngagementFields(user, pushMap) {
  const push = pushMap.get(String(user._id)) || emptyPushStats();
  const pwa = emptyPwaStats(user);
  return {
    ...user,
    ...push,
    ...pwa,
  };
}

/**
 * Distinct userIds (as ObjectId[]) that currently have ≥1 active push subscription.
 */
async function getActivePushUserIds() {
  const ids = await PushSubscription.distinct('userId', { isActive: true });
  return (ids || []).filter(Boolean);
}

/**
 * Merge engagement filter into an existing User query (already storefront-scoped).
 * Returns a new query object; never mutates `baseQuery`.
 */
async function applyEngagementFilter(baseQuery, engagementRaw) {
  const engagement = normalizeEngagement(engagementRaw);
  if (engagement === 'all') {
    return { query: baseQuery, engagement };
  }

  let query = baseQuery;

  if (engagement === 'pwa_on') {
    query = mergeAnd(query, { 'pwaInstall.installedAt': { $exists: true, $ne: null } });
    return { query, engagement };
  }

  if (engagement === 'pwa_off') {
    query = mergeAnd(query, {
      $or: [
        { pwaInstall: { $exists: false } },
        { 'pwaInstall.installedAt': null },
        { 'pwaInstall.installedAt': { $exists: false } },
      ],
    });
    return { query, engagement };
  }

  const pushUserIds = await getActivePushUserIds();

  if (engagement === 'push_on') {
    query = mergeAnd(query, { _id: { $in: pushUserIds.length ? pushUserIds : [] } });
    return { query, engagement };
  }

  if (engagement === 'push_off') {
    if (pushUserIds.length) {
      query = mergeAnd(query, { _id: { $nin: pushUserIds } });
    }
    return { query, engagement };
  }

  if (engagement === 'push_and_pwa') {
    query = mergeAnd(query, {
      _id: { $in: pushUserIds.length ? pushUserIds : [] },
      'pwaInstall.installedAt': { $exists: true, $ne: null },
    });
    return { query, engagement };
  }

  return { query, engagement: 'all' };
}

function mergeAnd(base, extra) {
  if (!extra || !Object.keys(extra).length) return base;
  if (!base || !Object.keys(base).length) return extra;
  return { $and: [base, extra] };
}

/**
 * Summary counts for Leads → Customers stat cards (same scope as users list).
 */
async function getEngagementSummary(scopedUserQuery) {
  const base = scopedUserQuery && typeof scopedUserQuery === 'object' ? scopedUserQuery : {};

  const [total, pwaInstalled, pushUserIds] = await Promise.all([
    User.countDocuments(base),
    User.countDocuments(
      mergeAnd(base, { 'pwaInstall.installedAt': { $exists: true, $ne: null } })
    ),
    getActivePushUserIds(),
  ]);

  let notificationsOn = 0;
  let appAndNotifications = 0;

  if (pushUserIds.length) {
    notificationsOn = await User.countDocuments(mergeAnd(base, { _id: { $in: pushUserIds } }));
    appAndNotifications = await User.countDocuments(
      mergeAnd(base, {
        _id: { $in: pushUserIds },
        'pwaInstall.installedAt': { $exists: true, $ne: null },
      })
    );
  }

  return {
    total,
    notificationsOn,
    notificationsOff: Math.max(0, total - notificationsOn),
    pwaInstalled,
    pwaNotInstalled: Math.max(0, total - pwaInstalled),
    appAndNotifications,
  };
}

/**
 * Record / refresh PWA install for an authenticated user (idempotent).
 */
async function recordPwaInstall(userId, { platform = null, userAgent = null } = {}) {
  if (!userId) {
    const err = new Error('Authentication required');
    err.code = 'AUTH_REQUIRED';
    throw err;
  }

  const now = new Date();
  const user = await User.findById(userId).select('pwaInstall');
  if (!user) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const hadInstall = Boolean(user.pwaInstall?.installedAt);
  if (!user.pwaInstall) {
    user.pwaInstall = {};
  }
  if (!hadInstall) {
    user.pwaInstall.installedAt = now;
  }
  user.pwaInstall.lastConfirmedAt = now;
  if (platform) {
    user.pwaInstall.platform = String(platform).trim().slice(0, 64) || null;
  }
  if (userAgent) {
    user.pwaInstall.userAgent = String(userAgent).trim().slice(0, 512) || null;
  }

  await user.save();

  return {
    installed: true,
    firstInstall: !hadInstall,
    pwaInstalledAt: user.pwaInstall.installedAt,
    pwaLastConfirmedAt: user.pwaInstall.lastConfirmedAt,
  };
}

module.exports = {
  ENGAGEMENT_VALUES,
  normalizeEngagement,
  getPushStatsByUserIds,
  attachEngagementFields,
  applyEngagementFilter,
  getEngagementSummary,
  recordPwaInstall,
  emptyPushStats,
  emptyPwaStats,
  isPwaInstalled,
};

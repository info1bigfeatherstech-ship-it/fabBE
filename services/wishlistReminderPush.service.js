/**
 * Wishlist reminder web push — Tue/Fri/Sat cart / Thu+Sun wishlist schedule (see schedulers).
 * Only users with non-empty wishlist + active push subscription.
 * Gated by LeadsPushSettings.autoWishlistPushEnabled (independent of cart).
 */
const mongoose = require('mongoose');
const Wishlist = require('../models/Wishlist');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');
const wishlistReminderPushTemplate = require('../templates/wishlistReminderPush.template');
const { isPushConfigured } = require('../utils/pushVapid');
const {
  ensureVapidConfigured,
  sendPushToSubscription,
  isExpiredSubscriptionError,
  deactivateSubscription,
  delay,
} = require('../utils/webPushDispatch');
const leadsPushSettingsService = require('./leadsPushSettings.service');
const logger = require('../utils/logger');
const { resolveWishlistPageUrl } = require('../utils/storefrontFrontendUrl');
const { getAppName } = require('../utils/appBrand');

const SEND_DELAY_MS = 200;
const AUTO_BATCH_SIZE = 100;

function getWishlistUrl() {
  return resolveWishlistPageUrl('ecomm');
}

function applyPlaceholders(text, vars) {
  let out = String(text || '');
  Object.entries(vars).forEach(([key, value]) => {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  });
  return out;
}

function getStartOfTodayUtcForIst() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  return new Date(Date.UTC(y, m, d) - istOffsetMs);
}

function wasReminderSentToday(lastSentAt) {
  if (!lastSentAt) return false;
  return new Date(lastSentAt).getTime() >= getStartOfTodayUtcForIst().getTime();
}

function buildPushPayload({ customerName, itemCount }) {
  const itemLabel = itemCount === 1 ? 'item' : 'items';
  const displayName = customerName || 'there';
  const url = getWishlistUrl();
  const vars = {
    name: displayName,
    appName: getAppName(),
    itemCount: String(itemCount),
    itemLabel,
  };
  return {
    title: wishlistReminderPushTemplate.title,
    body: applyPlaceholders(wishlistReminderPushTemplate.body, vars),
    icon: wishlistReminderPushTemplate.icon,
    badge: wishlistReminderPushTemplate.badge,
    tag: wishlistReminderPushTemplate.tag,
    ctaLabel: wishlistReminderPushTemplate.ctaLabel,
    data: {
      type: 'wishlist-reminder',
      url,
      ctaLabel: wishlistReminderPushTemplate.ctaLabel,
    },
  };
}

async function sendWishlistReminderPushToUser({ userId, userName, enforceDailyLimit = false }) {
  const wishlist = await Wishlist.findOne({ userId }).select('products').lean();
  const itemCount = Array.isArray(wishlist?.products) ? wishlist.products.length : 0;
  if (!itemCount) {
    return { status: 'skipped', reason: 'EMPTY_WISHLIST' };
  }

  const subscriptions = await PushSubscription.find({ userId, isActive: true });
  if (!subscriptions.length) {
    return { status: 'skipped', reason: 'NO_SUBSCRIPTION' };
  }

  const eligible = enforceDailyLimit
    ? subscriptions.filter((sub) => !wasReminderSentToday(sub.lastWishlistReminderPushAt))
    : subscriptions;

  if (!eligible.length) {
    return { status: 'skipped', reason: 'ALREADY_SENT_TODAY' };
  }

  const payload = buildPushPayload({ customerName: userName, itemCount });
  let sent = 0;
  let failed = 0;

  for (const sub of eligible) {
    try {
      await sendPushToSubscription(sub, payload, {
        touchFields: { lastWishlistReminderPushAt: new Date() },
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      if (isExpiredSubscriptionError(err)) {
        await deactivateSubscription(sub, err.statusCode || err.status);
      } else {
        try {
          sub.failureCount = (sub.failureCount || 0) + 1;
          if (sub.failureCount >= 5) sub.isActive = false;
          await sub.save();
        } catch {
          /* ignore */
        }
        logger.error('[wishlistReminderPush] send failed', {
          userId: String(userId),
          message: err?.message || String(err),
        });
      }
    }
  }

  if (sent > 0) return { status: 'sent', devices: sent, failedDevices: failed };
  return { status: 'failed', reason: 'SEND_FAILED', failedDevices: failed };
}

/**
 * Auto daily wishlist push for ecomm customers with wishlist items.
 */
async function sendAutoWishlistReminderPushes({ scopeQuery = { userType: 'user' } } = {}) {
  if (!isPushConfigured()) {
    return { skipped: true, reason: 'PUSH_NOT_CONFIGURED' };
  }

  const autoEnabled = await leadsPushSettingsService.isAutoWishlistPushEnabled('ecomm');
  if (!autoEnabled) {
    return { skipped: true, reason: 'AUTO_DISABLED' };
  }

  ensureVapidConfigured();

  const wishlists = await Wishlist.find({ 'products.0': { $exists: true } })
    .select('userId products')
    .lean();
  if (!wishlists.length) {
    return { sent: 0, skipped: 0, failed: 0, processedUsers: 0 };
  }

  const wishlistUserIds = wishlists.map((w) => w.userId).filter(Boolean);
  const users = await User.find({
    _id: { $in: wishlistUserIds },
    ...scopeQuery,
  })
    .select('_id name')
    .lean();

  if (!users.length) {
    return { sent: 0, skipped: 0, failed: 0, processedUsers: 0 };
  }

  const userNameById = new Map(users.map((u) => [String(u._id), u.name]));
  const eligibleUserIds = users.map((u) => u._id);

  const startOfToday = getStartOfTodayUtcForIst();
  const subscriptions = await PushSubscription.find({
    userId: { $in: eligibleUserIds },
    isActive: true,
    $or: [
      { lastWishlistReminderPushAt: null },
      { lastWishlistReminderPushAt: { $lt: startOfToday } },
    ],
  }).select('userId');

  const userIdsToNotify = [...new Set(subscriptions.map((s) => String(s.userId)))];
  const results = { sent: 0, skipped: 0, failed: 0, processedUsers: 0 };

  for (let i = 0; i < userIdsToNotify.length; i += AUTO_BATCH_SIZE) {
    const batch = userIdsToNotify.slice(i, i + AUTO_BATCH_SIZE);
    for (const userId of batch) {
      results.processedUsers += 1;
      try {
        const outcome = await sendWishlistReminderPushToUser({
          userId,
          userName: userNameById.get(userId),
          enforceDailyLimit: true,
        });
        if (outcome.status === 'sent') results.sent += 1;
        else if (outcome.status === 'skipped') results.skipped += 1;
        else results.failed += 1;
      } catch (err) {
        results.failed += 1;
        logger.error('[wishlistReminderPush] auto user failed', {
          userId,
          message: err?.message || String(err),
        });
      }
      await delay(SEND_DELAY_MS);
    }
  }

  logger.info('[wishlistReminderPush] auto run complete', results);
  return results;
}

function getWishlistAutoHourIst() {
  const raw = Number(process.env.WISHLIST_REMINDER_PUSH_AUTO_HOUR_IST);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 23) return Math.floor(raw);
  return 18;
}

module.exports = {
  sendWishlistReminderPushToUser,
  sendAutoWishlistReminderPushes,
  getWishlistAutoHourIst,
  isPushConfigured,
};

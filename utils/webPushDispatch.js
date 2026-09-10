/**
 * Shared web-push send + dead-subscription cleanup.
 * Used by cart / wishlist / new-products / OOS restock — keeps VAPID + error handling in one place.
 */
const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');
const logger = require('./logger');
const {
  getVapidPublicKey,
  getVapidPrivateKey,
  getVapidSubject,
  isPushConfigured,
} = require('./pushVapid');
const { resolvePushBrandIconUrl } = require('./storefrontFrontendUrl');

let vapidConfigured = false;

function ensureVapidConfigured() {
  if (vapidConfigured) return;
  const publicKey = getVapidPublicKey();
  const privateKey = getVapidPrivateKey();
  if (!publicKey || !privateKey) {
    const err = new Error(
      'Web push is not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on the server.'
    );
    err.code = 'PUSH_NOT_CONFIGURED';
    throw err;
  }
  webpush.setVapidDetails(getVapidSubject(), publicKey, privateKey);
  vapidConfigured = true;
}

function isExpiredSubscriptionError(err) {
  const status = err?.statusCode || err?.status;
  return status === 404 || status === 410;
}

async function deactivateSubscription(subscriptionDoc, reason) {
  try {
    subscriptionDoc.isActive = false;
    await subscriptionDoc.save();
  } catch (saveErr) {
    logger.warn('[webPushDispatch] deactivate save failed', {
      subscriptionId: String(subscriptionDoc?._id || ''),
      message: saveErr?.message || String(saveErr),
    });
  }
  logger.warn('[webPushDispatch] subscription deactivated', {
    subscriptionId: String(subscriptionDoc?._id || ''),
    userId: String(subscriptionDoc?.userId || ''),
    reason,
  });
}

/**
 * @param {object} subscriptionDoc mongoose PushSubscription doc
 * @param {{ title: string, body?: string, icon?: string, badge?: string, tag?: string, image?: string, data?: object, url?: string }} payload
 * @param {{ touchFields?: Record<string, Date|null> }} [options]
 */
async function sendPushToSubscription(subscriptionDoc, payload, options = {}) {
  ensureVapidConfigured();

  const pushSubscription = {
    endpoint: subscriptionDoc.endpoint,
    keys: {
      p256dh: subscriptionDoc.keys.p256dh,
      auth: subscriptionDoc.keys.auth,
    },
  };

  const brandIcon = resolvePushBrandIconUrl();
  const data =
    payload.data && typeof payload.data === 'object'
      ? { ...payload.data }
      : { url: payload.url || '/' };
  if (!data.url && payload.url) data.url = payload.url;

  const ctaLabel =
    payload.ctaLabel ||
    data.ctaLabel ||
    null;
  if (ctaLabel && !data.ctaLabel) data.ctaLabel = ctaLabel;

  const notificationPayload = JSON.stringify({
    title: payload.title || 'FABUNIQO',
    body: payload.body || '',
    icon: payload.icon || brandIcon,
    badge: payload.badge || brandIcon,
    tag: payload.tag || 'fabuniqo',
    image: payload.image || undefined,
    ctaLabel: ctaLabel || undefined,
    data,
  });

  await webpush.sendNotification(pushSubscription, notificationPayload, {
    TTL: 60 * 60 * 12,
    urgency: 'normal',
  });

  subscriptionDoc.isActive = true;
  subscriptionDoc.failureCount = 0;
  subscriptionDoc.lastPushAt = new Date();
  if (options.touchFields && typeof options.touchFields === 'object') {
    Object.assign(subscriptionDoc, options.touchFields);
  }
  await subscriptionDoc.save();
}

/**
 * Send to all active subscriptions for a user.
 * @returns {{ sent: number, failed: number, skipped?: string }}
 */
async function sendPushToUser(userId, payload, options = {}) {
  if (!userId) return { sent: 0, failed: 0, skipped: 'NO_USER' };
  if (!isPushConfigured()) return { sent: 0, failed: 0, skipped: 'PUSH_NOT_CONFIGURED' };

  const subscriptions = await PushSubscription.find({
    userId,
    isActive: true,
  });

  if (!subscriptions.length) {
    return { sent: 0, failed: 0, skipped: 'NO_SUBSCRIPTION' };
  }

  let sent = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    try {
      await sendPushToSubscription(sub, payload, options);
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
        logger.error('[webPushDispatch] send failed', {
          userId: String(userId),
          subscriptionId: String(sub._id),
          message: err?.message || String(err),
          status: err?.statusCode || err?.status,
        });
      }
    }
  }

  return { sent, failed };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ensureVapidConfigured,
  isExpiredSubscriptionError,
  deactivateSubscription,
  sendPushToSubscription,
  sendPushToUser,
  delay,
  isPushConfigured,
};

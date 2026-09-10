/**
 * New-products digest: enqueue on listing → send in next IST slot (11–13 or 16–19).
 * Fire at slot start (11:00 / 16:00) to avoid cart@17 and wishlist@18.
 */
const NewProductDigestQueue = require('../models/NewProductDigestQueue');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');
const logger = require('../utils/logger');
const { getAppName } = require('../utils/appBrand');
const { resolveNewArrivalsPageUrl } = require('../utils/storefrontFrontendUrl');
const { resolveNextDigestSlot, getIstParts, shouldFireDigestNow } = require('../utils/newProductDigestSlots');
const newProductsDigestPushTemplate = require('../templates/newProductsDigestPush.template');
const {
  ensureVapidConfigured,
  sendPushToSubscription,
  isExpiredSubscriptionError,
  deactivateSubscription,
  delay,
  isPushConfigured,
} = require('../utils/webPushDispatch');

const SEND_DELAY_MS = 150;
const AUTO_BATCH_SIZE = 80;

function envDigestEnabled() {
  const raw = process.env.NEW_PRODUCTS_DIGEST_PUSH_ENABLED;
  if (raw == null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return true;
}

function extractProductImage(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  for (const v of variants) {
    const imgs = Array.isArray(v?.images) ? v.images : [];
    const sorted = imgs.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const url = sorted.find((i) => i?.url)?.url;
    if (url) return String(url);
  }
  const productImgs = Array.isArray(product?.images) ? product.images : [];
  return productImgs.find((i) => i?.url)?.url || null;
}

function applyPlaceholders(text, vars) {
  let out = String(text || '');
  Object.entries(vars).forEach(([key, value]) => {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  });
  return out;
}

/**
 * Fire-and-forget safe enqueue. Only active ecomm listings.
 * @param {object} product — lean or mongoose product
 */
async function enqueueNewProductForDigest(product, storefront = 'ecomm') {
  try {
    if (!envDigestEnabled() || !isPushConfigured()) {
      return { queued: false, reason: 'disabled_or_unconfigured' };
    }
    if (!product?._id) return { queued: false, reason: 'no_product' };

    const status = String(product.status || '').toLowerCase();
    if (status && status !== 'active') {
      return { queued: false, reason: 'not_active' };
    }

    const sf = storefront === 'wholesale' ? 'wholesale' : 'ecomm';
    const { dateKey, slot } = resolveNextDigestSlot(new Date());

    await NewProductDigestQueue.findOneAndUpdate(
      {
        productId: product._id,
        storefront: sf,
        targetDateKey: dateKey,
        targetSlot: slot,
      },
      {
        $setOnInsert: {
          productId: product._id,
          storefront: sf,
          name: product.name || product.title || '',
          slug: product.slug || '',
          imageUrl: extractProductImage(product),
          targetDateKey: dateKey,
          targetSlot: slot,
          status: 'pending',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return { queued: true, dateKey, slot };
  } catch (err) {
    if (err?.code === 11000) return { queued: true, reason: 'duplicate' };
    logger.warn('[newProductsDigest] enqueue failed', {
      productId: String(product?._id || ''),
      message: err?.message || String(err),
    });
    return { queued: false, reason: 'error' };
  }
}

function buildDigestPayload(count) {
  const url = resolveNewArrivalsPageUrl('ecomm');
  const countLabel = count === 1 ? 'style' : 'styles';
  const vars = {
    appName: getAppName(),
    count: String(count),
    countLabel,
  };
  return {
    title: newProductsDigestPushTemplate.title,
    body: applyPlaceholders(newProductsDigestPushTemplate.body, vars),
    icon: newProductsDigestPushTemplate.icon,
    badge: newProductsDigestPushTemplate.badge,
    tag: `${newProductsDigestPushTemplate.tag}-${Date.now()}`,
    ctaLabel: newProductsDigestPushTemplate.ctaLabel,
    data: {
      type: 'new-products-digest',
      url,
      count,
      ctaLabel: newProductsDigestPushTemplate.ctaLabel,
    },
  };
}

/**
 * Send pending queue items for a specific dateKey+slot to subscribed ecomm users.
 */
async function sendDigestForSlot({ dateKey, slot }) {
  if (!envDigestEnabled() || !isPushConfigured()) {
    return { skipped: true, reason: 'disabled_or_unconfigured' };
  }

  const pending = await NewProductDigestQueue.find({
    status: 'pending',
    storefront: 'ecomm',
    targetDateKey: dateKey,
    targetSlot: slot,
  })
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();

  if (!pending.length) {
    return { skipped: true, reason: 'EMPTY_QUEUE', dateKey, slot };
  }

  ensureVapidConfigured();
  const payload = buildDigestPayload(pending.length);

  const customers = await User.find({ userType: 'user' }).select('_id').lean();
  const customerIds = customers.map((u) => u._id);
  if (!customerIds.length) {
    await NewProductDigestQueue.updateMany(
      { _id: { $in: pending.map((p) => p._id) } },
      { $set: { status: 'skipped', sentAt: new Date() } }
    );
    return { skipped: true, reason: 'NO_USERS', productCount: pending.length };
  }

  const subscriptions = await PushSubscription.find({
    userId: { $in: customerIds },
    isActive: true,
  });

  if (!subscriptions.length) {
    await NewProductDigestQueue.updateMany(
      { _id: { $in: pending.map((p) => p._id) } },
      { $set: { status: 'skipped', sentAt: new Date() } }
    );
    return { skipped: true, reason: 'NO_SUBSCRIPTIONS', productCount: pending.length };
  }

  // One push per user (first active device), daily digest stamp
  const byUser = new Map();
  for (const sub of subscriptions) {
    const key = String(sub.userId);
    if (!byUser.has(key)) byUser.set(key, sub);
  }

  let sent = 0;
  let failed = 0;
  const userSubs = [...byUser.values()];

  for (let i = 0; i < userSubs.length; i += AUTO_BATCH_SIZE) {
    const batch = userSubs.slice(i, i + AUTO_BATCH_SIZE);
    for (const sub of batch) {
      try {
        await sendPushToSubscription(sub, payload, {
          touchFields: { lastNewProductsDigestAt: new Date() },
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        if (isExpiredSubscriptionError(err)) {
          await deactivateSubscription(sub, err.statusCode || err.status);
        } else {
          logger.error('[newProductsDigest] send failed', {
            userId: String(sub.userId),
            message: err?.message || String(err),
          });
        }
      }
      await delay(SEND_DELAY_MS);
    }
  }

  await NewProductDigestQueue.updateMany(
    { _id: { $in: pending.map((p) => p._id) } },
    { $set: { status: 'sent', sentAt: new Date() } }
  );

  const result = {
    dateKey,
    slot,
    productCount: pending.length,
    sent,
    failed,
  };
  logger.info('[newProductsDigest] slot send complete', result);
  return result;
}

async function maybeRunDigestForNow(now = new Date()) {
  const { dateKey: todayKey } = getIstParts(now);
  const results = [];

  for (const slot of ['morning', 'evening']) {
    const { fire, dateKey } = shouldFireDigestNow(slot, now);
    if (!fire) continue;
    const keyDate = dateKey || todayKey;
    // eslint-disable-next-line no-await-in-loop
    const outcome = await sendDigestForSlot({ dateKey: keyDate, slot });
    results.push(outcome);
  }

  if (!results.length) {
    const { hour, dateKey } = getIstParts(now);
    return { skipped: true, reason: 'NOT_FIRE_WINDOW', hour, dateKey };
  }

  // Prefer a non-skipped result for scheduler idempotency key
  const primary = results.find((r) => !r.skipped) || results[0];
  return primary;
}

module.exports = {
  enqueueNewProductForDigest,
  sendDigestForSlot,
  maybeRunDigestForNow,
  resolveNextDigestSlot,
  envDigestEnabled,
  isPushConfigured,
};

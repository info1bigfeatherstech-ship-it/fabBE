const LeadsPushSettings = require('../models/LeadsPushSettings');
const { isPushConfigured } = require('../utils/pushVapid');
const logger = require('../utils/logger');
const {
  cartReminderDaysLabel,
  wishlistReminderDaysLabel,
} = require('../utils/reminderPushSchedule');

const VALID_STOREFRONTS = new Set(['ecomm', 'wholesale']);

function normalizeStorefront(value) {
  const s = String(value || 'ecomm').toLowerCase().trim();
  return VALID_STOREFRONTS.has(s) ? s : 'ecomm';
}

function getAutoPushHourIst() {
  const raw = Number(process.env.CART_REMINDER_PUSH_AUTO_HOUR_IST);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 23) return Math.floor(raw);
  return 17;
}

function getWishlistAutoPushHourIst() {
  const raw = Number(process.env.WISHLIST_REMINDER_PUSH_AUTO_HOUR_IST);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 23) return Math.floor(raw);
  return 18;
}

async function getOrCreateSettings(storefront) {
  const sf = normalizeStorefront(storefront);
  let doc = await LeadsPushSettings.findOne({ storefront: sf }).lean();
  if (doc) return doc;

  try {
    const created = await LeadsPushSettings.create({
      storefront: sf,
      autoPushEnabled: false,
      autoWishlistPushEnabled: false,
    });
    logger.info('[leadsPushSettings] Created default settings', { storefront: sf });
    return created.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      return LeadsPushSettings.findOne({ storefront: sf }).lean();
    }
    throw err;
  }
}

function toAdminPayload(doc) {
  return {
    storefront: doc?.storefront || 'ecomm',
    autoPushEnabled: Boolean(doc?.autoPushEnabled),
    autoWishlistPushEnabled: Boolean(doc?.autoWishlistPushEnabled),
    autoPushHourIst: getAutoPushHourIst(),
    autoWishlistPushHourIst: getWishlistAutoPushHourIst(),
    cartReminderDaysLabel: cartReminderDaysLabel(),
    wishlistReminderDaysLabel: wishlistReminderDaysLabel(),
    pushConfigured: isPushConfigured(),
    updatedAt: doc?.updatedAt || null,
  };
}

async function getAdminSettings(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return toAdminPayload(doc);
}

/** Cart auto reminder gate (legacy name kept for callers). */
async function isAutoPushEnabled(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return Boolean(doc?.autoPushEnabled);
}

async function isAutoWishlistPushEnabled(storefront) {
  const doc = await getOrCreateSettings(storefront);
  return Boolean(doc?.autoWishlistPushEnabled);
}

/**
 * Partial update — pass only fields that should change.
 * Avoid upsert $set + $setOnInsert on the same paths (Mongo conflict 40/112).
 * Ensure row exists first, then $set only the patched fields.
 * @param {string} storefront
 * @param {{ autoPushEnabled?: boolean, autoWishlistPushEnabled?: boolean }} patch
 * @param {string|null} updatedByUserId
 */
async function updatePushSettings(storefront, patch = {}, updatedByUserId = null) {
  const sf = normalizeStorefront(storefront);
  const $set = { updatedBy: updatedByUserId || null };

  if (patch.autoPushEnabled !== undefined) {
    $set.autoPushEnabled = Boolean(patch.autoPushEnabled);
  }
  if (patch.autoWishlistPushEnabled !== undefined) {
    $set.autoWishlistPushEnabled = Boolean(patch.autoWishlistPushEnabled);
  }

  if (
    patch.autoPushEnabled === undefined &&
    patch.autoWishlistPushEnabled === undefined
  ) {
    const err = new Error(
      'Provide autoPushEnabled and/or autoWishlistPushEnabled'
    );
    err.code = 'PUSH_SETTINGS_PATCH_EMPTY';
    throw err;
  }

  // Create-if-missing first so update never needs conflicting $setOnInsert paths.
  await getOrCreateSettings(sf);

  const doc = await LeadsPushSettings.findOneAndUpdate(
    { storefront: sf },
    { $set },
    { new: true, runValidators: true }
  ).lean();

  if (!doc) {
    const err = new Error('Push settings document missing after create');
    err.code = 'PUSH_SETTINGS_MISSING';
    throw err;
  }

  logger.info('[leadsPushSettings] settings updated', {
    storefront: sf,
    autoPushEnabled: doc.autoPushEnabled,
    autoWishlistPushEnabled: doc.autoWishlistPushEnabled,
    updatedBy: updatedByUserId ? String(updatedByUserId) : null,
  });

  return toAdminPayload(doc);
}

/** @deprecated Prefer updatePushSettings — kept for older callers expecting cart-only. */
async function updateAutoPushEnabled(storefront, enabled, updatedByUserId = null) {
  return updatePushSettings(storefront, { autoPushEnabled: enabled }, updatedByUserId);
}

module.exports = {
  normalizeStorefront,
  getAutoPushHourIst,
  getWishlistAutoPushHourIst,
  getAdminSettings,
  isAutoPushEnabled,
  isAutoWishlistPushEnabled,
  updatePushSettings,
  updateAutoPushEnabled,
};

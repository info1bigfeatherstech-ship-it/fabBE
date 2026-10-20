const referralService = require('../services/referral.service');
const { evaluateCartForCheckout } = require('../services/checkoutComputation.service');
const { findCartForStorefront } = require('../services/cartStorefront.service');
const logger = require('../utils/logger');

function storefrontFromReq(req) {
  return req.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
}

function sendPromoError(res, err, fallbackMessage, fallbackCode) {
  const status = Number(err?.statusCode) || 500;
  return res.status(status).json({
    success: false,
    code: err?.code || fallbackCode,
    message: err?.message || fallbackMessage,
    ...(err?.details ? { details: err.details } : {})
  });
}

/** GET /api/referral/settings */
exports.getPublicSettings = async (req, res) => {
  try {
    const settings = await referralService.getSettings(storefrontFromReq(req));
    return res.json({
      success: true,
      settings: referralService.publicSettingsView(settings)
    });
  } catch (err) {
    logger.error('[referral] public settings failed', { message: err?.message || String(err) });
    return res.status(500).json({
      success: false,
      code: 'REFERRAL_SETTINGS_FAILED',
      message: 'Failed to load referral settings'
    });
  }
};

/** GET /api/referral/me */
exports.getMine = async (req, res) => {
  try {
    const data = await referralService.getMyReferral(req.userId, storefrontFromReq(req));
    return res.json({ success: true, ...data });
  } catch (err) {
    logger.error('[referral] get mine failed', { message: err?.message || String(err) });
    return sendPromoError(res, err, 'Failed to load referral code', 'REFERRAL_FETCH_FAILED');
  }
};

/** POST /api/referral/generate */
exports.generateMine = async (req, res) => {
  try {
    const created = await referralService.generateCodeForUser(req.userId, storefrontFromReq(req));
    const data = await referralService.getMyReferral(req.userId, storefrontFromReq(req));
    return res.json({
      success: true,
      generated: Boolean(created?.code),
      ...data
    });
  } catch (err) {
    return sendPromoError(res, err, 'Could not generate referral code', 'REFERRAL_GENERATE_FAILED');
  }
};

/** POST /api/referral/validate */
exports.validate = async (req, res) => {
  try {
    const code = String(req.body?.code || req.body?.couponCode || '').trim();
    const storefront = storefrontFromReq(req);
    const finalUserType = storefront === 'wholesale' ? 'wholesaler' : 'normal';

    let subtotal = Number(req.body?.subtotal);
    if (req.body?.useServercart !== false || !Number.isFinite(subtotal) || subtotal < 0) {
      const cartDoc = await findCartForStorefront(req.userId, storefront);
      if (!cartDoc?.items?.length) {
        return res.status(400).json({
          success: false,
          valid: false,
          code: 'CART_EMPTY',
          message: 'Add items to your bag before applying a referral code'
        });
      }
      const ev = await evaluateCartForCheckout(cartDoc, finalUserType, null, storefront);
      subtotal = ev.subtotal;
    }

    const quoted = await referralService.quoteDiscount({
      code,
      subtotal,
      refereeUserId: req.userId,
      storefront
    });

    return res.json({
      success: true,
      valid: true,
      kind: 'referral',
      code: quoted.code,
      discount: quoted.discount,
      discountType: quoted.discountType,
      discountValue: quoted.discountValue,
      maxDiscountAmount: quoted.maxDiscountAmount,
      minOrderValue: quoted.minOrderValue,
      message: `Referral ${quoted.code} applied · you save ₹${quoted.discount}`
    });
  } catch (err) {
    const status = Number(err?.statusCode) || 400;
    return res.status(status).json({
      success: false,
      valid: false,
      code: err?.code || 'REFERRAL_INVALID',
      message: err?.message || 'Could not apply this referral code',
      ...(err?.details ? { details: err.details } : {})
    });
  }
};

/** GET /api/admin/referral/settings */
exports.adminGetSettings = async (req, res) => {
  try {
    const sf = String(req.query.storefront || 'ecomm');
    const settings = await referralService.getSettings(sf, { bypassCache: true });
    return res.json({ success: true, settings });
  } catch (err) {
    return sendPromoError(res, err, 'Failed to load referral settings', 'REFERRAL_SETTINGS_FAILED');
  }
};

/** PUT /api/admin/referral/settings */
exports.adminUpdateSettings = async (req, res) => {
  try {
    const sf = String(req.body?.storefront || req.query.storefront || 'ecomm');
    const settings = await referralService.updateSettings(sf, req.body || {}, req.userId);
    return res.json({ success: true, settings });
  } catch (err) {
    return sendPromoError(res, err, 'Failed to update referral settings', 'REFERRAL_SETTINGS_UPDATE_FAILED');
  }
};

/** GET /api/admin/referral/codes */
exports.adminListCodes = async (req, res) => {
  try {
    const result = await referralService.listCodesForAdmin({
      storefront: req.query.storefront || 'ecomm',
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return sendPromoError(res, err, 'Failed to load referral codes', 'REFERRAL_CODES_FAILED');
  }
};

/** GET /api/admin/referral/codes/:code */
exports.adminGetCode = async (req, res) => {
  try {
    const detail = await referralService.getCodeDetailForAdmin(
      req.params.code,
      req.query.storefront || 'ecomm'
    );
    if (!detail) {
      return res.status(404).json({
        success: false,
        code: 'REFERRAL_NOT_FOUND',
        message: 'Referral code not found'
      });
    }
    return res.json({ success: true, code: detail });
  } catch (err) {
    return sendPromoError(res, err, 'Failed to load referral code', 'REFERRAL_CODE_FAILED');
  }
};

/** GET /api/admin/referral/redemptions */
exports.adminListRedemptions = async (req, res) => {
  try {
    const result = await referralService.listRedemptionsForAdmin({
      storefront: req.query.storefront || 'ecomm',
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      search: req.query.search
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return sendPromoError(res, err, 'Failed to load referral usage', 'REFERRAL_USAGE_FAILED');
  }
};

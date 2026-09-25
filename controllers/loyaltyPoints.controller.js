const mongoose = require('mongoose');
const User = require('../models/User');
const loyaltyPointsService = require('../services/loyaltyPoints.service');

function storefrontFromReq(req) {
  return req.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
}

/** GET /api/loyalty-points/me */
exports.getMyPoints = async (req, res) => {
  try {
    const settings = await loyaltyPointsService.getSettings(storefrontFromReq(req));
    // Heal balances wiped by older badge recompute (ledger remains source of truth).
    await loyaltyPointsService.ensureUserPointsBalanceSynced(req.userId);
    const user = await User.findById(req.userId).select('loyalty').lean();
    return res.json({
      success: true,
      points: loyaltyPointsService.publicUserPointsView(user, settings)
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      code: 'LOYALTY_POINTS_FETCH_FAILED',
      message: err.message || 'Failed to load loyalty points'
    });
  }
};

/** GET /api/loyalty-points/me/ledger */
exports.getMyLedger = async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await loyaltyPointsService.listLedgerForUser(req.userId, { page, limit });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      code: 'LOYALTY_LEDGER_FAILED',
      message: err.message || 'Failed to load ledger'
    });
  }
};

/** GET /api/loyalty-points/settings (public storefront settings, no secrets) */
exports.getPublicSettings = async (req, res) => {
  try {
    const settings = await loyaltyPointsService.getSettings(storefrontFromReq(req));
    return res.json({
      success: true,
      settings: loyaltyPointsService.publicSettingsView(settings)
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      code: 'LOYALTY_SETTINGS_FAILED',
      message: err.message || 'Failed to load settings'
    });
  }
};

/** GET /api/admin/loyalty-points/settings */
exports.adminGetSettings = async (req, res) => {
  try {
    const sf = String(req.query.storefront || 'ecomm');
    const settings = await loyaltyPointsService.getSettings(sf, { bypassCache: true });
    return res.json({ success: true, settings });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to load settings'
    });
  }
};

/** PUT /api/admin/loyalty-points/settings */
exports.adminUpdateSettings = async (req, res) => {
  try {
    const sf = String(req.body?.storefront || req.query.storefront || 'ecomm');
    const settings = await loyaltyPointsService.updateSettings(sf, req.body || {}, req.userId);
    return res.json({ success: true, settings });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Failed to update settings'
    });
  }
};

/** GET /api/admin/loyalty-points/rules */
exports.adminListRules = async (req, res) => {
  try {
    const sf = String(req.query.storefront || 'ecomm');
    const rules = await loyaltyPointsService.listEarnRules(sf);
    return res.json({ success: true, rules });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /api/admin/loyalty-points/rules */
exports.adminCreateRule = async (req, res) => {
  try {
    const sf = String(req.body?.storefront || 'ecomm');
    const rule = await loyaltyPointsService.upsertEarnRule(null, req.body || {}, sf);
    return res.status(201).json({ success: true, rule });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/** PUT /api/admin/loyalty-points/rules/:id */
exports.adminUpdateRule = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid rule id' });
    }
    const sf = String(req.body?.storefront || 'ecomm');
    const rule = await loyaltyPointsService.upsertEarnRule(req.params.id, req.body || {}, sf);
    if (!rule) return res.status(404).json({ success: false, message: 'Rule not found' });
    return res.json({ success: true, rule });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

/** DELETE /api/admin/loyalty-points/rules/:id */
exports.adminDeleteRule = async (req, res) => {
  try {
    await loyaltyPointsService.deleteEarnRule(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /api/admin/loyalty-points/adjust */
exports.adminAdjust = async (req, res) => {
  try {
    const { userId, points, note, storefront } = req.body || {};
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }
    const result = await loyaltyPointsService.adminAdjustPoints({
      userId,
      points,
      note,
      createdBy: req.userId,
      storefront: storefront || 'ecomm'
    });
    const balance = await loyaltyPointsService.getUserPointsBalance(userId);
    return res.json({
      success: true,
      balance,
      entry: result.entry || null,
      skipped: Boolean(result.skipped)
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      code: err.code,
      message: err.message || 'Adjust failed'
    });
  }
};

/** GET /api/admin/loyalty-points/users/:userId */
exports.adminGetUserPoints = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(userId))) {
      return res.status(400).json({ success: false, message: 'Invalid userId' });
    }
    const settings = await loyaltyPointsService.getSettings(String(req.query.storefront || 'ecomm'));
    const repair = await loyaltyPointsService.repairUserPointsBalanceFromLedger(userId, {
      force: String(req.query.repair || '') === '1'
    });
    const user = await User.findById(userId).select('loyalty name email phone').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const ledger = await loyaltyPointsService.listLedgerForUser(userId, { page, limit });
    return res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone
      },
      points: loyaltyPointsService.publicUserPointsView(user, settings),
      repair,
      ledger
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /api/admin/loyalty-points/repair-balances — ops: sync cached balances from ledger */
exports.adminRepairBalances = async (req, res) => {
  try {
    const userId = req.body?.userId || req.query?.userId;
    if (userId) {
      if (!mongoose.Types.ObjectId.isValid(String(userId))) {
        return res.status(400).json({ success: false, message: 'Invalid userId' });
      }
      const repair = await loyaltyPointsService.repairUserPointsBalanceFromLedger(userId, {
        force: Boolean(req.body?.force)
      });
      return res.json({ success: true, repair });
    }
    const result = await loyaltyPointsService.repairAllStalePointsBalances({
      limit: req.body?.limit || req.query?.limit || 500
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Repair failed'
    });
  }
};

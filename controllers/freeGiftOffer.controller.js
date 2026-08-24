/**
 * Admin CRUD for free-gift offers (Marketing → Offers → Free Gift).
 */
const mongoose = require('mongoose');
const FreeGiftOffer = require('../models/FreeGiftOffer');
const {
  deactivateOtherGiftOffers,
  mapGiftOfferPublic,
  isGiftOfferCurrentlyLive
} = require('../services/freeGiftOffer.service');
const logger = require('../utils/logger');

function parseOptionalEndDate(raw) {
  if (raw == null || raw === '') return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) {
    const err = new Error('Invalid end date');
    err.statusCode = 400;
    err.code = 'INVALID_END_DATE';
    throw err;
  }
  return d;
}

function validateGiftOfferBody(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) {
      const err = new Error('Offer name is required');
      err.statusCode = 400;
      err.code = 'OFFER_NAME_REQUIRED';
      throw err;
    }
    if (name.length > 120) {
      const err = new Error('Offer name is too long (max 120 characters)');
      err.statusCode = 400;
      err.code = 'OFFER_NAME_TOO_LONG';
      throw err;
    }
    out.name = name;
  }
  if (!partial || body.description !== undefined) {
    out.description = String(body.description || '').trim().slice(0, 500);
  }
  if (!partial || body.endDate !== undefined) {
    out.endDate = parseOptionalEndDate(body.endDate);
  }
  if (!partial || body.isActive !== undefined) {
    out.isActive = body.isActive === true || body.isActive === 'true' || body.isActive === 1;
  }
  return out;
}

const createGiftOffer = async (req, res) => {
  try {
    const data = validateGiftOfferBody(req.body || {}, { partial: false });
    if (data.isActive === undefined) data.isActive = true;

    const offer = new FreeGiftOffer(data);
    await offer.save();

    if (offer.isActive) {
      await deactivateOtherGiftOffers(offer._id);
    }

    return res.status(201).json({
      success: true,
      message: 'Free gift offer created',
      offer: mapGiftOfferPublic(offer)
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        code: err.code || 'GIFT_OFFER_CREATE_FAILED',
        message: err.message
      });
    }
    logger.error('[FreeGiftOffer] create failed', { message: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      code: 'GIFT_OFFER_CREATE_FAILED',
      message: 'Failed to create free gift offer'
    });
  }
};

const getAllGiftOffers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const status = String(req.query.status || 'all').toLowerCase();
    const search = String(req.query.search || '').trim();

    const query = {};
    if (status === 'active') query.isActive = true;
    if (status === 'inactive') query.isActive = false;
    if (search) {
      query.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const [offers, total] = await Promise.all([
      FreeGiftOffer.find(query)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      FreeGiftOffer.countDocuments(query)
    ]);

    return res.json({
      success: true,
      offers: offers.map(mapGiftOfferPublic),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (err) {
    logger.error('[FreeGiftOffer] list failed', { message: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      code: 'GIFT_OFFER_LIST_FAILED',
      message: 'Failed to list free gift offers'
    });
  }
};

const getGiftOfferById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'Invalid offer id' });
    }
    const offer = await FreeGiftOffer.findById(id).lean();
    if (!offer) {
      return res.status(404).json({ success: false, code: 'OFFER_NOT_FOUND', message: 'Gift offer not found' });
    }
    return res.json({ success: true, offer: mapGiftOfferPublic(offer) });
  } catch (err) {
    logger.error('[FreeGiftOffer] getById failed', { message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, code: 'GIFT_OFFER_FETCH_FAILED', message: 'Failed to fetch gift offer' });
  }
};

const updateGiftOffer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'Invalid offer id' });
    }
    const data = validateGiftOfferBody(req.body || {}, { partial: true });
    const offer = await FreeGiftOffer.findByIdAndUpdate(id, { $set: data }, { new: true });
    if (!offer) {
      return res.status(404).json({ success: false, code: 'OFFER_NOT_FOUND', message: 'Gift offer not found' });
    }
    if (offer.isActive) {
      await deactivateOtherGiftOffers(offer._id);
    }
    return res.json({ success: true, message: 'Gift offer updated', offer: mapGiftOfferPublic(offer) });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        code: err.code || 'GIFT_OFFER_UPDATE_FAILED',
        message: err.message
      });
    }
    logger.error('[FreeGiftOffer] update failed', { message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, code: 'GIFT_OFFER_UPDATE_FAILED', message: 'Failed to update gift offer' });
  }
};

const deleteGiftOffer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'Invalid offer id' });
    }
    const offer = await FreeGiftOffer.findByIdAndDelete(id);
    if (!offer) {
      return res.status(404).json({ success: false, code: 'OFFER_NOT_FOUND', message: 'Gift offer not found' });
    }
    return res.json({ success: true, message: 'Gift offer deleted' });
  } catch (err) {
    logger.error('[FreeGiftOffer] delete failed', { message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, code: 'GIFT_OFFER_DELETE_FAILED', message: 'Failed to delete gift offer' });
  }
};

const toggleGiftOfferStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'Invalid offer id' });
    }
    const offer = await FreeGiftOffer.findById(id);
    if (!offer) {
      return res.status(404).json({ success: false, code: 'OFFER_NOT_FOUND', message: 'Gift offer not found' });
    }
    offer.isActive = !offer.isActive;
    await offer.save();
    if (offer.isActive) {
      await deactivateOtherGiftOffers(offer._id);
    }
    return res.json({
      success: true,
      message: offer.isActive ? 'Gift offer activated' : 'Gift offer deactivated',
      offer: mapGiftOfferPublic(offer),
      isLive: isGiftOfferCurrentlyLive(offer)
    });
  } catch (err) {
    logger.error('[FreeGiftOffer] toggle failed', { message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, code: 'GIFT_OFFER_TOGGLE_FAILED', message: 'Failed to toggle gift offer status' });
  }
};

/**
 * PUT /api/admin/free-gift-offers/:id/order-gift
 * Admin records gift name/number against a specific order (admin-only, never returned to storefront).
 * Body: { orderId: string, giftLabel: string }
 */
const saveOrderGiftRecord = async (req, res) => {
  try {
    const Order = require('../models/Order');
    const { orderId, giftLabel } = req.body || {};

    const id = String(orderId || '').trim();
    if (!id) {
      return res.status(400).json({ success: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' });
    }
    const label = String(giftLabel || '').trim();
    if (!label) {
      return res.status(400).json({ success: false, code: 'GIFT_LABEL_REQUIRED', message: 'giftLabel (name or number) is required' });
    }
    if (label.length > 200) {
      return res.status(400).json({ success: false, code: 'GIFT_LABEL_TOO_LONG', message: 'giftLabel max 200 characters' });
    }

    const order = await Order.findOne({ orderId: id });
    if (!order) {
      return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }

    // Only orders with a free-gift offer snapshot can have a gift record.
    const hasGiftOffer = Boolean(
      order.appliedFreeGiftOffer?.offerId || order.appliedFreeGiftOffer?.name
    );
    if (!hasGiftOffer) {
      return res.status(400).json({
        success: false,
        code: 'ORDER_HAS_NO_GIFT_OFFER',
        message: 'This order does not have a free gift offer applied'
      });
    }

    order.appliedFreeGiftOffer.adminGiftLabel = label;
    order.appliedFreeGiftOffer.adminGiftLabelSetAt = new Date();
    order.appliedFreeGiftOffer.adminGiftLabelSetBy = req.userId || null;
    order.markModified('appliedFreeGiftOffer');
    await order.save();

    return res.json({
      success: true,
      message: 'Gift record saved',
      orderId: id,
      adminGiftLabel: label
    });
  } catch (err) {
    logger.error('[FreeGiftOffer] saveOrderGiftRecord failed', { message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, code: 'GIFT_RECORD_SAVE_FAILED', message: 'Failed to save gift record' });
  }
};

module.exports = {
  createGiftOffer,
  getAllGiftOffers,
  getGiftOfferById,
  updateGiftOffer,
  deleteGiftOffer,
  toggleGiftOfferStatus,
  saveOrderGiftRecord
};

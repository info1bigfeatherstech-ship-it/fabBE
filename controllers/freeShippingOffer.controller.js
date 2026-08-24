/**
 * Admin CRUD for free-shipping offers (Marketing → Offers).
 */
const mongoose = require('mongoose');
const FreeShippingOffer = require('../models/FreeShippingOffer');
const {
  deactivateOtherOffers,
  mapOfferPublic,
  isOfferCurrentlyLive,
  roundMoney2
} = require('../services/freeShippingOffer.service');
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

function validateOfferBody(body, { partial = false } = {}) {
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
      const err = new Error('Offer name is too long');
      err.statusCode = 400;
      err.code = 'OFFER_NAME_TOO_LONG';
      throw err;
    }
    out.name = name;
  }
  if (!partial || body.description !== undefined) {
    out.description = String(body.description || '').trim().slice(0, 500);
  }
  if (!partial || body.minCartValue !== undefined) {
    const minCartValue = Number(body.minCartValue);
    if (!Number.isFinite(minCartValue) || minCartValue < 0) {
      const err = new Error('minCartValue must be a non-negative number');
      err.statusCode = 400;
      err.code = 'INVALID_MIN_CART_VALUE';
      throw err;
    }
    out.minCartValue = roundMoney2(minCartValue);
  }
  if (!partial || body.endDate !== undefined) {
    out.endDate = parseOptionalEndDate(body.endDate);
  }
  if (!partial || body.isActive !== undefined) {
    out.isActive = body.isActive === true || body.isActive === 'true' || body.isActive === 1;
  }
  return out;
}

const createOffer = async (req, res) => {
  try {
    const data = validateOfferBody(req.body || {}, { partial: false });
    if (data.isActive === undefined) data.isActive = true;

    const offer = new FreeShippingOffer(data);
    await offer.save();

    if (offer.isActive) {
      await deactivateOtherOffers(offer._id);
    }

    return res.status(201).json({
      success: true,
      message: 'Free shipping offer created',
      offer: mapOfferPublic(offer)
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        code: err.code || 'OFFER_CREATE_FAILED',
        message: err.message
      });
    }
    logger.error('[FreeShippingOffer] create failed', { message: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      code: 'OFFER_CREATE_FAILED',
      message: 'Failed to create free shipping offer'
    });
  }
};

const getAllOffers = async (req, res) => {
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
      FreeShippingOffer.find(query)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      FreeShippingOffer.countDocuments(query)
    ]);

    return res.json({
      success: true,
      offers: offers.map(mapOfferPublic),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    });
  } catch (err) {
    logger.error('[FreeShippingOffer] list failed', { message: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      code: 'OFFER_LIST_FAILED',
      message: 'Failed to list free shipping offers'
    });
  }
};

const getOfferById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'Invalid offer id' });
    }
    const offer = await FreeShippingOffer.findById(id).lean();
    if (!offer) {
      return res.status(404).json({ success: false, code: 'OFFER_NOT_FOUND', message: 'Offer not found' });
    }
    return res.json({ success: true, offer: mapOfferPublic(offer) });
  } catch (err) {
    logger.error('[FreeShippingOffer] getById failed', { message: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      code: 'OFFER_FETCH_FAILED',
      message: 'Failed to fetch offer'
    });
  }
};

const updateOffer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'Invalid offer id' });
    }
    const data = validateOfferBody(req.body || {}, { partial: true });
    const offer = await FreeShippingOffer.findByIdAndUpdate(id, { $set: data }, { new: true });
    if (!offer) {
      return res.status(404).json({ success: false, code: 'OFFER_NOT_FOUND', message: 'Offer not found' });
    }
    if (offer.isActive) {
      await deactivateOtherOffers(offer._id);
    }
    return res.json({
      success: true,
      message: 'Offer updated',
      offer: mapOfferPublic(offer)
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        code: err.code || 'OFFER_UPDATE_FAILED',
        message: err.message
      });
    }
    logger.error('[FreeShippingOffer] update failed', { message: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      code: 'OFFER_UPDATE_FAILED',
      message: 'Failed to update offer'
    });
  }
};

const deleteOffer = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'Invalid offer id' });
    }
    const offer = await FreeShippingOffer.findByIdAndDelete(id);
    if (!offer) {
      return res.status(404).json({ success: false, code: 'OFFER_NOT_FOUND', message: 'Offer not found' });
    }
    return res.json({ success: true, message: 'Offer deleted' });
  } catch (err) {
    logger.error('[FreeShippingOffer] delete failed', { message: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      code: 'OFFER_DELETE_FAILED',
      message: 'Failed to delete offer'
    });
  }
};

const toggleOfferStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, code: 'INVALID_ID', message: 'Invalid offer id' });
    }
    const offer = await FreeShippingOffer.findById(id);
    if (!offer) {
      return res.status(404).json({ success: false, code: 'OFFER_NOT_FOUND', message: 'Offer not found' });
    }
    offer.isActive = !offer.isActive;
    await offer.save();
    if (offer.isActive) {
      await deactivateOtherOffers(offer._id);
    }
    return res.json({
      success: true,
      message: offer.isActive ? 'Offer activated' : 'Offer deactivated',
      offer: mapOfferPublic(offer),
      isLive: isOfferCurrentlyLive(offer)
    });
  } catch (err) {
    logger.error('[FreeShippingOffer] toggle failed', { message: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      code: 'OFFER_TOGGLE_FAILED',
      message: 'Failed to toggle offer status'
    });
  }
};

module.exports = {
  createOffer,
  getAllOffers,
  getOfferById,
  updateOffer,
  deleteOffer,
  toggleOfferStatus
};

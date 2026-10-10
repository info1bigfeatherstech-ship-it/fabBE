const FestiveOfferSettings = require('../models/FestiveOfferSettings');

const STOREFRONT = 'ecomm';
const DEFAULT_LABEL = 'Festive Offers';
const MAX_LABEL = 48;

function normalizeLabel(raw) {
  const label = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_LABEL);
  return label || DEFAULT_LABEL;
}

function toPublicDto(doc) {
  const enabled = Boolean(doc?.enabled);
  const label = normalizeLabel(doc?.label);
  return {
    enabled,
    label,
    /** Fixed storefront route + ProductTag slug — not admin-editable. */
    href: '/shop/festive',
    tag: 'festive-offer',
    /** Convenience: badge should render only when enabled + non-empty label. */
    visible: enabled && Boolean(label)
  };
}

async function getOrCreateSettings() {
  let doc = await FestiveOfferSettings.findOne({ storefront: STOREFRONT });
  if (!doc) {
    doc = await FestiveOfferSettings.create({
      storefront: STOREFRONT,
      enabled: false,
      label: DEFAULT_LABEL
    });
  }
  return doc;
}

/** GET /api/marketing/festive-offer — public storefront badge config. */
exports.getPublicFestiveOfferSettings = async (_req, res) => {
  try {
    const doc = await getOrCreateSettings();
    return res.json({
      success: true,
      festiveOffer: toPublicDto(doc)
    });
  } catch (error) {
    console.error('[festiveOffer] getPublic', error?.message || error);
    return res.status(500).json({
      success: false,
      code: 'FESTIVE_OFFER_FETCH_FAILED',
      message: 'Could not load festive offer settings'
    });
  }
};

/** GET /api/admin/marketing/festive-offer */
exports.getAdminFestiveOfferSettings = async (_req, res) => {
  try {
    const doc = await getOrCreateSettings();
    return res.json({
      success: true,
      festiveOffer: {
        ...toPublicDto(doc),
        updatedAt: doc.updatedAt || null
      }
    });
  } catch (error) {
    console.error('[festiveOffer] getAdmin', error?.message || error);
    return res.status(500).json({
      success: false,
      code: 'FESTIVE_OFFER_FETCH_FAILED',
      message: 'Could not load festive offer settings'
    });
  }
};

/** PUT /api/admin/marketing/festive-offer  body: { enabled?, label? } */
exports.updateAdminFestiveOfferSettings = async (req, res) => {
  try {
    const doc = await getOrCreateSettings();
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      doc.enabled = Boolean(body.enabled);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'label')) {
      doc.label = normalizeLabel(body.label);
    }
    if (req.userId) {
      doc.updatedBy = req.userId;
    }

    await doc.save();

    return res.json({
      success: true,
      message: 'Festive offer settings updated',
      festiveOffer: {
        ...toPublicDto(doc),
        updatedAt: doc.updatedAt || null
      }
    });
  } catch (error) {
    console.error('[festiveOffer] updateAdmin', error?.message || error);
    return res.status(500).json({
      success: false,
      code: 'FESTIVE_OFFER_UPDATE_FAILED',
      message: error?.message || 'Could not update festive offer settings'
    });
  }
};

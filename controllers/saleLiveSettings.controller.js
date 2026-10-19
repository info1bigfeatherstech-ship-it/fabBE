const SaleLiveSettings = require('../models/SaleLiveSettings');

const STOREFRONT = 'ecomm';
const DEFAULT_LABEL = 'Sale is live';
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
    href: '/shop/sale',
    tag: 'on-sale',
    /** Convenience: badge should render only when enabled + non-empty label. */
    visible: enabled && Boolean(label)
  };
}

async function getOrCreateSettings() {
  let doc = await SaleLiveSettings.findOne({ storefront: STOREFRONT });
  if (doc) return doc;

  // Default enabled=true so first deploy matches prior hardcoded "Sale is live" UX.
  try {
    doc = await SaleLiveSettings.create({
      storefront: STOREFRONT,
      enabled: true,
      label: DEFAULT_LABEL
    });
    return doc;
  } catch (err) {
    // Concurrent first-hit race on unique storefront — re-read winner.
    if (err?.code === 11000) {
      doc = await SaleLiveSettings.findOne({ storefront: STOREFRONT });
      if (doc) return doc;
    }
    throw err;
  }
}

/** GET /api/marketing/sale-live — public storefront badge config. */
exports.getPublicSaleLiveSettings = async (_req, res) => {
  try {
    const doc = await getOrCreateSettings();
    return res.json({
      success: true,
      saleLive: toPublicDto(doc)
    });
  } catch (error) {
    console.error('[saleLive] getPublic', error?.message || error);
    return res.status(500).json({
      success: false,
      code: 'SALE_LIVE_FETCH_FAILED',
      message: 'Could not load sale live settings'
    });
  }
};

/** GET /api/admin/marketing/sale-live */
exports.getAdminSaleLiveSettings = async (_req, res) => {
  try {
    const doc = await getOrCreateSettings();
    return res.json({
      success: true,
      saleLive: {
        ...toPublicDto(doc),
        updatedAt: doc.updatedAt || null
      }
    });
  } catch (error) {
    console.error('[saleLive] getAdmin', error?.message || error);
    return res.status(500).json({
      success: false,
      code: 'SALE_LIVE_FETCH_FAILED',
      message: 'Could not load sale live settings'
    });
  }
};

/** PUT /api/admin/marketing/sale-live  body: { enabled?, label? } */
exports.updateAdminSaleLiveSettings = async (req, res) => {
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
      message: 'Sale live settings updated',
      saleLive: {
        ...toPublicDto(doc),
        updatedAt: doc.updatedAt || null
      }
    });
  } catch (error) {
    console.error('[saleLive] updateAdmin', error?.message || error);
    return res.status(500).json({
      success: false,
      code: 'SALE_LIVE_UPDATE_FAILED',
      message: error?.message || 'Could not update sale live settings'
    });
  }
};

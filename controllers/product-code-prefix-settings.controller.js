const productCodePrefixSettingsService = require('../services/productCodePrefixSettings.service');
const logger = require('../utils/logger');
const { buildRequestLogContext } = require('../utils/checkoutFlow');

/**
 * GET /api/admin/product-code-prefix/settings
 */
exports.getAdminProductCodePrefixSettings = async (req, res) => {
  try {
    const storefront = productCodePrefixSettingsService.normalizeStorefront(
      req.adminScope?.storefront || req.storefront
    );
    const policy = await productCodePrefixSettingsService.getPolicyForStorefront(storefront);
    return res.json({
      success: true,
      data: policy
    });
  } catch (err) {
    logger.error('getAdminProductCodePrefixSettings failed', buildRequestLogContext(req, {
      message: err.message
    }));
    return res.status(500).json({
      success: false,
      code: 'PRODUCT_CODE_PREFIX_FETCH_FAILED',
      message: 'Could not load product code prefix settings'
    });
  }
};

/**
 * PUT /api/admin/product-code-prefix/settings
 * Body: { prefix: "FU" | "MTL" } — 2–3 letters, required.
 * Does not rewrite existing product codes.
 */
exports.updateAdminProductCodePrefixSettings = async (req, res) => {
  try {
    const storefront = productCodePrefixSettingsService.normalizeStorefront(
      req.adminScope?.storefront || req.storefront
    );
    const result = await productCodePrefixSettingsService.applyAdminPatch(
      storefront,
      req.body || {},
      req.userId || null
    );

    if (!result.ok) {
      return res.status(400).json({
        success: false,
        code: 'PRODUCT_CODE_PREFIX_VALIDATION_FAILED',
        message: result.errors.join(' '),
        errors: result.errors
      });
    }

    logger.info('Product code prefix settings updated', buildRequestLogContext(req, {
      storefront,
      policy: result.policy
    }));

    return res.json({
      success: true,
      message: 'Product code prefix updated. Only new listings will use this prefix; existing codes are unchanged.',
      data: result.policy
    });
  } catch (err) {
    const status = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
    logger.error('updateAdminProductCodePrefixSettings failed', buildRequestLogContext(req, {
      message: err.message,
      stack: err.stack
    }));
    return res.status(status).json({
      success: false,
      code: err.code || 'PRODUCT_CODE_PREFIX_UPDATE_FAILED',
      message: status === 500 ? 'Could not update product code prefix settings' : err.message
    });
  }
};

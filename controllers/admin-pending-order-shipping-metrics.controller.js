/**
 * Admin pending-order weight / dimensions edit (preview + commit).
 */
const {
  previewOrApplyShippingMetricsEdit
} = require('../services/adminPendingOrderShippingMetrics.service');
const { createEditError } = require('../services/adminPendingOrderEdit.service');
const { getAdminOrderMatch } = require('../utils/adminOrderScope');
const logger = require('../utils/logger');

function sendError(res, err, fallbackMessage) {
  const status = Number(err?.statusCode) || 500;
  const code = err?.code || 'SHIPPING_METRICS_EDIT_FAILED';
  const message = err?.message || fallbackMessage || 'Could not edit shipping metrics';
  if (status >= 500) {
    logger.error('[adminPendingShippingMetrics]', { code, message, stack: err?.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message,
    details: err?.details || undefined
  });
}

/**
 * POST /api/orders/admin/items/:orderId/edit-pending-shipping-metrics/preview
 * Body: { lineOverrides: [{ productId, variantId, unitWeightKg, lengthCm, widthCm, heightCm }] }
 */
exports.previewPendingShippingMetricsEdit = async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const lineOverrides = req.body?.lineOverrides;
    const result = await previewOrApplyShippingMetricsEdit({
      orderId,
      lineOverrides,
      commit: false,
      adminUserId: req.user?.id || req.user?._id || null,
      scopeMatch: getAdminOrderMatch(req)
    });
    return res.json({
      success: true,
      message: 'Shipping metrics preview calculated',
      data: result.preview
    });
  } catch (err) {
    if (!err.statusCode) {
      return sendError(
        res,
        createEditError(500, 'SHIPPING_METRICS_EDIT_FAILED', err.message),
        err.message
      );
    }
    return sendError(res, err, 'Could not preview shipping metrics edit');
  }
};

/**
 * POST /api/orders/admin/items/:orderId/edit-pending-shipping-metrics
 */
exports.applyPendingShippingMetricsEdit = async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const lineOverrides = req.body?.lineOverrides;
    const result = await previewOrApplyShippingMetricsEdit({
      orderId,
      lineOverrides,
      commit: true,
      adminUserId: req.user?.id || req.user?._id || null,
      scopeMatch: getAdminOrderMatch(req)
    });
    return res.json({
      success: true,
      message:
        'Package weight/dimensions updated. Customer shipping stayed locked at checkout; courier will use the new package metrics.',
      data: result
    });
  } catch (err) {
    if (!err.statusCode) {
      return sendError(
        res,
        createEditError(500, 'SHIPPING_METRICS_EDIT_FAILED', err.message),
        err.message
      );
    }
    return sendError(res, err, 'Could not apply shipping metrics edit');
  }
};

/**
 * Shipmozo webhook — parse payload, find order, apply status (Shipmozo orders only).
 * Pure helpers are unit-tested; processShipmozoWebhook does DB work.
 *
 * Does NOT touch Shiprocket webhooks or Shiprocket orders.
 */

const Order = require('../models/Order');
const logger = require('../utils/logger');
const {
  SHIPPING_PROVIDERS,
  isShipmozoOrder
} = require('../constants/shippingProviders');
const { isRtoProviderStatus } = require('./shipmentOps/shiprocketStatusMap');
const {
  persistRtoTrackingInsights
} = require('./rtoRefund.service');

const WEBHOOK_SOURCE = 'shipmozo_webhook';

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimStr(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * Normalize Shipmozo webhook body into a stable shape.
 * Handles documented typo `refrence_id`.
 * @param {object|null|undefined} body
 */
function parseShipmozoWebhookPayload(body) {
  const payload = body && typeof body === 'object' ? body : {};

  const orderId = trimStr(
    payload.order_id ||
      payload.orderId ||
      payload.channel_order_id ||
      ''
  );
  const referenceId = trimStr(
    payload.refrence_id || // Shipmozo typo (documented)
      payload.reference_id ||
      payload.referenceId ||
      ''
  );
  const awbNumber = trimStr(
    payload.awb_number || payload.awb || payload.awb_code || payload.awbCode || ''
  );
  const currentStatus = trimStr(
    payload.current_status || payload.status || payload.shipment_status || ''
  );
  const courier = trimStr(
    payload.carrier || payload.courier || payload.courier_name || ''
  );
  const estimatedDelivery = trimStr(payload.expected_delivery_date || '') || null;
  const statusTime = trimStr(payload.status_time || '') || null;
  const shipmentType = trimStr(payload.shipment_type || '') || null;

  const events = mapStatusFeedToEvents(payload.status_feed, statusTime);

  return {
    orderId,
    referenceId,
    awbNumber,
    currentStatus: currentStatus || null,
    courier: courier || null,
    estimatedDelivery,
    statusTime,
    shipmentType,
    events,
    raw: payload
  };
}

/**
 * @param {object|null|undefined} statusFeed
 * @param {string|null} fallbackTime
 * @returns {object[]}
 */
function mapStatusFeedToEvents(statusFeed, fallbackTime = null) {
  const scan = statusFeed && Array.isArray(statusFeed.scan) ? statusFeed.scan : [];
  if (!scan.length) return [];

  return scan
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const status = trimStr(s.status || s.current_status || s.message || '');
      if (!status) return null;
      const atRaw = trimStr(s.date || s.time || s.status_time || s.timestamp || '') || fallbackTime;
      let at = null;
      if (atRaw) {
        const d = new Date(atRaw);
        at = Number.isNaN(d.getTime()) ? null : d;
      }
      return {
        status,
        location: trimStr(s.location || s.city || '') || null,
        description: trimStr(s.description || s.remark || '') || null,
        at,
        time: atRaw || null,
        date: atRaw || null,
        raw: s
      };
    })
    .filter(Boolean);
}

/**
 * Detect cancel-like statuses from Shipmozo webhook current_status.
 * @param {string|null|undefined} status
 */
function isShipmozoCancelStatus(status) {
  const statusNorm = trimStr(status)
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!statusNorm) return false;
  return (
    /\bcancel/.test(statusNorm) ||
    /shipment cancelled|order cancelled|awb cancel/.test(statusNorm)
  );
}

/**
 * Find order for webhook without preferring the wrong provider.
 * Lookup order: channel orderId → reference → shipmozo ids → AWB.
 * @param {{ orderId?: string, referenceId?: string, awbNumber?: string }} ids
 */
async function findOrderForShipmozoWebhook(ids = {}) {
  const channelId = trimStr(ids.orderId);
  const referenceId = trimStr(ids.referenceId);
  const awb = trimStr(ids.awbNumber);

  if (channelId) {
    const byChannel = await Order.findOne({ orderId: channelId });
    if (byChannel) return { order: byChannel, matchedBy: 'orderId' };
  }

  // Some integrations put merchant order id in refrence_id
  if (referenceId && referenceId !== channelId) {
    const byRefAsOrderId = await Order.findOne({ orderId: referenceId });
    if (byRefAsOrderId) return { order: byRefAsOrderId, matchedBy: 'reference_as_orderId' };
  }

  if (referenceId) {
    const bySmRef = await Order.findOne({
      $or: [
        { 'shipmentInfo.shipmozoOrderId': referenceId },
        { 'shipmentInfo.shipmozoReferenceId': referenceId },
        { 'shipmentInfo.shipmentId': referenceId }
      ]
    });
    if (bySmRef) return { order: bySmRef, matchedBy: 'shipmozo_reference' };
  }

  if (channelId) {
    const bySmOrder = await Order.findOne({
      $or: [
        { 'shipmentInfo.shipmozoOrderId': channelId },
        { 'shipmentInfo.shipmozoReferenceId': channelId }
      ]
    });
    if (bySmOrder) return { order: bySmOrder, matchedBy: 'shipmozo_order_id' };
  }

  if (awb) {
    const byAwb = await Order.findOne({
      $or: [
        { 'shipmentInfo.awbCode': awb },
        { 'shipmentInfo.trackingNumber': awb }
      ]
    });
    if (byAwb) return { order: byAwb, matchedBy: 'awb' };
  }

  return { order: null, matchedBy: null };
}

function wasRtoish(orderLike) {
  if (!orderLike) return false;
  if (String(orderLike.orderStatus || '').toLowerCase() === 'rto') return true;
  return isRtoProviderStatus(orderLike.shipmentInfo?.providerStatus);
}

/**
 * Apply a validated Shipmozo webhook payload to DB.
 * @param {object} body - raw req.body
 * @returns {Promise<object>}
 */
async function processShipmozoWebhook(body) {
  const parsed = parseShipmozoWebhookPayload(body);

  if (!parsed.orderId && !parsed.referenceId && !parsed.awbNumber) {
    return {
      success: false,
      httpStatus: 400,
      code: 'SHIPMOZO_WEBHOOK_IDS_REQUIRED',
      message: 'order_id, refrence_id/reference_id, or awb_number is required'
    };
  }

  let found;
  try {
    found = await findOrderForShipmozoWebhook({
      orderId: parsed.orderId,
      referenceId: parsed.referenceId,
      awbNumber: parsed.awbNumber
    });
  } catch (lookupErr) {
    logger.error('[shipmozoWebhook] order lookup failed', {
      message: lookupErr.message,
      stack: lookupErr.stack
    });
    return {
      success: false,
      httpStatus: 500,
      code: 'SHIPMOZO_WEBHOOK_LOOKUP_FAILED',
      message: 'Failed to look up order for webhook'
    };
  }

  const order = found.order;
  if (!order) {
    return {
      success: false,
      httpStatus: 404,
      code: 'ORDER_NOT_FOUND',
      message: 'Order not found for Shipmozo webhook payload'
    };
  }

  // Hard guard — never mutate Shiprocket (or non-Shipmozo) orders from this endpoint.
  if (!isShipmozoOrder(order)) {
    logger.warn('[shipmozoWebhook] ignored non-Shipmozo order', {
      orderId: order.orderId,
      matchedBy: found.matchedBy,
      shippingProvider: order.shippingProvider || null
    });
    return {
      success: true,
      ignored: true,
      httpStatus: 200,
      code: 'NOT_SHIPMOZO_ORDER',
      message: 'Webhook ignored — order is not a Shipmozo shipment',
      orderId: order.orderId
    };
  }

  const previousProviderStatus = order.shipmentInfo?.providerStatus || null;
  const previousOrderStatus = order.orderStatus || null;
  const previousRto = wasRtoish(order);

  const providerStatus =
    parsed.currentStatus || order.shipmentInfo?.providerStatus || null;

  // Cancel path — clear AWB for re-ship (same behaviour as reconcile)
  if (isShipmozoCancelStatus(providerStatus)) {
    try {
      const { applyLocalShipmentReset } = require('./shiprocketReconcile.service');
      const resetOrder = await applyLocalShipmentReset(order, {
        reason: providerStatus || 'Cancelled on Shipmozo',
        trigger: `${WEBHOOK_SOURCE}_cancel`,
        appendEvent: true
      });
      if (resetOrder) {
        try {
          const fresh = await Order.findOne({ orderId: order.orderId });
          if (fresh) {
            const prevEvents = Array.isArray(fresh.shipmentInfo?.rawEvents)
              ? fresh.shipmentInfo.rawEvents
              : [];
            const { mergeShipmentTrackingEvents } = require('./shipmentOps/trackingEventsMerge');
            const merged = mergeShipmentTrackingEvents(prevEvents, parsed.events, 80);
            fresh.shipmentInfo = {
              ...(fresh.shipmentInfo || {}),
              providerStatus: providerStatus || fresh.shipmentInfo?.providerStatus || null,
              rawEvents: merged,
              lastSyncAt: new Date(),
              lastSyncSource: WEBHOOK_SOURCE
            };
            fresh.markModified('shipmentInfo');
            await fresh.save();
          }
        } catch (eventErr) {
          logger.warn('[shipmozoWebhook] cancel event merge failed', {
            orderId: order.orderId,
            message: eventErr.message
          });
        }

        try {
          const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
          await evaluateAndPersistShipmentOps(
            (await Order.findOne({ orderId: order.orderId })) || resetOrder,
            { source: `${WEBHOOK_SOURCE}_cancel` }
          );
        } catch (_) {
          /* non-blocking */
        }

        return {
          success: true,
          cancelled: true,
          httpStatus: 200,
          code: 'SHIPMOZO_CANCEL_APPLIED',
          message: 'Shipmozo cancel processed — local AWB cleared for re-ship',
          orderId: order.orderId,
          matchedBy: found.matchedBy
        };
      }
    } catch (cancelErr) {
      logger.warn('[shipmozoWebhook] cancel reset failed; continuing with upsert', {
        orderId: order.orderId,
        message: cancelErr.message
      });
    }
  }

  try {
    const { applyUpsertShipmentInfo } = require('../controllers/order.controller');
    await applyUpsertShipmentInfo({
      order,
      shipmentPayload: {
        providerStatus,
        courier: parsed.courier || order.shipmentInfo?.courier,
        estimatedDelivery: parsed.estimatedDelivery || undefined,
        events: parsed.events,
        provider: SHIPPING_PROVIDERS.SHIPMOZO,
        awbCode: parsed.awbNumber || order.shipmentInfo?.awbCode || undefined,
        trackingNumber: parsed.awbNumber || order.shipmentInfo?.trackingNumber || undefined
      },
      trigger: WEBHOOK_SOURCE,
      allowOrderStatusUpdate: true
    });
  } catch (upsertErr) {
    logger.error('[shipmozoWebhook] upsert failed', {
      orderId: order.orderId,
      message: upsertErr.message,
      stack: upsertErr.stack
    });
    return {
      success: false,
      httpStatus: 500,
      code: 'SHIPMOZO_WEBHOOK_UPSERT_FAILED',
      message: upsertErr.message || 'Failed to apply Shipmozo webhook status'
    };
  }

  let fresh = await Order.findOne({ orderId: order.orderId });
  if (!fresh) {
    return {
      success: false,
      httpStatus: 500,
      code: 'ORDER_NOT_FOUND_AFTER_UPSERT',
      message: 'Order missing after webhook upsert'
    };
  }

  // RTO insights + default freight (same as reconcile; non-blocking)
  try {
    const ps = String(fresh.shipmentInfo?.providerStatus || '');
    const isRtoishNow =
      String(fresh.orderStatus || '').toLowerCase() === 'rto' || isRtoProviderStatus(ps);

    if (isRtoishNow) {
      const insightsChanged = persistRtoTrackingInsights(fresh);
      try {
        const { syncShipmozoRtoFreightDefault } = require('./shipmozoReconcile.service');
        await syncShipmozoRtoFreightDefault(fresh, { persist: false });
      } catch (_) {
        /* non-blocking */
      }
      if (insightsChanged || fresh.isModified?.('returnInfo') || fresh.isModified?.('shipmentInfo')) {
        if (typeof fresh.markModified === 'function') {
          fresh.markModified('returnInfo');
          fresh.markModified('shipmentInfo');
        }
        await fresh.save();
      }
    }
  } catch (rtoErr) {
    logger.warn('[shipmozoWebhook] RTO insights failed', {
      orderId: fresh.orderId,
      message: rtoErr.message
    });
  }

  try {
    const { evaluateAndPersistShipmentOps } = require('./shipmentOps');
    await evaluateAndPersistShipmentOps(fresh, { source: WEBHOOK_SOURCE });
    fresh = (await Order.findOne({ orderId: order.orderId })) || fresh;
  } catch (_) {
    /* non-blocking */
  }

  if (!previousRto && wasRtoish(fresh)) {
    try {
      const { notifyRtoInitiated } = require('./rtoNotification.service');
      await notifyRtoInitiated(fresh);
    } catch (notifyErr) {
      logger.warn('[shipmozoWebhook] RTO notify failed', {
        orderId: fresh.orderId,
        message: notifyErr.message
      });
    }
  }

  return {
    success: true,
    httpStatus: 200,
    code: null,
    message: 'Shipmozo webhook applied',
    orderId: fresh.orderId,
    matchedBy: found.matchedBy,
    previousProviderStatus,
    previousOrderStatus,
    currentProviderStatus: fresh.shipmentInfo?.providerStatus || null,
    currentOrderStatus: fresh.orderStatus || null
  };
}

/**
 * Extract webhook token from query or headers.
 * @param {import('express').Request} req
 */
function extractShipmozoWebhookToken(req) {
  const q = trimStr(req?.query?.token);
  if (q) return q;
  return trimStr(
    req?.headers?.['x-shipmozo-token'] || req?.headers?.['x-webhook-token'] || ''
  );
}

module.exports = {
  WEBHOOK_SOURCE,
  parseShipmozoWebhookPayload,
  mapStatusFeedToEvents,
  isShipmozoCancelStatus,
  findOrderForShipmozoWebhook,
  processShipmozoWebhook,
  extractShipmozoWebhookToken,
  wasRtoish
};

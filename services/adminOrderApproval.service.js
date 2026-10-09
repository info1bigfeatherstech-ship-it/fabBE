/**
 * Admin approval workflow: confirm pending orders for fulfilment, or cancel and restore stock.
 * Stock: reserve @ checkout; commit @ confirm (COD) or @ payment capture (online);
 * release @ admin cancel while still held.
 */

const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const Order = require('../models/Order');
const logger = require('../utils/logger');
const { releaseOrderStockHold, commitOrderStockHold } = require('./orderStockBridge.service');
const { evaluateOrderPaymentForShiprocketFulfillment } = require('../utils/orderFulfillmentPaymentGate');
const { ensureShipmentForOrderExport } = require('../controllers/order.controller');
const { mergeReturnInfo } = require('./rtoRefund.service');
const { mergeOrderScopeFilter } = require('../utils/adminOrderScope');
const { shippingProviderDisplayName } = require('../constants/shippingProviders');

const FULFILLMENT_ITEM_POPULATE = { path: 'items.productId', select: 'name slug shipping' };

const razorpay =
  String(process.env.RAZORPAY_KEY_ID || '').trim() && String(process.env.RAZORPAY_KEY_SECRET || '').trim()
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      })
    : null;

/**
 * @param {import('mongoose').Document} order
 */
function normalizeTerminalUnpaidFinancials(order) {
  const method = String(order.paymentInfo?.method || '').toLowerCase();
  if (method === 'online' && order.paymentStatus !== 'paid' && order.paymentStatus !== 'partially_paid') {
    order.balanceDueInr = 0;
    order.amountPaidInr = Number(order.amountPaidInr) || 0;
  }
}

/**
 * @param {import('mongoose').Document|object} order
 * @returns {number}
 */
function getCancelledOrderRefundAmount(order) {
  const paymentStatus = String(order?.paymentStatus || '').toLowerCase();
  if (paymentStatus === 'partially_paid') {
    return Math.max(0, Number(order?.amountPaidInr) || 0);
  }
  if (paymentStatus === 'paid') {
    return Math.max(0, Number(order?.totalAmount) || 0);
  }
  return 0;
}

/**
 * Normalize Razorpay / SDK error shapes into a single admin-readable string.
 * @param {unknown} err
 * @returns {string}
 */
function extractRazorpayErrorMessage(err) {
  try {
    const nested =
      err?.error?.description ||
      err?.error?.reason ||
      err?.error?.message ||
      err?.description ||
      err?.reason ||
      err?.message;
    const text = String(nested || '').trim();
    if (text) return text.slice(0, 500);
  } catch {
    /* ignore */
  }
  return 'Refund API failed';
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function looksLikeAlreadyRefundedError(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('already been refunded') ||
    m.includes('already refunded') ||
    m.includes('fully refunded') ||
    m.includes('refund has already been') ||
    (m.includes('amount') && m.includes('exceed') && m.includes('refund'))
  );
}

/**
 * Apply successful cancellation refund fields on the order document (caller saves).
 * @param {import('mongoose').Document} order
 * @param {{ refundId: string, refundAmountInr: number, totalRefundedPaise?: number }} args
 */
function applySuccessfulCancellationRefund(order, { refundId, refundAmountInr, totalRefundedPaise }) {
  const totalPaise = Math.round((Number(order.totalAmount) || 0) * 100);
  const refundedPaise =
    totalRefundedPaise != null
      ? Number(totalRefundedPaise) || 0
      : Math.round((Number(refundAmountInr) || 0) * 100);

  order.paymentStatus =
    totalPaise > 0 && refundedPaise >= totalPaise ? 'refunded' : 'partially_refunded';

  order.returnInfo = mergeReturnInfo(order.returnInfo, {
    refundContext: 'cancellation',
    refundAmount: Number(refundAmountInr) || 0,
    refundId: refundId || order.returnInfo?.refundId || null,
    status: 'refunded',
    approvedAt: new Date()
  });

  order.paymentInfo = {
    ...(order.paymentInfo || {}),
  };
  if (order.paymentInfo.refundFailureReason) {
    delete order.paymentInfo.refundFailureReason;
  }
  if (order.paymentInfo.refundRetryStartedAt) {
    delete order.paymentInfo.refundRetryStartedAt;
  }
  order.markModified('paymentInfo');
  order.markModified('returnInfo');
}

/**
 * @param {import('mongoose').Document} order
 * @param {{ reason?: string }} [opts]
 */
async function attemptRefundForCancelledPaidOrder(order, opts = {}) {
  const paymentStatus = String(order.paymentStatus || '').toLowerCase();
  const wasPaid = paymentStatus === 'paid' || paymentStatus === 'partially_paid';
  const paymentId = order.paymentInfo?.razorpayPaymentId;
  if (!wasPaid || !paymentId || !razorpay) {
    return { refundAttempted: false, refundWarning: null, refundAmountInr: 0 };
  }

  const refundAmountInr = getCancelledOrderRefundAmount(order);
  const refundPaise = Math.round(refundAmountInr * 100);
  if (refundPaise < 1) {
    return { refundAttempted: false, refundWarning: null, refundAmountInr: 0 };
  }

  try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount: refundPaise,
      notes: {
        orderId: order.orderId,
        reason: opts.reason || 'Order cancelled by admin'
      }
    });

    applySuccessfulCancellationRefund(order, {
      refundId: refund?.id,
      refundAmountInr,
      totalRefundedPaise: refundPaise
    });
    await order.save();
    return { refundAttempted: true, refundWarning: null, refundAmountInr };
  } catch (refundError) {
    const failureReason = extractRazorpayErrorMessage(refundError);
    order.returnInfo = mergeReturnInfo(order.returnInfo, {
      refundContext: 'cancellation',
      status: 'refund_failed',
      refundAmount: refundAmountInr,
    });
    order.paymentInfo = {
      ...(order.paymentInfo || {}),
      refundFailureReason: failureReason,
    };
    order.markModified('paymentInfo');
    await order.save();
    logger.error('[adminOrderApproval] refund failed after admin cancel', {
      orderId: order.orderId,
      message: failureReason,
    });
    return {
      refundAttempted: true,
      refundWarning: 'Order cancelled, but refund failed. Support team action required.',
      refundFailureReason: failureReason,
      refundAmountInr,
    };
  }
}

/**
 * Admin retry for a cancellation refund that previously failed at Razorpay.
 * Idempotent: syncs DB if gateway already refunded; claims refund_failed → refund_pending
 * to reduce double-click races.
 *
 * @param {string} orderId
 * @param {{ scopeMatch?: object|null, reason?: string }} [opts]
 */
async function runAdminRetryCancellationRefund(orderId, opts = {}) {
  const id = String(orderId || '').trim();
  if (!id) {
    return {
      orderId: orderId || '',
      success: false,
      code: 'ORDER_ID_REQUIRED',
      message: 'orderId is required'
    };
  }

  if (!razorpay) {
    return {
      orderId: id,
      success: false,
      code: 'RAZORPAY_NOT_CONFIGURED',
      message: 'Razorpay is not configured on this server.'
    };
  }

  try {
    const filter = mergeOrderScopeFilter({ orderId: id }, opts.scopeMatch || null);
    const order = await Order.findOne(filter);
    if (!order) {
      return { orderId: id, success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
    }

    const orderStatus = String(order.orderStatus || '').toLowerCase();
    if (orderStatus !== 'cancelled') {
      return {
        orderId: id,
        success: false,
        code: 'ORDER_NOT_CANCELLED',
        message: 'Retry refund is only allowed for cancelled orders.'
      };
    }

    const payStatus = String(order.paymentStatus || '').toLowerCase();
    if (payStatus === 'refunded') {
      return {
        orderId: id,
        success: true,
        skipped: true,
        code: 'ALREADY_REFUNDED',
        message: 'Order is already marked refunded.'
      };
    }

    const riStatus = String(order.returnInfo?.status || '').toLowerCase();
    const refundContext = String(order.returnInfo?.refundContext || '').toLowerCase();
    const hasFailureReason = Boolean(String(order.paymentInfo?.refundFailureReason || '').trim());
    const eligibleStatus =
      riStatus === 'refund_failed' ||
      (riStatus === 'refund_pending' && hasFailureReason) ||
      (hasFailureReason && ['paid', 'partially_paid', 'partially_refunded'].includes(payStatus));

    if (!eligibleStatus) {
      return {
        orderId: id,
        success: false,
        code: 'REFUND_RETRY_NOT_ELIGIBLE',
        message: 'No failed cancellation refund to retry on this order.'
      };
    }

    if (refundContext && refundContext !== 'cancellation') {
      return {
        orderId: id,
        success: false,
        code: 'REFUND_CONTEXT_NOT_CANCELLATION',
        message: 'This refund belongs to another flow (not cancellation). Use the matching refund tool.'
      };
    }

    const paymentId = String(order.paymentInfo?.razorpayPaymentId || '').trim();
    if (!paymentId) {
      return {
        orderId: id,
        success: false,
        code: 'RAZORPAY_PAYMENT_MISSING',
        message: 'Missing Razorpay payment id — cannot retry refund.'
      };
    }

    // Claim the retry slot to reduce concurrent admin double-clicks.
    if (riStatus === 'refund_failed') {
      const startedAt = order.paymentInfo?.refundRetryStartedAt
        ? new Date(order.paymentInfo.refundRetryStartedAt).getTime()
        : 0;
      if (startedAt && Date.now() - startedAt < 45_000) {
        return {
          orderId: id,
          success: false,
          code: 'REFUND_RETRY_IN_PROGRESS',
          message: 'A refund retry is already in progress. Wait a moment and refresh.'
        };
      }
      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundContext: 'cancellation',
        status: 'refund_pending'
      });
      order.paymentInfo = {
        ...(order.paymentInfo || {}),
        refundRetryStartedAt: new Date()
      };
      order.markModified('paymentInfo');
      order.markModified('returnInfo');
      await order.save();
    }

    let gatewayPayment = null;
    try {
      gatewayPayment = await razorpay.payments.fetch(paymentId);
    } catch (fetchErr) {
      const failureReason = extractRazorpayErrorMessage(fetchErr);
      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundContext: 'cancellation',
        status: 'refund_failed'
      });
      order.paymentInfo = {
        ...(order.paymentInfo || {}),
        refundFailureReason: failureReason
      };
      if (order.paymentInfo.refundRetryStartedAt) {
        delete order.paymentInfo.refundRetryStartedAt;
      }
      order.markModified('paymentInfo');
      await order.save();
      logger.error('[adminOrderApproval] refund retry: payment fetch failed', {
        orderId: id,
        message: failureReason
      });
      return {
        orderId: id,
        success: false,
        code: 'RAZORPAY_PAYMENT_FETCH_FAILED',
        message: failureReason,
        refundFailureReason: failureReason
      };
    }

    const paymentAmountPaise = Math.max(0, Number(gatewayPayment?.amount) || 0);
    const alreadyRefundedPaise = Math.max(0, Number(gatewayPayment?.amount_refunded) || 0);
    // Prefer amount stored at cancel time; else derive from paid / bill total.
    const storedRefundInr = Number(order.returnInfo?.refundAmount) || 0;
    const targetRefundInr =
      storedRefundInr > 0
        ? storedRefundInr
        : payStatus === 'partially_paid'
          ? Math.max(0, Number(order.amountPaidInr) || 0)
          : Math.max(0, Number(order.totalAmount) || 0);
    const targetPaise = Math.round(targetRefundInr * 100);
    const remainingPaise = Math.max(0, paymentAmountPaise - alreadyRefundedPaise);

    // Gateway already covered the target — sync local state (idempotent success).
    if (targetPaise > 0 && alreadyRefundedPaise >= targetPaise) {
      const latestRefundId = order.returnInfo?.refundId || null;
      applySuccessfulCancellationRefund(order, {
        refundId: latestRefundId,
        refundAmountInr: targetRefundInr,
        totalRefundedPaise: alreadyRefundedPaise
      });
      await order.save();
      return {
        orderId: id,
        success: true,
        synced: true,
        code: null,
        message: `Refund already completed at Razorpay. Order synced — ₹${targetRefundInr.toFixed(2)}.`,
        refundAmountInr: targetRefundInr,
        refundId: latestRefundId
      };
    }

    const refundPaise = Math.min(
      targetPaise > alreadyRefundedPaise ? targetPaise - alreadyRefundedPaise : remainingPaise,
      remainingPaise
    );
    if (refundPaise < 1) {
      applySuccessfulCancellationRefund(order, {
        refundId: order.returnInfo?.refundId,
        refundAmountInr: targetRefundInr || alreadyRefundedPaise / 100,
        totalRefundedPaise: alreadyRefundedPaise
      });
      await order.save();
      return {
        orderId: id,
        success: true,
        synced: true,
        code: null,
        message: 'No remaining refundable amount at Razorpay. Order marked refunded.',
        refundAmountInr: alreadyRefundedPaise / 100
      };
    }

    const refundAmountInr = refundPaise / 100;

    try {
      const refund = await razorpay.payments.refund(paymentId, {
        amount: refundPaise,
        notes: {
          orderId: id,
          reason: opts.reason || 'Admin retry — cancellation refund',
          retry: '1'
        }
      });

      applySuccessfulCancellationRefund(order, {
        refundId: refund?.id,
        refundAmountInr: (alreadyRefundedPaise + refundPaise) / 100,
        totalRefundedPaise: alreadyRefundedPaise + refundPaise
      });
      await order.save();

      return {
        orderId: id,
        success: true,
        code: null,
        message: `Refund of ₹${refundAmountInr.toFixed(2)} initiated (5–7 working days to reflect).`,
        refundAmountInr,
        refundId: refund?.id || null
      };
    } catch (refundError) {
      const failureReason = extractRazorpayErrorMessage(refundError);

      if (looksLikeAlreadyRefundedError(failureReason)) {
        try {
          const again = await razorpay.payments.fetch(paymentId);
          const refundedPaise = Math.max(0, Number(again?.amount_refunded) || 0);
          applySuccessfulCancellationRefund(order, {
            refundId: order.returnInfo?.refundId,
            refundAmountInr: refundedPaise / 100,
            totalRefundedPaise: refundedPaise
          });
          await order.save();
          return {
            orderId: id,
            success: true,
            synced: true,
            code: null,
            message: 'Razorpay reports payment already refunded. Order synced.',
            refundAmountInr: refundedPaise / 100
          };
        } catch {
          /* fall through to failure path */
        }
      }

      order.returnInfo = mergeReturnInfo(order.returnInfo, {
        refundContext: 'cancellation',
        status: 'refund_failed',
        refundAmount: targetRefundInr || refundAmountInr
      });
      order.paymentInfo = {
        ...(order.paymentInfo || {}),
        refundFailureReason: failureReason
      };
      if (order.paymentInfo.refundRetryStartedAt) {
        delete order.paymentInfo.refundRetryStartedAt;
      }
      order.markModified('paymentInfo');
      await order.save();

      logger.error('[adminOrderApproval] refund retry failed', {
        orderId: id,
        message: failureReason
      });

      return {
        orderId: id,
        success: false,
        code: 'REFUND_RETRY_FAILED',
        message: failureReason,
        refundFailureReason: failureReason,
        refundAmountInr: targetRefundInr || refundAmountInr
      };
    }
  } catch (err) {
    logger.error('[adminOrderApproval] runAdminRetryCancellationRefund', {
      orderId: id,
      message: err?.message,
      stack: err?.stack
    });
    return {
      orderId: id,
      success: false,
      code: 'REFUND_RETRY_INTERNAL_ERROR',
      message: err?.message || 'Refund retry failed'
    };
  }
}

/**
 * Confirm a pending order for fulfilment: status → confirmed, then create Shiprocket forward order (no second stock deduct).
 * @param {string} orderId
 * @returns {Promise<object>}
 */
async function runAdminApproveOrderSingle(orderId, opts = {}) {
  const id = String(orderId || '').trim();
  if (!id) {
    return { orderId: orderId || '', success: false, skipped: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
  }

  try {
    const filter = mergeOrderScopeFilter({ orderId: id }, opts.scopeMatch || null);
    const order = await Order.findOne(filter).populate(FULFILLMENT_ITEM_POPULATE);
    if (!order) {
      return { orderId: id, success: false, skipped: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
    }

    const status = String(order.orderStatus || '').toLowerCase();
    if (status === 'confirmed') {
      return {
        orderId: id,
        success: true,
        skipped: true,
        code: 'ALREADY_CONFIRMED',
        message: 'Order is already confirmed.',
        orderStatus: order.orderStatus
      };
    }
    if (status !== 'pending') {
      return {
        orderId: id,
        success: false,
        skipped: false,
        code: 'ORDER_STATUS_NOT_ELIGIBLE',
        message: `Only pending orders can be confirmed (current: ${order.orderStatus || 'unknown'}).`
      };
    }

    const gate = evaluateOrderPaymentForShiprocketFulfillment(order);
    if (!gate.ok) {
      return {
        orderId: id,
        success: false,
        skipped: false,
        code: gate.code || 'PAYMENT_REQUIRED',
        message: gate.message || 'Payment requirements not met for confirmation.'
      };
    }

    // Free-gift gate: if this order received a free-gift offer, admin must have recorded a gift label first.
    const hasGiftOffer = Boolean(
      order.appliedFreeGiftOffer?.offerId || order.appliedFreeGiftOffer?.name
    );
    if (hasGiftOffer) {
      const giftLabel = String(order.appliedFreeGiftOffer?.adminGiftLabel || '').trim();
      if (!giftLabel) {
        return {
          orderId: id,
          success: false,
          skipped: false,
          code: 'GIFT_LABEL_REQUIRED',
          message: 'This order includes a free gift. Please record the gift name/number before confirming.'
        };
      }
    }

    order.orderStatus = 'confirmed';
    order.paymentInfo = order.paymentInfo || {};
    order.paymentInfo.adminConfirmedAt = new Date();
    order.markModified('paymentInfo');

    // COD (and any still-held) stock: convert inventory hold → sold on admin confirm.
    try {
      const commitRes = await commitOrderStockHold(order);
      if (!commitRes.ok && !commitRes.skipped) {
        logger.error('[adminOrderApproval] inventory commit failed on confirm', {
          orderId: order.orderId,
          result: commitRes
        });
      }
    } catch (commitErr) {
      logger.error('[adminOrderApproval] inventory commit threw on confirm', {
        orderId: order.orderId,
        message: commitErr?.message || String(commitErr)
      });
    }

    await order.save();

    const shipmentResult = await ensureShipmentForOrderExport({
      order,
      trigger: 'admin_order_confirmed'
    });

    const fresh = await Order.findOne({ orderId: id }).populate(FULFILLMENT_ITEM_POPULATE);
    const partnerName = shippingProviderDisplayName(fresh || order);

    if (!shipmentResult.success) {
      return {
        orderId: id,
        success: true,
        skipped: false,
        code: 'CONFIRMED_SHIPMENT_DEFERRED',
        message: `Order confirmed. ${partnerName} create did not complete — retry Ship now or ensure shipment from order detail.`,
        orderStatus: fresh?.orderStatus || 'confirmed',
        shipment: {
          success: false,
          code: shipmentResult.code || null,
          message: shipmentResult.message || null
        }
      };
    }

    return {
      orderId: id,
      success: true,
      skipped: false,
      code: null,
      message: shipmentResult.alreadyExists
        ? `Order confirmed. ${partnerName} order already exists.`
        : `Order confirmed and ${partnerName} order created.`,
      orderStatus: fresh?.orderStatus || 'confirmed',
      shipment: { success: true, alreadyExists: Boolean(shipmentResult.alreadyExists) }
    };
  } catch (err) {
    logger.error('runAdminApproveOrderSingle', { orderId: id, message: err?.message, stack: err?.stack });
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: 'CONFIRM_INTERNAL_ERROR',
      message: err?.message || 'Confirm failed'
    };
  }
}

/**
 * Cancel a pending order: status → cancelled, restore reserved inventory, refund when applicable.
 * @param {string} orderId
 * @returns {Promise<object>}
 */
async function runAdminCancelOrderSingle(orderId, opts = {}) {
  const id = String(orderId || '').trim();
  if (!id) {
    return { orderId: orderId || '', success: false, skipped: false, code: 'ORDER_ID_REQUIRED', message: 'orderId is required' };
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const filter = mergeOrderScopeFilter({ orderId: id }, opts.scopeMatch || null);
    const order = await Order.findOne(filter).session(session).populate(FULFILLMENT_ITEM_POPULATE);
    if (!order) {
      await session.abortTransaction();
      session.endSession();
      return { orderId: id, success: false, skipped: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
    }

    const status = String(order.orderStatus || '').toLowerCase();
    if (status === 'cancelled') {
      await session.abortTransaction();
      session.endSession();
      return {
        orderId: id,
        success: true,
        skipped: true,
        code: 'ALREADY_CANCELLED',
        message: 'Order is already cancelled.'
      };
    }
    if (status !== 'pending') {
      await session.abortTransaction();
      session.endSession();
      return {
        orderId: id,
        success: false,
        skipped: false,
        code: 'ORDER_STATUS_NOT_ELIGIBLE',
        message: `Only pending orders can be cancelled from this action (current: ${order.orderStatus || 'unknown'}).`
      };
    }

    const hasShiprocketAwb = Boolean(order.shipmentInfo?.awbCode || order.shipmentInfo?.trackingNumber);
    const hasScheduledPickup = Boolean(order.shipmentInfo?.pickupScheduledAt || order.shipmentInfo?.pickupDate);
    if (hasShiprocketAwb || hasScheduledPickup) {
      await session.abortTransaction();
      session.endSession();
      return {
        orderId: id,
        success: false,
        skipped: false,
        code: 'ORDER_CANCELLATION_NOT_ALLOWED',
        message: 'Cannot cancel after AWB is assigned or pickup is scheduled.'
      };
    }

    const paymentStatus = String(order.paymentStatus || '').toLowerCase();
    const wasFullyPaid = paymentStatus === 'paid';
    const wasPartiallyPaid = paymentStatus === 'partially_paid';
    const hadCapturedPayment = wasFullyPaid || wasPartiallyPaid;
    const canInitiateRefund =
      hadCapturedPayment &&
      Boolean(order.paymentInfo?.razorpayPaymentId);
    const refundAmountInr = canInitiateRefund ? getCancelledOrderRefundAmount(order) : 0;

    order.orderStatus = 'cancelled';
    if (!hadCapturedPayment && String(order.paymentInfo?.method || '').toLowerCase() === 'online') {
      order.paymentStatus = 'failed';
    }
    normalizeTerminalUnpaidFinancials(order);
    order.paymentInfo = order.paymentInfo || {};
    order.paymentInfo.cancellationReason = 'admin_cancelled';
    order.paymentInfo.cancelledAt = new Date();
    order.returnInfo = mergeReturnInfo(order.returnInfo, {
      refundContext: 'cancellation',
      status: canInitiateRefund ? 'refund_pending' : hadCapturedPayment ? 'refund_unavailable' : 'not_required',
      requestedAt: new Date(),
      refundAmount: canInitiateRefund ? refundAmountInr : order.returnInfo?.refundAmount || 0
    });
    order.markModified('paymentInfo');
    order.markModified('returnInfo');

    await order.save({ session });
    // Paid/partial cancel must restock even if payment was already committed; refund is separate.
    const releaseOutcome = await releaseOrderStockHold(order, session, {
      restoreCommittedOnCancel: true,
    });
    await order.save({ session });

    await session.commitTransaction();
    session.endSession();

    const stockReleased = Boolean(releaseOutcome?.ok && !releaseOutcome?.skipped);
    const stockSkippedReason = String(releaseOutcome?.reason || '');

    let refundWarning = null;
    let refundFailureReason = null;
    let refundAmountDone = 0;
    let refundAttempted = false;
    if (canInitiateRefund) {
      const refundOutcome = await attemptRefundForCancelledPaidOrder(order, { reason: 'Order cancelled by admin' });
      refundWarning = refundOutcome.refundWarning;
      refundFailureReason = refundOutcome.refundFailureReason || null;
      refundAttempted = Boolean(refundOutcome.refundAttempted);
      refundAmountDone = Number(refundOutcome.refundAmountInr) || refundAmountInr || 0;
    }

    const stockBit = stockReleased
      ? 'Stock restocked.'
      : stockSkippedReason
        ? `Stock note: ${stockSkippedReason}.`
        : '';
    let message = `Order cancelled. ${stockBit}`.trim();
    if (refundWarning) {
      message = `Order cancelled. ${stockBit} Refund failed — see reason below.`
        .replace(/\s+/g, ' ')
        .trim();
    } else if (refundAttempted && refundAmountDone > 0) {
      message = `Order cancelled. ${stockBit} Refund of ₹${refundAmountDone.toFixed(2)} initiated (5–7 working days to reflect).`
        .replace(/\s+/g, ' ')
        .trim();
    }

    return {
      orderId: id,
      success: true,
      skipped: false,
      code: null,
      message,
      refundWarning: refundWarning || undefined,
      refundFailureReason: refundFailureReason || undefined,
      refundAmountInr: refundAttempted ? refundAmountDone : undefined,
      stockReleased: stockReleased || undefined,
    };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    logger.error('runAdminCancelOrderSingle', { orderId: id, message: err?.message, stack: err?.stack });
    return {
      orderId: id,
      success: false,
      skipped: false,
      code: 'CANCEL_INTERNAL_ERROR',
      message: err?.message || 'Cancel failed'
    };
  }
}

module.exports = {
  runAdminApproveOrderSingle,
  runAdminCancelOrderSingle,
  runAdminRetryCancellationRefund,
  getCancelledOrderRefundAmount,
  extractRazorpayErrorMessage
};

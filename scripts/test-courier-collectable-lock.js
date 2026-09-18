/**
 * Unit checks for courier collectable lock (no DB required).
 * Run: node scripts/test-courier-collectable-lock.js
 */
const assert = require('assert');
const {
  computeLiveCourierCollectable,
  hasCourierCollectableLock,
  getCustomerFacingCollectableInr,
  getCustomerFacingDeliveryInr,
  getCustomerFacingOrderTotalInr,
  buildCourierLockShipmentPayloadFields,
  mergeCourierCollectableLockIntoShipmentInfo,
  getCustomerFacingCollectableLabel
} = require('../services/courierCollectableLock.service');

function makePartialCodOrder({ total = 1000, paid = 300, delivery = 80, balanceDue = 700 } = {}) {
  return {
    totalAmount: total,
    amountPaidInr: paid,
    balanceDueInr: balanceDue,
    deliveryCharges: delivery,
    paymentInfo: {
      method: 'online',
      splitMode: 'advance',
      balanceCollectionMethod: 'cod'
    },
    shipmentInfo: {}
  };
}

function run() {
  // Live collectable for partial COD
  const order = makePartialCodOrder();
  const live = computeLiveCourierCollectable(order);
  assert.strictEqual(live.collectable, 700);
  assert.strictEqual(live.paymentMode, 'COD');
  assert.strictEqual(hasCourierCollectableLock(order), false);

  // Lock at push
  const lockFields = buildCourierLockShipmentPayloadFields(order, { source: 'shipmozo_push' });
  assert.strictEqual(lockFields.courierCollectableInr, 700);
  assert.strictEqual(lockFields.courierDeliveryInr, 80);
  assert.strictEqual(lockFields.courierFacingTotalInr, 1000);
  assert.ok(lockFields.codLockedAt);
  assert.strictEqual(lockFields.codLockSource, 'shipmozo_push');

  order.shipmentInfo = { ...order.shipmentInfo, ...lockFields };
  assert.strictEqual(hasCourierCollectableLock(order), true);
  assert.strictEqual(getCustomerFacingCollectableInr(order), 700);
  assert.strictEqual(getCustomerFacingCollectableLabel(order), 'Pay to courier');

  // Ship Now / OOS: live due drops, customer still sees frozen COD
  order.deliveryCharges = 40;
  order.totalAmount = 960;
  order.balanceDueInr = 660;
  assert.strictEqual(getCustomerFacingCollectableInr(order), 700, 'locked COD must not follow live due');
  assert.strictEqual(getCustomerFacingDeliveryInr(order), 80, 'frozen delivery');
  assert.strictEqual(getCustomerFacingOrderTotalInr(order), 1000, 'frozen total');
  assert.strictEqual(computeLiveCourierCollectable(order).collectable, 660, 'live still reflects settlement');

  // Upsert must preserve lock (payload tries to wipe)
  const nextSi = {
    ...order.shipmentInfo,
    awbCode: 'AWB123',
    courierCollectableInr: null,
    courierDeliveryInr: null,
    courierFacingTotalInr: null,
    codLockedAt: null,
    codLockSource: null
  };
  mergeCourierCollectableLockIntoShipmentInfo({
    prevSi: order.shipmentInfo,
    nextShipmentInfo: nextSi,
    shipmentPayload: { awbCode: 'AWB123', courierCollectableInr: null }
  });
  assert.strictEqual(nextSi.courierCollectableInr, 700);
  assert.strictEqual(nextSi.courierDeliveryInr, 80);
  assert.strictEqual(nextSi.courierFacingTotalInr, 1000);
  assert.ok(nextSi.codLockedAt);

  // Prepaid → lock 0 OK
  const prepaid = {
    totalAmount: 500,
    amountPaidInr: 500,
    balanceDueInr: 0,
    deliveryCharges: 50,
    paymentInfo: { method: 'online', balanceCollectionMethod: 'online' },
    shipmentInfo: {}
  };
  const prepaidLock = buildCourierLockShipmentPayloadFields(prepaid, { source: 'shiprocket_push' });
  assert.strictEqual(prepaidLock.courierCollectableInr, 0);
  prepaid.shipmentInfo = { ...prepaidLock };
  assert.strictEqual(hasCourierCollectableLock(prepaid), true);
  assert.strictEqual(getCustomerFacingCollectableInr(prepaid), 0);
  assert.strictEqual(getCustomerFacingCollectableLabel(prepaid), null);

  // Unlock/null → live due again
  const unlocked = makePartialCodOrder({ balanceDue: 200 });
  assert.strictEqual(getCustomerFacingCollectableInr(unlocked), 200);
  assert.strictEqual(getCustomerFacingCollectableLabel(unlocked), 'Balance due');

  console.log('OK: courier collectable lock tests passed');
}

try {
  run();
} catch (err) {
  console.error('FAIL:', err?.message || err);
  process.exit(1);
}

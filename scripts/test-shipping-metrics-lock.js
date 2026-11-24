/**
 * Unit tests: package rebuild from line overrides + customer delivery lock helpers.
 * Run: node scripts/test-shipping-metrics-lock.js
 */
const assert = require('assert');
const {
  aggregateShippingFromWeightLines,
  applyLineShippingOverridesToSnapshot,
  rebuildShippingWeightSnapshotFromLines,
  dimWeightKgFromDimsCm,
  validateLineShippingOverride
} = require('../utils/shippingWeightSnapshot');
const {
  getCheckoutDeliveryCharges,
  ensureCheckoutDeliveryFrozen,
  applyAdminQuotedDelivery,
  syncCustomerDeliveryChargesToLock
} = require('../utils/customerDeliveryLock');
const {
  getCustomerFacingDeliveryInr
} = require('../services/courierCollectableLock.service');

function testAggregateAndVol() {
  const lines = [
    { quantity: 2, unitWeightKg: 0.5, lengthCm: 20, widthCm: 10, heightCm: 5 },
    { quantity: 1, unitWeightKg: 1.2, lengthCm: 30, widthCm: 15, heightCm: 8 }
  ];
  const agg = aggregateShippingFromWeightLines(lines);
  assert.strictEqual(agg.weightKg, 2.2);
  assert.strictEqual(agg.lengthCm, 30);
  assert.strictEqual(agg.widthCm, 15);
  assert.strictEqual(agg.heightCm, 18); // 5*2 + 8
  const vol = dimWeightKgFromDimsCm(agg);
  assert.ok(vol != null && vol > 0);
  console.log('ok aggregate + vol', agg, vol);
}

function testIdNormalizeMatch() {
  const { idStr, lineKey } = require('../utils/shippingWeightSnapshot');
  const oid = { _id: '6acf400f91d73da5944505b6' };
  assert.strictEqual(idStr(oid), '6acf400f91d73da5944505b6');
  assert.strictEqual(
    lineKey(oid, { _id: '6acf400f91d73da5944505b7' }),
    '6acf400f91d73da5944505b6:6acf400f91d73da5944505b7'
  );
  const snap = {
    lines: [
      {
        productId: { _id: '6acf400f91d73da5944505b6' },
        variantId: { toString: () => '6acf400f91d73da5944505b7' },
        quantity: 1,
        unitWeightKg: 1,
        lengthCm: 1,
        widthCm: 1,
        heightCm: 1
      }
    ]
  };
  const applied = applyLineShippingOverridesToSnapshot(
    snap,
    [
      {
        productId: '6acf400f91d73da5944505b6',
        variantId: '6acf400f91d73da5944505b7',
        unitWeightKg: 2,
        lengthCm: 5,
        widthCm: 6,
        heightCm: 1
      }
    ],
    {}
  );
  assert.strictEqual(applied.ok, true, applied.message);
  assert.strictEqual(applied.snapshot.lines[0].unitWeightKg, 2);
  assert.strictEqual(applied.snapshot.totalWeightKg, 2);
  console.log('ok id normalize match');
}

function testOverrideRebuildsPackage() {
  const snap = {
    source: 'checkout',
    totalWeightKg: 1,
    dims: { lengthCm: 10, widthCm: 10, heightCm: 10 },
    lines: [
      {
        productId: 'p1',
        variantId: 'v1',
        productName: 'A',
        quantity: 2,
        unitWeightKg: 0.4,
        lengthCm: 10,
        widthCm: 10,
        heightCm: 5
      },
      {
        productId: 'p2',
        variantId: 'v2',
        productName: 'B',
        quantity: 1,
        unitWeightKg: 0.3,
        lengthCm: 12,
        widthCm: 8,
        heightCm: 4
      }
    ]
  };
  const applied = applyLineShippingOverridesToSnapshot(
    snap,
    [
      {
        productId: 'p1',
        variantId: 'v1',
        unitWeightKg: 0.9,
        lengthCm: 25,
        widthCm: 20,
        heightCm: 6
      }
    ],
    { adminUserId: null }
  );
  assert.strictEqual(applied.ok, true);
  const next = applied.snapshot;
  assert.strictEqual(next.source, 'admin_override');
  assert.strictEqual(next.lines[0].overridden, true);
  assert.strictEqual(next.lines[0].unitWeightKg, 0.9);
  assert.strictEqual(next.lines[0].lineWeightKg, 1.8);
  assert.strictEqual(next.lines[1].overridden, false);
  // Package: weight 0.9*2 + 0.3 = 2.1; L=max(25,12)=25; W=max(20,8)=20; H=6*2+4=16
  assert.strictEqual(next.totalWeightKg, 2.1);
  assert.strictEqual(next.dims.lengthCm, 25);
  assert.strictEqual(next.dims.widthCm, 20);
  assert.strictEqual(next.dims.heightCm, 16);
  assert.ok(next.totalDimWeightKg != null);
  console.log('ok override rebuild', next.totalWeightKg, next.dims, next.totalDimWeightKg);
}

function testValidation() {
  const bad = validateLineShippingOverride({
    productId: 'p',
    variantId: 'v',
    unitWeightKg: 0,
    lengthCm: 0,
    widthCm: 10,
    heightCm: 10
  });
  assert.strictEqual(bad.ok, false);
  const good = validateLineShippingOverride({
    productId: 'p',
    variantId: 'v',
    unitWeightKg: 0.5,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10
  });
  assert.strictEqual(good.ok, true);
  console.log('ok validation');
}

function testCustomerLock() {
  const order = {
    deliveryCharges: 80,
    checkoutDeliveryCharges: 80,
    adminQuotedDeliveryInr: null
  };
  assert.strictEqual(getCheckoutDeliveryCharges(order), 80);
  applyAdminQuotedDelivery(order, 120);
  assert.strictEqual(order.adminQuotedDeliveryInr, 120);
  assert.strictEqual(order.adminShippingDeltaInr, 40);
  syncCustomerDeliveryChargesToLock(order);
  assert.strictEqual(order.deliveryCharges, 80);
  assert.strictEqual(getCustomerFacingDeliveryInr(order), 80);

  const legacy = { deliveryCharges: 55 };
  ensureCheckoutDeliveryFrozen(legacy);
  assert.strictEqual(legacy.checkoutDeliveryCharges, 55);
  applyAdminQuotedDelivery(legacy, 40);
  syncCustomerDeliveryChargesToLock(legacy);
  assert.strictEqual(legacy.deliveryCharges, 55);
  assert.strictEqual(getCustomerFacingDeliveryInr(legacy), 55);
  console.log('ok customer lock');
}

function testRebuildPreservesFlags() {
  const rebuilt = rebuildShippingWeightSnapshotFromLines(
    [
      {
        productId: 'p1',
        variantId: 'v1',
        quantity: 1,
        unitWeightKg: 1,
        lengthCm: 10,
        widthCm: 10,
        heightCm: 10,
        overridden: true
      }
    ],
    { source: 'admin_override' }
  );
  assert.strictEqual(rebuilt.source, 'admin_override');
  assert.strictEqual(rebuilt.lines[0].overridden, true);
  console.log('ok rebuild flags');
}

try {
  testAggregateAndVol();
  testIdNormalizeMatch();
  testOverrideRebuildsPackage();
  testValidation();
  testCustomerLock();
  testRebuildPreservesFlags();
  console.log('\nAll shipping-metrics-lock tests passed.');
  process.exit(0);
} catch (err) {
  console.error('\nFAILED', err);
  process.exit(1);
}

/**
 * Unit tests — per-user coupon limit helpers (no DB).
 * Run: node scripts/test-coupon-per-user-limit.js
 */
const assert = require('assert');
const {
  normalizeCouponCode,
  resolvePerUserLimit,
  shouldReleaseCouponSlotForStatus,
  perUserLimitError
} = require('../services/couponUsage.service');

function testNormalize() {
  assert.strictEqual(normalizeCouponCode(' wel50 '), 'WEL50');
  assert.strictEqual(normalizeCouponCode(''), '');
  assert.strictEqual(normalizeCouponCode(null), '');
}

function testResolveLimit() {
  assert.strictEqual(resolvePerUserLimit({ perUserLimit: 1 }), 1);
  assert.strictEqual(resolvePerUserLimit({ perUserLimit: '3' }), 3);
  assert.strictEqual(resolvePerUserLimit({}), 1); // schema default
  assert.strictEqual(resolvePerUserLimit({ perUserLimit: null }), 1);
  assert.strictEqual(resolvePerUserLimit({ perUserLimit: 0 }), null); // unlimited escape
  assert.strictEqual(resolvePerUserLimit({ perUserLimit: -1 }), null);
  assert.strictEqual(resolvePerUserLimit(null), null);
}

function testReleaseStatuses() {
  assert.strictEqual(shouldReleaseCouponSlotForStatus('cancelled'), true);
  assert.strictEqual(shouldReleaseCouponSlotForStatus('payment_failed'), true);
  assert.strictEqual(shouldReleaseCouponSlotForStatus('CANCELLED'), true);
  assert.strictEqual(shouldReleaseCouponSlotForStatus('pending'), false);
  assert.strictEqual(shouldReleaseCouponSlotForStatus('delivered'), false);
}

function testErrorShape() {
  const err = perUserLimitError(1, 1, 'WEL50');
  assert.strictEqual(err.code, 'COUPON_PER_USER_LIMIT');
  assert.strictEqual(err.statusCode, 409);
  assert.strictEqual(err.details.limit, 1);
  assert.strictEqual(err.details.couponCode, 'WEL50');
  assert.ok(/already used/i.test(err.message));

  const errMulti = perUserLimitError(2, 2, 'TAM10');
  assert.ok(/2 times/.test(errMulti.message));
}

function run() {
  testNormalize();
  testResolveLimit();
  testReleaseStatuses();
  testErrorShape();
  console.log('All coupon per-user limit tests passed.');
}

run();

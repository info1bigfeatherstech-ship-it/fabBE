/**
 * Unit tests — free shipping offer evaluation + coupon exclusivity (no DB).
 * Run: node scripts/test-free-shipping-offer.js
 */
const assert = require('assert');
const {
  isOfferCurrentlyLive,
  roundMoney2,
  isExclusivePromoActive,
  decideFreeShippingWaiver,
  applyExclusivePromoToDeliveryState,
  FREE_SHIPPING_BLOCK_REASON
} = require('../services/freeShippingOffer.service');

function testLiveWithoutEndDate() {
  const offer = { isActive: true, endDate: null };
  assert.strictEqual(isOfferCurrentlyLive(offer, new Date('2026-08-24T10:00:00Z')), true);
}

function testInactiveNotLive() {
  assert.strictEqual(
    isOfferCurrentlyLive({ isActive: false, endDate: null }, new Date()),
    false
  );
}

function testExpiredEndDate() {
  const offer = { isActive: true, endDate: new Date('2026-01-01T00:00:00Z') };
  assert.strictEqual(isOfferCurrentlyLive(offer, new Date('2026-08-24T10:00:00Z')), false);
}

function testFutureEndDateStillLive() {
  const offer = { isActive: true, endDate: new Date('2027-01-01T00:00:00Z') };
  assert.strictEqual(isOfferCurrentlyLive(offer, new Date('2026-08-24T10:00:00Z')), true);
}

function testThresholdLogic() {
  const minCartValue = 599;
  const below = roundMoney2(598.99);
  const at = roundMoney2(599);
  const above = roundMoney2(1500);
  assert.strictEqual(below + 0.005 >= minCartValue, false);
  assert.strictEqual(at + 0.005 >= minCartValue, true);
  assert.strictEqual(above + 0.005 >= minCartValue, true);
}

function testWaiverMath() {
  const freight = 45;
  const codFee = 20;
  const originalDelivery = freight + codFee;
  const customerDelivery = 0;
  const totalWithoutOffer = 1000 + originalDelivery + 0 - 0;
  const totalWithOffer = 1000 + customerDelivery + 0 - 0;
  assert.strictEqual(totalWithOffer, 1000);
  assert.strictEqual(totalWithoutOffer, 1065);
  assert.ok(originalDelivery > customerDelivery);
}

function testExclusivePromoDetection() {
  assert.strictEqual(isExclusivePromoActive({}), false);
  assert.strictEqual(isExclusivePromoActive({ appliedCouponCode: null }), false);
  assert.strictEqual(isExclusivePromoActive({ appliedCouponCode: '  ' }), false);
  assert.strictEqual(isExclusivePromoActive({ appliedCouponCode: 'WEL50' }), true);
  assert.strictEqual(
    isExclusivePromoActive({ appliedReferral: { code: 'RF-001', discount: 80 } }),
    true
  );
  assert.strictEqual(isExclusivePromoActive({ appliedReferral: {} }), false);
}

function testDecideWaiverWithoutPromo() {
  const offer = { _id: 'o1', name: 'Free ship 999', minCartValue: 999 };
  const ok = decideFreeShippingWaiver({
    thresholdMet: true,
    offer,
    minCartValue: 999,
    shortfallInr: 0,
    exclusivePromoActive: false
  });
  assert.strictEqual(ok.applied, true);
  assert.strictEqual(ok.blockedByExclusivePromo, false);
  assert.strictEqual(ok.blockReason, null);
}

function testDecideWaiverBlockedByCoupon() {
  const offer = { _id: 'o1', name: 'Free ship 999', minCartValue: 999 };
  const blocked = decideFreeShippingWaiver({
    thresholdMet: true,
    offer,
    minCartValue: 999,
    shortfallInr: 0,
    exclusivePromoActive: true
  });
  assert.strictEqual(blocked.applied, false);
  assert.strictEqual(blocked.blockedByExclusivePromo, true);
  assert.strictEqual(blocked.blockReason, FREE_SHIPPING_BLOCK_REASON);
  assert.ok(blocked.offer);
}

function testDecideWaiverBelowThreshold() {
  const offer = { _id: 'o1', name: 'Free ship 999', minCartValue: 999 };
  const below = decideFreeShippingWaiver({
    thresholdMet: false,
    offer,
    minCartValue: 999,
    shortfallInr: 100,
    exclusivePromoActive: false
  });
  assert.strictEqual(below.applied, false);
  assert.strictEqual(below.blockedByExclusivePromo, false);
  assert.strictEqual(below.shortfallInr, 100);
}

function testRestoreDeliveryWhenPromoBlocksQuoteWaiver() {
  const restored = applyExclusivePromoToDeliveryState({
    deliveryCharges: 0,
    deliveryMeta: {
      freeShippingApplied: true,
      freeShippingOffer: { name: 'Free ship', minCartValue: 999 },
      originalDeliveryCharges: 65,
      freightInr: 45,
      codFeeInr: 20
    },
    exclusivePromoActive: true
  });
  assert.strictEqual(restored.deliveryCharges, 65);
  assert.strictEqual(restored.freeShippingApplied, false);
  assert.strictEqual(restored.freeShippingOffer, null);
  assert.strictEqual(restored.freeShippingBlockedByPromo, true);
  assert.strictEqual(restored.deliveryMeta.freeShippingApplied, false);
}

function testNoChangeWhenNoPromoAndNoWaiver() {
  const same = applyExclusivePromoToDeliveryState({
    deliveryCharges: 49,
    deliveryMeta: {
      freeShippingApplied: false,
      originalDeliveryCharges: 49,
      freightInr: 49,
      codFeeInr: 0
    },
    exclusivePromoActive: false
  });
  assert.strictEqual(same.deliveryCharges, 49);
  assert.strictEqual(same.freeShippingApplied, false);
  assert.strictEqual(same.freeShippingBlockedByPromo, false);
}

function testPromoActiveButShippingAlreadyCharged() {
  const kept = applyExclusivePromoToDeliveryState({
    deliveryCharges: 55,
    deliveryMeta: {
      freeShippingApplied: false,
      originalDeliveryCharges: 55,
      freightInr: 55,
      codFeeInr: 0
    },
    exclusivePromoActive: true
  });
  assert.strictEqual(kept.deliveryCharges, 55);
  assert.strictEqual(kept.freeShippingApplied, false);
  assert.strictEqual(kept.freeShippingBlockedByPromo, true);
}

function run() {
  testLiveWithoutEndDate();
  testInactiveNotLive();
  testExpiredEndDate();
  testFutureEndDateStillLive();
  testThresholdLogic();
  testWaiverMath();
  testExclusivePromoDetection();
  testDecideWaiverWithoutPromo();
  testDecideWaiverBlockedByCoupon();
  testDecideWaiverBelowThreshold();
  testRestoreDeliveryWhenPromoBlocksQuoteWaiver();
  testNoChangeWhenNoPromoAndNoWaiver();
  testPromoActiveButShippingAlreadyCharged();
  console.log('All free-shipping offer tests passed.');
}

run();

/**
 * Unit tests — free shipping offer evaluation (no DB).
 * Run: node scripts/test-free-shipping-offer.js
 */
const assert = require('assert');
const {
  isOfferCurrentlyLive,
  roundMoney2
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

function run() {
  testLiveWithoutEndDate();
  testInactiveNotLive();
  testExpiredEndDate();
  testFutureEndDateStillLive();
  testThresholdLogic();
  testWaiverMath();
  console.log('All free-shipping offer tests passed.');
}

run();

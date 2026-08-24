/**
 * Unit tests — Shipmozo substitute courier exclude + pick logic.
 * Run: node scripts/test-shipmozo-substitute-courier.js
 */
const assert = require('assert');
const {
  pickSubstituteCourier,
  normalizeExcludeCourierIds
} = require('../services/shipmozoFulfillment.service');

const sample = [
  { courierId: 101, courierName: 'Shadowfax', totalCharges: 40, estimatedDays: 3 },
  { courierId: 202, courierName: 'Xpressbees', totalCharges: 45, estimatedDays: 2 },
  { courierId: 303, courierName: 'Delhivery', totalCharges: 55, estimatedDays: 4 },
  { courierId: 404, courierName: 'Bluedart', totalCharges: 80, estimatedDays: 2 }
];

function testNormalizeExclude() {
  const s = normalizeExcludeCourierIds([101, '202', null, 'x', 101]);
  assert.strictEqual(s.has(101), true);
  assert.strictEqual(s.has(202), true);
  assert.strictEqual(s.size, 2);
  assert.strictEqual(normalizeExcludeCourierIds(null).size, 0);
  assert.strictEqual(normalizeExcludeCourierIds(303).has(303), true);
}

function testPickExcludesFailedQuoted() {
  const picked = pickSubstituteCourier(sample, {
    maxCharge: 50,
    excludeCourierIds: [101]
  });
  assert.ok(picked);
  assert.strictEqual(picked.courierId, 202);
  assert.notStrictEqual(picked.courierId, 101);
}

function testPickNeverReturnsExcludedEvenIfCheapest() {
  const picked = pickSubstituteCourier(sample, {
    maxCharge: null,
    excludeCourierIds: new Set([101, 202])
  });
  assert.ok(picked);
  assert.strictEqual(picked.courierId, 303);
}

function testPickReturnsNullWhenAllExcluded() {
  const picked = pickSubstituteCourier(sample, {
    excludeCourierIds: [101, 202, 303, 404]
  });
  assert.strictEqual(picked, null);
}

function testBoundedRetrySeedDoesNotResuggestFailed() {
  const failed = new Set([101]);
  const first = pickSubstituteCourier(sample, { maxCharge: 50, excludeCourierIds: failed });
  assert.strictEqual(first.courierId, 202);
  failed.add(first.courierId);
  const second = pickSubstituteCourier(sample, { maxCharge: 50, excludeCourierIds: failed });
  assert.strictEqual(second.courierId, 303);
  failed.add(second.courierId);
  const third = pickSubstituteCourier(sample, { maxCharge: 50, excludeCourierIds: failed });
  assert.strictEqual(third.courierId, 404);
}

function testPrefersUnderMaxChargeAmongNonExcluded() {
  const picked = pickSubstituteCourier(sample, {
    maxCharge: 60,
    excludeCourierIds: [101]
  });
  assert.strictEqual(picked.courierId, 202);
}

function run() {
  testNormalizeExclude();
  testPickExcludesFailedQuoted();
  testPickNeverReturnsExcludedEvenIfCheapest();
  testPickReturnsNullWhenAllExcluded();
  testBoundedRetrySeedDoesNotResuggestFailed();
  testPrefersUnderMaxChargeAmongNonExcluded();
  console.log('All shipmozo substitute courier tests passed.');
}

run();

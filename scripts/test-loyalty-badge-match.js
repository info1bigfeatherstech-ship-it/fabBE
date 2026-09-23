/**
 * Pure unit checks for loyalty badge matching + capacity helpers (no DB).
 * Rank: lower number = better (1 beats 2).
 * Run: node scripts/test-loyalty-badge-match.js
 */
const assert = require('assert');
const {
  badgeMatchesStats,
  pickBestBadge,
  couponLoyaltyEligible,
  normalizeSlug,
  normalizeMaxMembers,
  compareBadgeTier
} = require('../services/loyalty.service');

// Podium ranks: Gold=1 best, Silver=2, Bronze=3
const bronze = {
  slug: 'bronze',
  name: 'Bronze',
  criteriaMode: 'spend',
  minLifetimeSpendInr: 10000,
  minOrderCount: 0,
  rank: 3,
  isActive: true
};
const silver = {
  slug: 'silver',
  name: 'Silver',
  criteriaMode: 'spend_or_orders',
  minLifetimeSpendInr: 25000,
  minOrderCount: 10,
  rank: 2,
  isActive: true,
  maxMembers: 5
};
const gold = {
  slug: 'gold',
  name: 'Gold',
  criteriaMode: 'spend_and_orders',
  minLifetimeSpendInr: 50000,
  minOrderCount: 15,
  rank: 1,
  isActive: true
};

assert.strictEqual(badgeMatchesStats(bronze, { lifetimeSpendInr: 9999, lifetimeOrderCount: 100 }), false);
assert.strictEqual(badgeMatchesStats(bronze, { lifetimeSpendInr: 10000, lifetimeOrderCount: 0 }), true);
assert.strictEqual(badgeMatchesStats(silver, { lifetimeSpendInr: 0, lifetimeOrderCount: 10 }), true);
assert.strictEqual(badgeMatchesStats(silver, { lifetimeSpendInr: 25000, lifetimeOrderCount: 0 }), true);
assert.strictEqual(badgeMatchesStats(gold, { lifetimeSpendInr: 50000, lifetimeOrderCount: 10 }), false);
assert.strictEqual(badgeMatchesStats(gold, { lifetimeSpendInr: 50000, lifetimeOrderCount: 15 }), true);

const best = pickBestBadge([bronze, silver, gold], { lifetimeSpendInr: 60000, lifetimeOrderCount: 20 });
assert.strictEqual(best.slug, 'gold');

const mid = pickBestBadge([bronze, silver, gold], { lifetimeSpendInr: 12000, lifetimeOrderCount: 2 });
assert.strictEqual(mid.slug, 'bronze');

const skipSilver = pickBestBadge([bronze, silver, gold], { lifetimeSpendInr: 30000, lifetimeOrderCount: 12 }, {
  excludeSlugs: ['silver']
});
assert.strictEqual(skipSilver.slug, 'bronze');

// Real admin config: Silver ₹500 rank 2, Gold ₹1000 rank 1 — spend 2500 must pick Gold
const shopSilver = {
  slug: 'silver',
  name: 'Silver',
  criteriaMode: 'spend',
  minLifetimeSpendInr: 500,
  minOrderCount: 0,
  rank: 2,
  isActive: true
};
const shopGold = {
  slug: 'gold',
  name: 'Gold',
  criteriaMode: 'spend',
  minLifetimeSpendInr: 1000,
  minOrderCount: 0,
  rank: 1,
  isActive: true
};
const upgraded = pickBestBadge([shopSilver, shopGold], { lifetimeSpendInr: 2602.58, lifetimeOrderCount: 2 });
assert.strictEqual(upgraded.slug, 'gold');

const onlySilver = pickBestBadge([shopSilver, shopGold], { lifetimeSpendInr: 750, lifetimeOrderCount: 1 });
assert.strictEqual(onlySilver.slug, 'silver');

assert.ok(compareBadgeTier(shopGold, shopSilver) < 0, 'Gold rank 1 sorts before Silver rank 2');

assert.strictEqual(couponLoyaltyEligible({ allowedLoyaltyBadges: [] }, null), true);
assert.strictEqual(couponLoyaltyEligible({ allowedLoyaltyBadges: ['gold'] }, 'silver'), false);
assert.strictEqual(couponLoyaltyEligible({ allowedLoyaltyBadges: ['gold', 'silver'] }, 'Silver'), true);
assert.strictEqual(normalizeSlug('Gold Member!'), 'gold-member');

assert.strictEqual(normalizeMaxMembers(null), null);
assert.strictEqual(normalizeMaxMembers(''), null);
assert.strictEqual(normalizeMaxMembers(0), null);
assert.strictEqual(normalizeMaxMembers(5), 5);
assert.strictEqual(normalizeMaxMembers('50'), 50);

console.log('loyalty badge match tests: ok');

/**
 * Admin marketing-tag query parsing (no network / DB).
 * Run: node utils/productTagQuery.unit.js
 */
const assert = require('node:assert/strict');
const {
  MARKETING_TAG_SLUGS,
  normalizeTagSlugs,
  sanitizeMarketingTags,
  expandTagSlugsForQuery,
  resolveAdminMarketingTagFilter,
} = require('./productTagQuery');

assert.deepEqual(normalizeTagSlugs('on-sale'), ['on-sale']);
assert.deepEqual(normalizeTagSlugs('on_sale,festive-offer'), ['on-sale', 'festive-offer']);
assert.deepEqual(normalizeTagSlugs(['Festive-Offer', 'on-sale', 'on-sale']), ['festive-offer', 'on-sale']);

assert.deepEqual(resolveAdminMarketingTagFilter(undefined), { active: false, slugs: [] });
assert.deepEqual(resolveAdminMarketingTagFilter(''), { active: false, slugs: [] });
assert.deepEqual(resolveAdminMarketingTagFilter('   '), { active: false, slugs: [] });
assert.deepEqual(resolveAdminMarketingTagFilter([]), { active: false, slugs: [] });

assert.deepEqual(resolveAdminMarketingTagFilter('on-sale'), {
  active: true,
  slugs: ['on-sale'],
});
assert.deepEqual(resolveAdminMarketingTagFilter('festive_offer'), {
  active: true,
  slugs: ['festive-offer'],
});
assert.deepEqual(resolveAdminMarketingTagFilter('not-a-real-tag'), {
  active: true,
  slugs: [],
});
assert.deepEqual(resolveAdminMarketingTagFilter('on-sale,bogus,festive-offer'), {
  active: true,
  slugs: ['on-sale', 'festive-offer'],
});

for (const slug of MARKETING_TAG_SLUGS) {
  const resolved = resolveAdminMarketingTagFilter(slug);
  assert.equal(resolved.active, true);
  assert.deepEqual(resolved.slugs, [slug]);
}

assert.deepEqual(
  sanitizeMarketingTags(['ganesh-chaturthi-sale', 'on-sale', 'ganesh-chaturthi-sale']),
  ['festive-offer', 'on-sale']
);
assert.deepEqual(
  sanitizeMarketingTags(['festive-offer', 'ganesh-chaturthi-sale', 'not-a-tag']),
  ['festive-offer']
);
assert.deepEqual(sanitizeMarketingTags(null), []);
assert.deepEqual(sanitizeMarketingTags(['on-sale']), ['on-sale']);

const expanded = expandTagSlugsForQuery(['festive-offer']);
assert.equal(expanded.includes('festive-offer'), true);
assert.equal(expanded.includes('ganesh-chaturthi-sale'), true);

assert.deepEqual(resolveAdminMarketingTagFilter('ganesh-chaturthi-sale'), {
  active: true,
  slugs: ['festive-offer'],
});

console.log('productTagQuery.unit.js: ok');

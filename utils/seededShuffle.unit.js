/**
 * Seeded shuffle pagination (no network / DB).
 * Run: node utils/seededShuffle.unit.js
 */
const assert = require('node:assert/strict');
const {
  seededShuffle,
  sliceSeededShuffle,
  parseShuffleSeed,
  fallbackShuffleSeed,
  RANDOM_WINDOW_MS,
} = require('./seededShuffle');

const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);

const shuffled = seededShuffle(ids, 42);
assert.equal(shuffled.length, 100);
assert.notDeepEqual(shuffled, ids);
assert.deepEqual([...shuffled].sort(), [...ids].sort());
assert.deepEqual(seededShuffle(ids, 42), shuffled);
assert.notDeepEqual(seededShuffle(ids, 43), shuffled);

const page1 = sliceSeededShuffle(ids, { seed: 42, skip: 0, limit: 50 });
const page2 = sliceSeededShuffle(ids, { seed: 42, skip: 50, limit: 50 });
assert.equal(page1.length, 50);
assert.equal(page2.length, 50);
assert.deepEqual([...page1, ...page2], shuffled);
const overlap = new Set(page1.filter((id) => page2.includes(id)));
assert.equal(overlap.size, 0, 'page 1 and page 2 must not overlap');

assert.deepEqual(sliceSeededShuffle([], { seed: 1, skip: 0, limit: 50 }), []);
assert.deepEqual(sliceSeededShuffle(ids, { seed: 1, skip: 1000, limit: 50 }), []);
assert.deepEqual(sliceSeededShuffle(ids, { seed: 1, skip: 0, limit: 0 }), []);
assert.deepEqual(seededShuffle(null, 1), []);
assert.deepEqual(seededShuffle(['only'], 99), ['only']);

assert.equal(parseShuffleSeed('123'), 123);
assert.equal(parseShuffleSeed(99), 99);
assert.equal(parseShuffleSeed(undefined, 7), 7);
assert.equal(parseShuffleSeed('', 7), 7);
assert.equal(parseShuffleSeed('nope', 7), 7);
assert.equal(parseShuffleSeed([44, 99], 1), 44);
assert.equal(parseShuffleSeed(-1), (-1) >>> 0);

const t = RANDOM_WINDOW_MS * 10 + 100;
assert.equal(fallbackShuffleSeed(t), fallbackShuffleSeed(t + 1000));
assert.notEqual(fallbackShuffleSeed(t), fallbackShuffleSeed(t + RANDOM_WINDOW_MS));

console.log('seededShuffle.unit.js: ok');

/**
 * Run: node utils/imageAxis.unit.js
 */
const assert = require('node:assert/strict')
const {
  resolveImageAxisKey,
  imageGroupToken,
  applyInheritedGroupImages,
  shareImagesAcrossGroup,
  dropRedundantVariantImageFiles,
} = require('./imageAxis')

assert.equal(
  resolveImageAxisKey([
    [{ key: 'Size', value: 'M' }, { key: 'Color', value: 'Red' }],
    [{ key: 'Color', value: 'Black' }, { key: 'Size', value: 'L' }],
  ]),
  'Color'
)
assert.equal(
  resolveImageAxisKey([
    [{ key: 'Fragrance', value: 'Rose' }, { key: 'Size', value: '50ml' }],
    [{ key: 'Fragrance', value: 'Oud' }, { key: 'Size', value: '100ml' }],
  ]),
  'Fragrance'
)
assert.equal(
  resolveImageAxisKey([[{ key: 'Size', value: 'M' }], [{ key: 'Size', value: 'L' }]]),
  ''
)

assert.equal(
  imageGroupToken([{ key: 'Color', value: 'Red' }, { key: 'Size', value: 'XL' }], 'Color'),
  'color=red'
)
assert.equal(imageGroupToken([{ key: 'Size', value: 'XL' }], ''), '__all__')

const variants = [
  { attributes: [{ key: 'Color', value: 'Red' }, { key: 'Size', value: 'X' }], images: [{ url: 'https://cdn/red1.jpg', publicId: 'r1' }] },
  { attributes: [{ key: 'Color', value: 'Red' }, { key: 'Size', value: 'XL' }], images: [] },
  { attributes: [{ key: 'Color', value: 'Black' }, { key: 'Size', value: 'SM' }], images: [{ url: 'https://cdn/blk.jpg', publicId: 'b1' }] },
  { attributes: [{ key: 'Color', value: 'Black' }, { key: 'Size', value: 'X' }], images: [] },
]
const inherited = applyInheritedGroupImages(variants)
assert.equal(inherited.filled, 2)
assert.equal(inherited.axisKey, 'Color')
assert.equal(variants[1].images[0].url, 'https://cdn/red1.jpg')
assert.equal(variants[1].images[0].publicId, 'r1')
assert.equal(variants[3].images[0].url, 'https://cdn/blk.jpg')
assert.notEqual(variants[1].images[0].url, variants[3].images[0].url)

const perfume = [
  { attributes: [{ key: 'Fragrance', value: 'Rose' }, { key: 'Size', value: '50ml' }], images: [{ url: 'https://cdn/rose.jpg', publicId: 'rose' }] },
  { attributes: [{ key: 'Fragrance', value: 'Rose' }, { key: 'Size', value: '100ml' }], images: [] },
]
assert.equal(applyInheritedGroupImages(perfume).filled, 1)
assert.equal(perfume[1].images[0].publicId, 'rose')

const shared = [
  { attributes: [{ key: 'Color', value: 'Red' }, { key: 'Size', value: 'X' }], images: [{ url: 'https://cdn/new.jpg', publicId: 'n1' }] },
  { attributes: [{ key: 'Color', value: 'Red' }, { key: 'Size', value: 'XL' }], images: [{ url: 'https://cdn/old.jpg', publicId: 'old' }] },
  { attributes: [{ key: 'Color', value: 'Black' }, { key: 'Size', value: 'X' }], images: [{ url: 'https://cdn/blk.jpg', publicId: 'b' }] },
]
assert.equal(shareImagesAcrossGroup(shared, 0).shared, 1)
assert.equal(shared[1].images[0].publicId, 'n1')
assert.equal(shared[2].images[0].publicId, 'b')

const files = dropRedundantVariantImageFiles(
  [
    { attributes: [{ key: 'Color', value: 'Red' }, { key: 'Size', value: 'X' }] },
    { attributes: [{ key: 'Color', value: 'Red' }, { key: 'Size', value: 'XL' }] },
    { attributes: [{ key: 'Color', value: 'Black' }, { key: 'Size', value: 'SM' }] },
  ],
  { 0: ['red-a'], 1: ['red-b-dup'], 2: ['black-a'] }
)
assert.deepEqual(Object.keys(files), ['0', '2'])
assert.equal(files[1], undefined)

console.log('imageAxis.unit.js: all assertions passed')

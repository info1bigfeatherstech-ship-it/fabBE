/**
 * Bulk GST helpers (no network / DB writes).
 * Run: node utils/productUtils.gst.unit.js
 */
const assert = require('node:assert/strict')
const {
  GST_RATE_OPTIONS,
  gstRateAllowedValuesText,
  parseBulkGstRate,
  patchBulkInstructionColumns,
} = require('./productUtils')

assert.deepEqual(GST_RATE_OPTIONS, [0, 3, 5, 12, 18, 28])
assert.equal(gstRateAllowedValuesText(), '0, 3, 5, 12, 18, 28')
assert.ok(GST_RATE_OPTIONS.includes(3), 'bulk template slabs must include 3%')
assert.equal(GST_RATE_OPTIONS.includes(6), false)
assert.equal(GST_RATE_OPTIONS.includes(9), false)

assert.equal(parseBulkGstRate(3), 3)
assert.equal(parseBulkGstRate('3'), 3)
assert.equal(parseBulkGstRate('3%'), 3)
assert.equal(parseBulkGstRate(' 3 % '), 3)
assert.equal(parseBulkGstRate('3.0'), 3)
assert.equal(parseBulkGstRate(0), 0)
assert.equal(parseBulkGstRate('0'), 0)
assert.equal(parseBulkGstRate(''), null)
assert.equal(parseBulkGstRate(null), null)
assert.equal(parseBulkGstRate(undefined), null)
assert.equal(parseBulkGstRate('   '), null)
assert.equal(parseBulkGstRate(5), 5)
assert.equal(parseBulkGstRate(12), 12)
assert.equal(parseBulkGstRate(18), 18)
assert.equal(parseBulkGstRate(28), 28)

assert.throws(() => parseBulkGstRate('abc'), /Invalid gstRate/)
assert.throws(() => parseBulkGstRate(-1), /greater than or equal to 0/)

const patched = patchBulkInstructionColumns([
  ['Col', 'Field', 'Required', 'Type', 'Allowed'],
  ['Z', 'gstRate', 'No', 'Number', '0, 5, 12, 18, 28'],
])
assert.equal(patched[1][4], '0, 3, 5, 12, 18, 28')

console.log('productUtils.gst.unit.js: all assertions passed')

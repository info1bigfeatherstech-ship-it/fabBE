/**
 * Shipmozo webhook — parser / cancel helpers (no DB).
 * Run: node scripts/test-shipmozo-webhook.js
 */
const assert = require('assert');
const {
  parseShipmozoWebhookPayload,
  mapStatusFeedToEvents,
  isShipmozoCancelStatus,
  extractShipmozoWebhookToken
} = require('../services/shipmozoWebhook.service');

function testParseSamplePayload() {
  const parsed = parseShipmozoWebhookPayload({
    order_id: 'ORD-1001',
    refrence_id: 'sm-ref-9',
    awb_number: 'AWB123',
    carrier: 'Delhivery',
    expected_delivery_date: '2025-07-15 18:29:59',
    shipment_type: 'Forward',
    current_status: 'Delivered',
    status_time: '2025-07-15 09:12:16',
    status_feed: {
      scan: [
        {
          date: '2025-07-14 09:12:16',
          status: 'Delivered to consignee',
          location: 'Mumbai'
        },
        {
          date: '2025-07-14 06:08:36',
          status: 'Out for delivery',
          location: 'Mumbai'
        }
      ]
    }
  });

  assert.strictEqual(parsed.orderId, 'ORD-1001');
  assert.strictEqual(parsed.referenceId, 'sm-ref-9');
  assert.strictEqual(parsed.awbNumber, 'AWB123');
  assert.strictEqual(parsed.currentStatus, 'Delivered');
  assert.strictEqual(parsed.courier, 'Delhivery');
  assert.strictEqual(parsed.events.length, 2);
  assert.strictEqual(parsed.events[0].status, 'Delivered to consignee');
  assert.ok(parsed.events[0].at instanceof Date);
  console.log('ok parseShipmozoWebhookPayload sample');
}

function testReferenceIdFallbackSpelling() {
  const a = parseShipmozoWebhookPayload({ reference_id: 'REF-A' });
  assert.strictEqual(a.referenceId, 'REF-A');
  const b = parseShipmozoWebhookPayload({ refrence_id: 'REF-B' });
  assert.strictEqual(b.referenceId, 'REF-B');
  console.log('ok reference_id / refrence_id');
}

function testEmptyScan() {
  assert.deepStrictEqual(mapStatusFeedToEvents(null), []);
  assert.deepStrictEqual(mapStatusFeedToEvents({}), []);
  assert.deepStrictEqual(mapStatusFeedToEvents({ scan: [] }), []);
  console.log('ok empty status_feed');
}

function testCancelDetection() {
  assert.strictEqual(isShipmozoCancelStatus('Cancelled'), true);
  assert.strictEqual(isShipmozoCancelStatus('Shipment Cancelled'), true);
  assert.strictEqual(isShipmozoCancelStatus('AWB Cancelled'), true);
  assert.strictEqual(isShipmozoCancelStatus('Delivered'), false);
  assert.strictEqual(isShipmozoCancelStatus('In Transit'), false);
  assert.strictEqual(isShipmozoCancelStatus(''), false);
  console.log('ok isShipmozoCancelStatus');
}

function testTokenExtract() {
  assert.strictEqual(
    extractShipmozoWebhookToken({ query: { token: 'abc' }, headers: {} }),
    'abc'
  );
  assert.strictEqual(
    extractShipmozoWebhookToken({
      query: {},
      headers: { 'x-shipmozo-token': 'hdr1' }
    }),
    'hdr1'
  );
  assert.strictEqual(
    extractShipmozoWebhookToken({
      query: {},
      headers: { 'x-webhook-token': 'hdr2' }
    }),
    'hdr2'
  );
  assert.strictEqual(
    extractShipmozoWebhookToken({
      query: { token: 'q' },
      headers: { 'x-shipmozo-token': 'h' }
    }),
    'q'
  );
  console.log('ok extractShipmozoWebhookToken');
}

function testMissingIdsStillParse() {
  const parsed = parseShipmozoWebhookPayload({ current_status: 'In Transit' });
  assert.strictEqual(parsed.orderId, '');
  assert.strictEqual(parsed.awbNumber, '');
  assert.strictEqual(parsed.currentStatus, 'In Transit');
  console.log('ok parse without ids');
}

testParseSamplePayload();
testReferenceIdFallbackSpelling();
testEmptyScan();
testCancelDetection();
testTokenExtract();
testMissingIdsStillParse();
console.log('all test-shipmozo-webhook checks passed');

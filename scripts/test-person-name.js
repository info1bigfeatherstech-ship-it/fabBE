/**
 * Run: node scripts/test-person-name.js
 */
const assert = require('assert');
const { parsePersonName, normalizePersonName } = require('../utils/personName');

function expectOk(raw, value) {
  const res = parsePersonName(raw);
  assert.strictEqual(res.ok, true, `${raw} should pass: ${res.message}`);
  assert.strictEqual(res.value, value);
}

function expectFail(raw) {
  const res = parsePersonName(raw);
  assert.strictEqual(res.ok, false, `${raw} should fail`);
}

function run() {
  assert.strictEqual(normalizePersonName('  Rahul   Kumar  '), 'Rahul Kumar');
  expectOk('Ram', 'Ram');
  expectOk('Rahul Sharma', 'Rahul Sharma');
  expectOk('  Rahul   Kumar Sharma  ', 'Rahul Kumar Sharma');
  expectFail('');
  expectFail('Al');
  expectFail('A B');
  expectFail('Rahul123');
  expectFail('राहुल');
  expectFail('Rahul@Sharma');
  expectFail('Rahul Kumar Singh Verma');
  expectFail('Mr Rahul');
  expectFail('Aaa');
  expectFail('x'.repeat(51));
  console.log('All person-name tests passed.');
}

run();

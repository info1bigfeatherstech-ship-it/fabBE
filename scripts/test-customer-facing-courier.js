/**
 * Unit tests — quoted vs assigned courier helpers.
 * Label / track use assigned; quoted is admin + bill context only.
 * Run: node scripts/test-customer-facing-courier.js
 */
const assert = require('assert');
const {
  resolveCustomerFacingCourierName,
  resolveAssignedCourierName,
  isCourierSubstitutedForCustomer
} = require('../utils/customerFacingCourier');

function order(partial) {
  return partial;
}

assert.strictEqual(
  resolveCustomerFacingCourierName(
    order({
      shippingSnapshot: { courierName: 'Blue Dart Surface' },
      shipmentInfo: {
        courier: 'Xpressbees Surface',
        courierSubstitutedFromName: 'Blue Dart Surface'
      }
    })
  ),
  'Blue Dart Surface',
  'quoted stays checkout / substitute-from'
);

assert.strictEqual(
  resolveAssignedCourierName(
    order({
      shippingSnapshot: { courierName: 'Blue Dart Surface' },
      shipmentInfo: { courier: 'Xpressbees Surface' }
    })
  ),
  'Xpressbees Surface',
  'assigned is booked courier for label/AWB'
);

assert.strictEqual(
  isCourierSubstitutedForCustomer(
    order({
      shippingSnapshot: { courierName: 'Blue Dart Surface' },
      shipmentInfo: {
        courier: 'Xpressbees Surface',
        courierSubstitutedFromName: 'Blue Dart Surface'
      }
    })
  ),
  true
);

assert.strictEqual(
  resolveAssignedCourierName(
    order({
      shippingSnapshot: { courierName: 'Delhivery Surface' },
      shipmentInfo: { courier: 'Delhivery Surface' }
    })
  ),
  'Delhivery Surface'
);

assert.strictEqual(
  resolveAssignedCourierName(
    order({
      shippingSnapshot: { courierName: 'Shiprocket' },
      shipmentInfo: { courier: 'Delhivery' }
    })
  ),
  'Delhivery'
);

assert.strictEqual(
  resolveAssignedCourierName(
    order({
      shipmentInfo: { courier: 'Shipmozo' }
    })
  ),
  null
);

console.log('test-customer-facing-courier: ok');

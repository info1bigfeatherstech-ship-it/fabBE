/**
 * Retail promo payable-price helpers (no network / DB writes).
 * Run: node utils/variantPrice.unit.js
 */
const assert = require('node:assert/strict');
const {
  computePromoFromSale,
  isPromoChargeable,
  resolveRetailPayablePrice,
  resolveStorefrontVariantPrice,
  productHasValidOnSalePrice,
  readIncomingPromoPrice,
} = require('./variantPrice');

assert.equal(computePromoFromSale(100), 80);
assert.equal(computePromoFromSale(120), 96);
assert.equal(computePromoFromSale(99), 79); // 79.2 → 79
assert.equal(computePromoFromSale(101), 81); // 80.8 → 81
assert.equal(computePromoFromSale(null), null);
assert.equal(computePromoFromSale(0), null);
assert.equal(computePromoFromSale(-10), null);

const variant = {
  price: { base: 120, sale: 100, promo: 80 },
};

const withPromo = resolveRetailPayablePrice(variant, { isOnSale: true });
assert.equal(withPromo.current, 80);
assert.equal(withPromo.sale, 100);
assert.equal(withPromo.base, 120);
assert.equal(withPromo.isPromoActive, true);
assert.equal(withPromo.compareSale, 100);
assert.equal(withPromo.discountPercentage, 33); // (120-80)/120

const untagged = resolveRetailPayablePrice(variant, { isOnSale: false });
assert.equal(untagged.current, 100);
assert.equal(untagged.isPromoActive, false);
assert.equal(untagged.discountPercentage, 17);

const noPromoField = resolveRetailPayablePrice(
  { price: { base: 120, sale: 100 } },
  { isOnSale: true }
);
assert.equal(noPromoField.current, 100);
assert.equal(noPromoField.isPromoActive, false);

const invalidPromo = resolveRetailPayablePrice(
  { price: { base: 120, sale: 100, promo: 110 } },
  { isOnSale: true }
);
assert.equal(invalidPromo.current, 100);
assert.equal(invalidPromo.isPromoActive, false);

const noSale = resolveRetailPayablePrice(
  { price: { base: 120, promo: 80 } },
  { isOnSale: true }
);
assert.equal(noSale.current, 120);
assert.equal(noSale.isPromoActive, false);

assert.equal(
  isPromoChargeable({ base: 120, sale: 100, promo: 80, isOnSale: true }),
  true
);
assert.equal(
  isPromoChargeable({ base: 120, sale: 100, promo: 80, isOnSale: false }),
  false
);

const wholesale = resolveStorefrontVariantPrice(
  { price: { base: 120, sale: 100, promo: 80, wholesaleBase: 90, wholesaleSale: 70 } },
  'wholesale',
  { isOnSale: true }
);
assert.equal(wholesale.current, 70);
assert.equal(wholesale.isPromoActive, false);
assert.equal(wholesale.promo, null);

const broken = resolveRetailPayablePrice(null, { isOnSale: true });
assert.equal(broken.current, 0);
assert.equal(broken.isPromoActive, false);

assert.equal(
  productHasValidOnSalePrice({
    variants: [{ price: { base: 120, sale: 100, promo: 80 } }],
  }),
  true
);
assert.equal(
  productHasValidOnSalePrice({
    variants: [
      { price: { base: 120, sale: 100, promo: 80 } },
      { price: { base: 120, sale: 100 } },
    ],
  }),
  false
);
assert.equal(productHasValidOnSalePrice({ variants: [] }), false);

assert.equal(readIncomingPromoPrice({ promo: 80 }), 80);
assert.equal(readIncomingPromoPrice({ onSale: 75 }), 75);
assert.equal(readIncomingPromoPrice({ onSalePrice: 70 }), 70);
assert.equal(readIncomingPromoPrice({ promo: 80, onSale: 1 }), 80);
assert.equal(readIncomingPromoPrice({ base: 120 }), undefined);
assert.equal(readIncomingPromoPrice({ promo: null }), null);

console.log('variantPrice.unit.js: ok');

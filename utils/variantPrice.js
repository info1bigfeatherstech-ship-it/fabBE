/**
 * Retail payable-price resolver.
 *
 * Catalog fields (never overwritten by this helper):
 *   price.base  = MRP
 *   price.sale  = existing sale
 *   price.promo = extra on-sale price (20% off sale, stored separately)
 *
 * Promo is charged only when:
 *   - caller says the product is tagged `on-sale`
 *   - 0 < promo < sale < base
 *
 * Invalid / missing promo → exact previous behaviour (sale, else base).
 * Wholesale is handled by callers; this file is retail-only.
 */

const PROMO_FRACTION = 0.8; // keep 80% of sale = 20% extra off

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundRupee(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/** 20% off sale, nearest rupee. Null if sale is not a positive number. */
function computePromoFromSale(sale) {
  const saleNum = toFiniteNumber(sale, null);
  if (saleNum == null || saleNum <= 0) return null;
  const promo = roundRupee(saleNum * PROMO_FRACTION);
  if (promo == null || promo <= 0) return null;
  return promo;
}

function isSaleValid(base, sale) {
  return (
    Number.isFinite(base) &&
    base > 0 &&
    Number.isFinite(sale) &&
    sale > 0 &&
    sale < base
  );
}

function isPromoChargeable({ base, sale, promo, isOnSale }) {
  if (!isOnSale) return false;
  if (!isSaleValid(base, sale)) return false;
  return Number.isFinite(promo) && promo > 0 && promo < sale && promo < base;
}

/**
 * Resolve what a retail customer pays for a variant.
 * Never throws — bad data falls back to base (or 0).
 */
function resolveRetailPayablePrice(variant, { isOnSale = false } = {}) {
  try {
    const price = variant && variant.price && typeof variant.price === 'object'
      ? variant.price
      : {};
    const base = toFiniteNumber(price.base, 0) || 0;
    const sale = toFiniteNumber(price.sale, null);
    const promo = toFiniteNumber(price.promo, null);
    const saleValid = isSaleValid(base, sale);
    const promoActive = isPromoChargeable({
      base,
      sale: saleValid ? sale : null,
      promo,
      isOnSale: Boolean(isOnSale),
    });

    const current = promoActive ? promo : saleValid ? sale : base;
    const safeCurrent = Number.isFinite(current) && current >= 0 ? current : 0;
    const discountPercentage =
      base > 0 && safeCurrent < base
        ? Math.round(((base - safeCurrent) / base) * 100)
        : 0;

    return {
      base,
      sale: saleValid ? sale : (Number.isFinite(sale) ? sale : null),
      promo: Number.isFinite(promo) ? promo : null,
      current: safeCurrent,
      isSaleActive: saleValid || promoActive,
      isPromoActive: promoActive,
      discountPercentage,
      compareSale: promoActive && saleValid ? sale : null,
      minimumOrderQuantity: 1,
    };
  } catch (err) {
    const base = toFiniteNumber(variant?.price?.base, 0) || 0;
    return {
      base,
      sale: null,
      promo: null,
      current: base,
      isSaleActive: false,
      isPromoActive: false,
      discountPercentage: 0,
      compareSale: null,
      minimumOrderQuantity: 1,
    };
  }
}

function variantHasValidOnSalePrice(variant) {
  return isPromoChargeable({
    base: toFiniteNumber(variant?.price?.base, 0) || 0,
    sale: toFiniteNumber(variant?.price?.sale, null),
    promo: toFiniteNumber(variant?.price?.promo, null),
    isOnSale: true,
  });
}

function productHasValidOnSalePrice(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (!variants.length) return false;
  return variants.every((variant) => variantHasValidOnSalePrice(variant));
}

const ON_SALE_PRICE_REQUIRED_MESSAGE =
  'On-sale price is missing. Add On-sale price (less than Sale price) on every variant, then add the product to On Sale.';

/**
 * Admin/API may send the stored field as `promo` or the UI names `onSale` / `onSalePrice`.
 * `undefined` means "not sent" (do not overwrite). Empty string / null means clear.
 */
function readIncomingPromoPrice(price) {
  if (!price || typeof price !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(price, 'promo')) return price.promo;
  if (Object.prototype.hasOwnProperty.call(price, 'onSale')) return price.onSale;
  if (Object.prototype.hasOwnProperty.call(price, 'onSalePrice')) return price.onSalePrice;
  return undefined;
}

/**
 * Storefront wrapper. Wholesale path is unchanged from existing controllers
 * (promo never applies on wholesale).
 */
function resolveStorefrontVariantPrice(variant, storefront, { isOnSale = false } = {}) {
  if (storefront === 'wholesale') {
    const wholesaleBase = toFiniteNumber(variant?.price?.wholesaleBase, 0) || 0;
    const wholesaleSale = toFiniteNumber(variant?.price?.wholesaleSale, null);
    const isSaleActive =
      Number.isFinite(wholesaleSale) &&
      wholesaleSale > 0 &&
      wholesaleSale < wholesaleBase;
    const current = isSaleActive ? wholesaleSale : wholesaleBase;
    const discountPercentage =
      isSaleActive && wholesaleBase > 0
        ? Math.round(((wholesaleBase - wholesaleSale) / wholesaleBase) * 100)
        : 0;
    return {
      base: wholesaleBase,
      sale: Number.isFinite(wholesaleSale) ? wholesaleSale : null,
      promo: null,
      current,
      isSaleActive,
      isPromoActive: false,
      discountPercentage,
      compareSale: null,
      minimumOrderQuantity: variant?.minimumOrderQuantity || 1,
    };
  }

  return resolveRetailPayablePrice(variant, { isOnSale });
}

module.exports = {
  PROMO_FRACTION,
  toFiniteNumber,
  roundRupee,
  computePromoFromSale,
  isSaleValid,
  isPromoChargeable,
  resolveRetailPayablePrice,
  resolveStorefrontVariantPrice,
  variantHasValidOnSalePrice,
  productHasValidOnSalePrice,
  readIncomingPromoPrice,
  ON_SALE_PRICE_REQUIRED_MESSAGE,
};

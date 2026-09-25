/**
 * Singleton admin settings for storefront loyalty points (separate from LoyaltyBadge tiers).
 * One document per storefront (`ecomm` | `wholesale`).
 */
const mongoose = require('mongoose');

const loyaltyPointsSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      required: true,
      unique: true,
      index: true
    },
    /** Master switch — when false, redeem/earn/clawback are no-ops and checkout totals unchanged. */
    enabled: { type: Boolean, default: false, index: true },

    /** Points earned per ₹1 of eligible paid amount (e.g. 1 = 1 point per rupee). */
    earnPointsPerRupee: { type: Number, default: 1, min: 0 },

    /** ₹ value of 1 redeemed point (e.g. 1 = ₹1 off per point). */
    redeemRupeePerPoint: { type: Number, default: 1, min: 0 },

    minOrderSubtotalToEarn: { type: Number, default: 0, min: 0 },
    minOrderSubtotalToRedeem: { type: Number, default: 0, min: 0 },
    minRedeemPoints: { type: Number, default: 1, min: 0 },

    /** Cap redeem as % of pre-loyalty payable (subtotal+ship+tax−coupon). 100 = full. */
    maxRedeemPercentOfPayable: { type: Number, default: 50, min: 0, max: 100 },

    /** Hard cap of points redeemable on one order; null/0 = no hard cap beyond %. */
    maxRedeemPointsPerOrder: { type: Number, default: null, min: 0 },

    /**
     * Days after earn before points expire. 0 = never expire.
     * Applied when crediting (expiresAt on ledger); expiry job burns expired balance.
     */
    expiryDays: { type: Number, default: 365, min: 0 },

    /** Include shipping / tax in earn base (cash paid already excludes point discount). */
    earnOnShipping: { type: Boolean, default: false },
    earnOnTax: { type: Boolean, default: false },

    /** When false, redeem is blocked if a coupon is already applied. */
    stackWithCoupon: { type: Boolean, default: true },

    termsHtml: { type: String, default: '', maxlength: 5000 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('LoyaltyPointsSettings', loyaltyPointsSettingsSchema);

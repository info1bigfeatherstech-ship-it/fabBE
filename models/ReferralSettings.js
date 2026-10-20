/**
 * Singleton admin settings for customer referral codes (one doc per storefront).
 * Loyalty ₹/point rate stays on LoyaltyPointsSettings — referral only awards points.
 */
const mongoose = require('mongoose');

const referralSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      required: true,
      unique: true,
      index: true
    },
    enabled: { type: Boolean, default: true, index: true },
    /** percentage | fixed */
    discountType: {
      type: String,
      enum: ['percentage', 'fixed'],
      default: 'percentage'
    },
    discountValue: { type: Number, default: 8, min: 0 },
    /** Cap for percentage discounts (₹). null/0 = no cap. */
    maxDiscountAmount: { type: Number, default: null, min: 0 },
    minOrderValue: { type: Number, default: 0, min: 0 },
    /** Loyalty points credited to the code owner after a successful referred order. */
    rewardPoints: { type: Number, default: 80, min: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReferralSettings', referralSettingsSchema);

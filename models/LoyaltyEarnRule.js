/**
 * Optional earn multipliers / overrides (product or category).
 * Global rate lives on LoyaltyPointsSettings; rules multiply that rate when matched.
 */
const mongoose = require('mongoose');

const loyaltyEarnRuleSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      default: 'ecomm',
      index: true
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    /**
     * scope:
     * - global: applies to all lines (multiplier on settings earn rate)
     * - category: match Product.category
     * - product: match productId
     */
    scope: {
      type: String,
      enum: ['global', 'category', 'product'],
      default: 'global',
      index: true
    },
    categorySlug: { type: String, default: null, trim: true, lowercase: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    /** Multiplier on settings.earnPointsPerRupee (1 = same, 2 = 2x points). */
    earnMultiplier: { type: Number, default: 1, min: 0 },
    /** Optional absolute override: points per ₹ (null = use settings × multiplier). */
    earnPointsPerRupeeOverride: { type: Number, default: null, min: 0 },
    priority: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true, index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null }
  },
  { timestamps: true }
);

loyaltyEarnRuleSchema.index({ storefront: 1, isActive: 1, priority: -1 });

module.exports = mongoose.model('LoyaltyEarnRule', loyaltyEarnRuleSchema);

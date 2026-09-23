/**
 * Admin-defined loyalty badges / tiers.
 * Thresholds are dynamic — spend (INR), order count, or both.
 */
const mongoose = require('mongoose');

const CRITERIA_MODES = ['spend', 'orders', 'spend_and_orders', 'spend_or_orders'];

const loyaltyBadgeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80
    },
    /** Stable key used in coupons / APIs (e.g. bronze, silver, gold). */
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 40,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers, hyphens']
    },
    description: {
      type: String,
      default: '',
      maxlength: 300
    },
    /**
     * How thresholds are evaluated:
     * - spend: lifetimeSpendInr >= minLifetimeSpendInr
     * - orders: lifetimeOrderCount >= minOrderCount
     * - spend_and_orders: both must pass
     * - spend_or_orders: either may pass
     */
    criteriaMode: {
      type: String,
      enum: CRITERIA_MODES,
      default: 'spend'
    },
    minLifetimeSpendInr: {
      type: Number,
      default: 0,
      min: 0
    },
    minOrderCount: {
      type: Number,
      default: 0,
      min: 0
    },
    /**
     * Tier precedence: lower number = better (1 = best / Gold, 2 = Silver, 3 = Bronze).
     * Matches natural podium ranking admins expect.
     */
    rank: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    color: {
      type: String,
      default: '#C9A227',
      trim: true,
      maxlength: 32
    },
    icon: {
      type: String,
      default: '',
      trim: true,
      maxlength: 80
    },
    /**
     * Optional cap on how many users may hold this badge at once.
     * null / undefined / 0 = unlimited.
     * When full, later qualifiers fall to the next-best matching badge.
     */
    maxMembers: {
      type: Number,
      default: null,
      min: 0
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  { timestamps: true }
);

loyaltyBadgeSchema.index({ isActive: 1, rank: 1 });
loyaltyBadgeSchema.index({ rank: 1 });

loyaltyBadgeSchema.statics.CRITERIA_MODES = CRITERIA_MODES;

module.exports = mongoose.model('LoyaltyBadge', loyaltyBadgeSchema);

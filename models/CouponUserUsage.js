/**
 * Per-user coupon usage counter — race-safe gate for perUserLimit.
 * Source of truth for "already used" checks also consults Orders; this collection
 * provides atomic $inc under concurrent checkouts within the same transaction.
 */
const mongoose = require('mongoose');

const couponUserUsageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    couponCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true
    },
    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Coupon',
      default: null
    },
    /** Slots currently claimed (active orders + in-flight consumes). */
    usageCount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  { timestamps: true }
);

couponUserUsageSchema.index({ userId: 1, couponCode: 1 }, { unique: true });

module.exports = mongoose.model('CouponUserUsage', couponUserUsageSchema);

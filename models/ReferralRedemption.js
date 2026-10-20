const mongoose = require('mongoose');

const STATUSES = ['reserved', 'completed', 'voided', 'clawed_back'];

const referralRedemptionSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      required: true,
      index: true
    },
    code: { type: String, required: true, uppercase: true, trim: true, index: true },
    referralCodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReferralCode',
      required: true,
      index: true
    },
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    refereeUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    orderId: { type: String, required: true, index: true },
    orderMongoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    discountInr: { type: Number, default: 0, min: 0 },
    discountType: { type: String, enum: ['percentage', 'fixed'], default: 'percentage' },
    discountValue: { type: Number, default: 0 },
    rewardPoints: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: STATUSES,
      default: 'reserved',
      index: true
    },
    rewardLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: 'LoyaltyPointLedger', default: null },
    clawbackLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: 'LoyaltyPointLedger', default: null },
    completedAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    clawedBackAt: { type: Date, default: null }
  },
  { timestamps: true }
);

referralRedemptionSchema.index({ orderId: 1 }, { unique: true });
/** One in-flight or finished referral per customer (voided rows can retry). */
referralRedemptionSchema.index(
  { storefront: 1, refereeUserId: 1 },
  {
    unique: true,
    name: 'storefront_referee_active_unique',
    partialFilterExpression: { status: { $in: ['reserved', 'completed', 'clawed_back'] } }
  }
);

module.exports = mongoose.model('ReferralRedemption', referralRedemptionSchema);
module.exports.STATUSES = STATUSES;

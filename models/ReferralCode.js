const mongoose = require('mongoose');

const referralCodeSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      required: true,
      index: true
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true
    },
    seq: { type: Number, required: true, min: 1 },
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    generatedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

referralCodeSchema.index({ storefront: 1, code: 1 }, { unique: true });
referralCodeSchema.index({ storefront: 1, ownerUserId: 1 }, { unique: true });

module.exports = mongoose.model('ReferralCode', referralCodeSchema);

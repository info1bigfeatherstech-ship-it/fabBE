/** Atomic RF-00N sequence per storefront. */
const mongoose = require('mongoose');

const referralCounterSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      required: true,
      unique: true
    },
    seq: { type: Number, default: 0, min: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReferralCounter', referralCounterSchema);

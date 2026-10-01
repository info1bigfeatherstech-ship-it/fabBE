const mongoose = require('mongoose');

/**
 * Per-storefront product-code prefix used on NEW listings only.
 * Existing product codes are never rewritten when this changes.
 * prefix is empty until an admin explicitly sets 2–3 letters (no silent default).
 */
const productCodePrefixSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      required: true,
      enum: ['ecomm', 'wholesale'],
      unique: true,
      index: true
    },
    /** 2–3 uppercase letters, or empty until configured. */
    prefix: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
      maxlength: 3
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ProductCodePrefixSettings', productCodePrefixSettingsSchema);

const mongoose = require('mongoose');

/**
 * Singleton storefront marketing badge for sale collections.
 * One document per storefront (ecomm). Label is admin-editable
 * (e.g. "Sale is live" → "Flash Sale"); products use ProductTag slug `on-sale`.
 */
const saleLiveSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      required: true,
      enum: ['ecomm'],
      unique: true,
      index: true,
      default: 'ecomm'
    },
    /** When false, header badge is hidden on the storefront. */
    enabled: { type: Boolean, default: true },
    /** Text shown on the header badge (admin-controlled). */
    label: {
      type: String,
      trim: true,
      maxlength: 48,
      default: 'Sale is live'
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SaleLiveSettings', saleLiveSettingsSchema);

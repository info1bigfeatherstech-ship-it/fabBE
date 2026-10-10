const mongoose = require('mongoose');

/**
 * Singleton-ish storefront marketing badge for festive collections.
 * One document per storefront (ecomm). Label is admin-editable
 * (e.g. "Navratri Special" → "Diwali Offers"); products use ProductTag
 * slug `festive-offer`.
 */
const festiveOfferSettingsSchema = new mongoose.Schema(
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
    enabled: { type: Boolean, default: false },
    /** Text shown on the header badge (admin-controlled). */
    label: {
      type: String,
      trim: true,
      maxlength: 48,
      default: 'Festive Offers'
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FestiveOfferSettings', festiveOfferSettingsSchema);

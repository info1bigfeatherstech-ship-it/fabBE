/**
 * Free Gift campaign offer.
 * When active, every order gets a "free gift" label (no min-cart requirement).
 * Admin fills gift name/number on each order internally; never shown to storefront.
 */
const mongoose = require('mongoose');

const freeGiftOfferSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    description: {
      type: String,
      default: '',
      maxlength: 500
    },
    /**
     * Optional auto-off date. Null = runs until admin manually deactivates.
     * Offer valid while now < endDate (if set).
     */
    endDate: {
      type: Date,
      default: null
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  { timestamps: true }
);

freeGiftOfferSchema.index({ isActive: 1, endDate: 1 });

module.exports = mongoose.model('FreeGiftOffer', freeGiftOfferSchema);

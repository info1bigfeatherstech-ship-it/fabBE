/**
 * Free-shipping campaign offer (auto-applied at checkout — not a coupon code).
 * At most one offer should be active at a time (enforced in controller/service).
 */
const mongoose = require('mongoose');

const freeShippingOfferSchema = new mongoose.Schema(
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
    /** Items subtotal threshold (INR). Shipping is not included in this check. */
    minCartValue: {
      type: Number,
      required: true,
      min: 0
    },
    /**
     * Optional auto-off date. Null/undefined = runs until admin deactivates.
     * Compared as end-of-day exclusive: offer valid while now < endDate (if set).
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

freeShippingOfferSchema.index({ isActive: 1, endDate: 1 });

module.exports = mongoose.model('FreeShippingOffer', freeShippingOfferSchema);

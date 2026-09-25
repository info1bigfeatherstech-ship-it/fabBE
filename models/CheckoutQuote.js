const mongoose = require('mongoose');

const checkoutQuoteSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    addressId: { type: mongoose.Schema.Types.ObjectId, ref: 'Address', required: true },
    postalCode: { type: String, required: true },
    couponCodeUpper: { type: String, default: '' },
    cartFingerprint: { type: String, required: true, index: true },
    userType: { type: String, enum: ['normal', 'wholesaler'], required: true },

    itemCount: { type: Number, required: true, min: 1 },
    itemsSubtotal: { type: Number, required: true, min: 0 },
    promotionDiscount: { type: Number, required: true, min: 0, default: 0 },
    /** Loyalty points redeemed on this quote (0 when disabled / not used). */
    loyaltyPointsRedeemed: { type: Number, default: 0, min: 0 },
    loyaltyDiscount: { type: Number, default: 0, min: 0 },
    deliveryCharges: { type: Number, required: true, min: 0, default: 0 },
    taxes: { type: Number, required: true, min: 0, default: 0 },
    amountPayable: { type: Number, required: true, min: 0 },

    shippingMeta: {
      isDeliverable: { type: Boolean, default: false },
      estimatedDays: { type: String, default: null },
      courierName: { type: String, default: null },
      courierCompanyId: { type: Number, default: null },
      shipmozoCourierId: { type: Number, default: null },
      shippingProvider: { type: String, enum: ['shiprocket', 'shipmozo', null], default: null },
      pickupsAutomaticallyScheduled: { type: Boolean, default: null },
      codAvailable: { type: Boolean, default: true },
      message: { type: String, default: null },
      mock: { type: Boolean, default: false },
      /** Courier split — admin/RTO/fulfillment; not shown as customer charge */
      freightInr: { type: Number, default: null },
      codFeeInr: { type: Number, default: null },
      /** Pre-waiver customer delivery (freight+COD fee) for UI strikethrough */
      originalDeliveryCharges: { type: Number, default: null },
      freeShippingApplied: { type: Boolean, default: false },
      freeShippingOffer: {
        offerId: { type: String, default: null },
        name: { type: String, default: null },
        minCartValue: { type: Number, default: null }
      }
    },

    /** Free-gift offer snapshot stored at quote time */
    freeGiftOffer: {
      offerId: { type: String, default: null },
      name: { type: String, default: null }
    },
    freeGiftApplied: { type: Boolean, default: false },

    totalWeightKg: { type: Number, default: null },
    dims: {
      lengthCm: { type: Number, default: null },
      widthCm: { type: Number, default: null },
      heightCm: { type: Number, default: null }
    },

    status: {
      type: String,
      enum: ['active', 'confirmed', 'consumed', 'expired', 'cancelled'],
      default: 'active',
      index: true
    },
    confirmedPaymentMethod: {
      type: String,
      enum: ['cod', 'online', ''],
      default: ''
    },
    confirmedPaymentPlan: {
      type: String,
      enum: ['full', 'advance'],
      default: 'full'
    },
    confirmedAdvancePercent: {
      type: Number,
      default: null
    },
    /** When plan is advance: balance collected online vs COD at delivery */
    confirmedBalanceCollection: {
      type: String,
      enum: ['', 'online', 'cod'],
      default: ''
    },
    quoteExpiresAt: { type: Date, required: true },
    confirmedAt: { type: Date, default: null },
    lastValidatedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

checkoutQuoteSchema.index({ userId: 1, createdAt: -1 });
checkoutQuoteSchema.index({ quoteExpiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('CheckoutQuote', checkoutQuoteSchema);

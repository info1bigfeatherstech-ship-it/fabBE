const mongoose = require('mongoose');

/**
 * Per-storefront leads push policy (admin-controlled auto reminders).
 * Cart and wishlist are independent so either can be toggled alone.
 */
const leadsPushSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      required: true,
      enum: ['ecomm', 'wholesale'],
      unique: true,
      index: true,
    },
    /** Daily auto cart-reminder push (users with cart + subscription). */
    autoPushEnabled: {
      type: Boolean,
      default: false,
    },
    /** Daily auto wishlist-reminder push (users with wishlist + subscription). */
    autoWishlistPushEnabled: {
      type: Boolean,
      default: false,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeadsPushSettings', leadsPushSettingsSchema);

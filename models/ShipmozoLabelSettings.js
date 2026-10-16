const mongoose = require('mongoose');

/**
 * Per-storefront Shipmozo shipping-label layout.
 * Ecomm admin writes storefront=ecomm; wholesale admin writes storefront=wholesale.
 * Applied when generating custom 4×6 shipping labels (Shipmozo default + Shiprocket when
 * admin chooses "Custom" on download). Provider (Shiprocket/Shipmozo) labels are separate.
 */
const shipmozoLabelSettingsSchema = new mongoose.Schema(
  {
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      required: true,
      unique: true,
      index: true
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ShipmozoLabelSettings', shipmozoLabelSettingsSchema);

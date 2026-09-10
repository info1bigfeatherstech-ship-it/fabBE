const mongoose = require('mongoose');

/**
 * Queued newly listed products awaiting a digest push in the next IST slot.
 * Slots: 11:00–13:00 and 16:00–19:00 Asia/Kolkata.
 */
const newProductDigestQueueSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      default: 'ecomm',
      index: true,
    },
    name: { type: String, default: '' },
    slug: { type: String, default: '' },
    imageUrl: { type: String, default: null },
    /** IST calendar date of the target slot, e.g. 2026-09-10 */
    targetDateKey: { type: String, required: true, index: true },
    /** morning = 11–13, evening = 16–19 */
    targetSlot: {
      type: String,
      enum: ['morning', 'evening'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'sent', 'skipped'],
      default: 'pending',
      index: true,
    },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

newProductDigestQueueSchema.index(
  { productId: 1, storefront: 1, targetDateKey: 1, targetSlot: 1 },
  { unique: true }
);
newProductDigestQueueSchema.index({ status: 1, targetDateKey: 1, targetSlot: 1 });

module.exports = mongoose.model('NewProductDigestQueue', newProductDigestQueueSchema);

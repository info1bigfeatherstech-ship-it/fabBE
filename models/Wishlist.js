const mongoose = require('mongoose');

const wishlistSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // ensure 1 wishlist per user
      index: true
    },

    products: [
      {
        productId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Product',
          required: true
        },
        variantId: {
          type: mongoose.Schema.Types.ObjectId,
          default: null
        },
        addedAt: {
          type: Date,
          default: Date.now
        }
      }
    ]
  },
  { timestamps: true }
);

wishlistSchema.index({ userId: 1, "products.productId": 1 });
module.exports = mongoose.model('Wishlist', wishlistSchema);
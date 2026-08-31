const mongoose = require("mongoose");

const productTagSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    tags: {
      type: [String],
      enum: ["on-sale", "today-arrival", "jewellery-spotted", "bestselling-jewelry"],
      default: []
    }
  },
  { timestamps: true }
);

// One tag document per product — prevents duplicate rows and inconsistent reads.
productTagSchema.index({ product: 1 }, { unique: true });
productTagSchema.index({ tags: 1 });

module.exports = mongoose.model("ProductTag", productTagSchema);
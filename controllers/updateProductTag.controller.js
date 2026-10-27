const Product = require("../models/Product");
const ProductTag = require("../models/ProductTag");
const cacheInvalidation = require("../services/cacheInvalidation.service");
const { mongoCatalogAnd } = require("../utils/storefrontCatalog");
const { MARKETING_TAG_SLUGS, ON_SALE_TAG } = require("../utils/productTagQuery");
const {
  productHasValidOnSalePrice,
  ON_SALE_PRICE_REQUIRED_MESSAGE,
} = require("../utils/variantPrice");

const CONTROLLED_FLAGS = MARKETING_TAG_SLUGS;

async function updateProductTagController(req, res) {
  try {
    const { slugs, flagType, value } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Slugs are required",
      });
    }

    const normalizedSlugs = [...new Set(
      slugs.map((s) => String(s || "").trim()).filter(Boolean)
    )];

    if (!normalizedSlugs.length) {
      return res.status(400).json({
        success: false,
        message: "At least one valid slug is required",
      });
    }

    if (!flagType || typeof flagType !== "string") {
      return res.status(400).json({
        success: false,
        message: "flagType is required",
      });
    }

    const normalizedFlag = String(flagType).trim().replace(/_/g, "-");

    if (!CONTROLLED_FLAGS.includes(normalizedFlag)) {
      return res.status(400).json({
        success: false,
        message: `Invalid flagType. Allowed: ${CONTROLLED_FLAGS.join(", ")}`,
      });
    }

    if (typeof value !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "value must be a boolean",
      });
    }

    const products = await Product.find({
      slug: { $in: normalizedSlugs },
    }).select("_id slug channelStatus status variants.price");

    if (!products.length) {
      return res.status(404).json({
        success: false,
        message: "No matching products found for the provided slugs",
      });
    }

    const skipped = [];
    let eligibleProducts = products;
    if (value === true && normalizedFlag === ON_SALE_TAG) {
      eligibleProducts = [];
      for (const product of products) {
        if (productHasValidOnSalePrice(product)) {
          eligibleProducts.push(product);
        } else {
          skipped.push({
            slug: product.slug,
            reason: ON_SALE_PRICE_REQUIRED_MESSAGE,
          });
        }
      }
      if (!eligibleProducts.length) {
        return res.status(400).json({
          success: false,
          message: ON_SALE_PRICE_REQUIRED_MESSAGE,
          skipped,
        });
      }
    }

    const results = await Promise.all(
      eligibleProducts.map(async (product) => {
        const existing = await ProductTag.findOne({
          product: product._id,
        });

        let updatedTags = Array.isArray(existing?.tags) ? [...existing.tags] : [];

        if (value) {
          if (!updatedTags.includes(normalizedFlag)) {
            updatedTags.push(normalizedFlag);
          }
        } else {
          updatedTags = updatedTags.filter((tag) => tag !== normalizedFlag);
        }

        return ProductTag.findOneAndUpdate(
          { product: product._id },
          { $set: { tags: updatedTags } },
          { new: true, upsert: true, runValidators: true }
        );
      })
    );

    const productIds = eligibleProducts.map((p) => p._id);

    try {
      await cacheInvalidation.onProductTagChange(productIds);
    } catch (cacheErr) {
      // Non-fatal: tags were persisted; storefront cache may be briefly stale.
      console.error("Product tag cache invalidation failed:", cacheErr.message);
    }

    const notStorefrontVisible = [];
    if (value === true) {
      for (const product of eligibleProducts) {
        const liveCount = await Product.countDocuments(
          mongoCatalogAnd("ecomm", { _id: product._id })
        );
        if (!liveCount) {
          notStorefrontVisible.push({
            slug: product.slug,
            reason: "Product is not live on the ecomm storefront (inactive channel or no visible variants).",
          });
        }
      }
    }

    const skippedCount = skipped.length;
    return res.status(200).json({
      success: true,
      message: skippedCount
        ? `Flag updated for ${results.length} product(s). ${skippedCount} skipped — add On-sale price first.`
        : "Flag updated successfully",
      flagType: normalizedFlag,
      value,
      updatedCount: results.length,
      slugs: eligibleProducts.map((p) => p.slug),
      skipped,
      notStorefrontVisible,
    });
  } catch (error) {
    console.error("updateProductTag error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Server error",
    });
  }
}

module.exports = updateProductTagController;

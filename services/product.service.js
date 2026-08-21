const Product = require("../models/Product");
const Category = require("../models/Category");

const searchProducts = async (filters) => {
  const query = {};
  query.status = { $in: ["active", "draft"] };

  // price filter
  if (filters?.price) {
    query["variants.price.base"] = { $lte: Number(filters.price) };
  }

  // category filter
  if (filters?.category) {
    const categoryDoc = await Category.findOne({
      name: new RegExp(filters.category, "i")
    });
    if (categoryDoc) {
      query.category = categoryDoc._id;
    }
  }

  // keyword filter — searches name, title, brand, description
  if (filters?.keyword) {
    query.$or = [
      { name: new RegExp(filters.keyword, "i") },
      { title: new RegExp(filters.keyword, "i") },
      { brand: new RegExp(filters.keyword, "i") },
      { description: new RegExp(filters.keyword, "i") }
    ];
  }

  // fallback — if neither category nor keyword matched anything useful
  // use the raw category string as keyword too
  if (!filters?.keyword && filters?.category && !query.category) {
    query.$or = [
      { name: new RegExp(filters.category, "i") },
      { title: new RegExp(filters.category, "i") },
      { brand: new RegExp(filters.category, "i") },
      { description: new RegExp(filters.category, "i") }
    ];
  }

  const products = await Product.find(query)
    .populate("category", "name")
    .limit(10)
    .lean();

  return products.map((p) => {
    const variant = p.variants?.[0];
    const basePrice = variant?.price?.base;
    const salePrice = variant?.price?.sale;

    return {
      _id: p._id,
      name: p.name,
      title: p.title,
      brand: p.brand,
      slug: p.slug,
      category: p.category?.name,
      image: variant?.images?.[0]?.url || null,
      price: salePrice ?? basePrice,
      originalPrice: salePrice ? basePrice : null,
      inStock: variant?.inventory?.quantity > 0,
      status: p.status
    };
  });
};

module.exports = searchProducts;

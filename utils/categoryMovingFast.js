const Category = require('../models/Category');

const MOVING_FAST_MAX = 4;

/**
 * Count categories currently flagged for the Moving Fast homepage section.
 * @param {import('mongoose').Types.ObjectId|string|null|undefined} excludeId
 */
async function countMovingFastCategories(excludeId = null) {
  const filter = {
    showInMovingFast: true,
    status: 'active',
  };
  if (excludeId) {
    filter._id = { $ne: excludeId };
  }
  return Category.countDocuments(filter);
}

/**
 * Assign the lowest free movingFastOrder slot (0..3).
 * @param {import('mongoose').Document} category
 */
async function assignMovingFastOrder(category) {
  const taken = await Category.find({
    showInMovingFast: true,
    _id: { $ne: category._id },
  })
    .select('movingFastOrder')
    .lean();

  const used = new Set(
    taken.map((row) => Number(row.movingFastOrder)).filter((n) => Number.isFinite(n))
  );

  for (let slot = 0; slot < MOVING_FAST_MAX; slot += 1) {
    if (!used.has(slot)) {
      category.movingFastOrder = slot;
      return slot;
    }
  }

  category.movingFastOrder = MOVING_FAST_MAX - 1;
  return category.movingFastOrder;
}

/**
 * Ensure enabling Moving Fast does not exceed the max slot count.
 * @param {import('mongoose').Types.ObjectId|string} categoryId
 */
async function assertMovingFastCapacity(categoryId) {
  const count = await countMovingFastCategories(categoryId);
  if (count >= MOVING_FAST_MAX) {
    const err = new Error(
      `Maximum ${MOVING_FAST_MAX} categories can appear in Moving Fast. Remove one before adding another.`
    );
    err.statusCode = 400;
    err.code = 'MOVING_FAST_LIMIT';
    throw err;
  }
}

function categoryHasDisplayImage(category) {
  const url =
    (typeof category?.image === 'string' && category.image.trim()) ||
    category?.image?.url ||
    category?.image?.secure_url ||
    '';
  return Boolean(String(url).trim());
}

module.exports = {
  MOVING_FAST_MAX,
  countMovingFastCategories,
  assignMovingFastOrder,
  assertMovingFastCapacity,
  categoryHasDisplayImage,
};

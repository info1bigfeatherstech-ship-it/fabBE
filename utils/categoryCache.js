const cacheService = require('../services/cache.service');
const cacheConfig = require('../config/cache.config');
const cacheInvalidation = require('../services/cacheInvalidation.service');

/**
 * Invalidate all category-related caches (list, moving-fast, detail, etc.).
 * Non-fatal: callers should still return success after DB writes.
 * @param {import('mongoose').Types.ObjectId|string|null|undefined} categoryId
 */
async function invalidateCategoryCaches(categoryId = null) {
  try {
    await cacheInvalidation.onCategoryChange(categoryId);
    return true;
  } catch (err) {
    console.error('Category cache invalidation failed:', err?.message || err);
    try {
      await cacheService.forget(`${cacheConfig.prefixes.CATEGORY}:*`);
    } catch (fallbackErr) {
      console.error('Category cache fallback invalidation failed:', fallbackErr?.message || fallbackErr);
    }
    return false;
  }
}

module.exports = {
  invalidateCategoryCaches,
};

const cacheService = require('./cache.service');
const cacheConfig = require('../config/cache.config');
const logger = require('../utils/logger');

class CacheInvalidationService {
  
  // Call when product is created/updated/deleted
  async onProductChange(productId, categoryId = null) {
    const patterns = cacheConfig.getInvalidationPatterns(productId, categoryId);
    const count = await cacheService.forgetMany(patterns);
    logger.info(`[Invalidation] Product changed: ${productId}, invalidated ${count} cache entries`);
    return count;
  }
  
  // Call when category is created/updated/deleted
  async onCategoryChange(categoryId) {
    const patterns = [
      `${cacheConfig.prefixes.CATEGORY}:*`,
      `${cacheConfig.prefixes.PRODUCT}:*`,
      `${cacheConfig.prefixes.SEARCH}:*`
    ];
    const count = await cacheService.forgetMany(patterns);
    logger.info(`[Invalidation] Category changed: ${categoryId}, invalidated ${count} cache entries`);
    return count;
  }
  
  // Call when bulk upload happens
  async onBulkUpload() {
    const count = await cacheService.flush();
    logger.info(`[Invalidation] Bulk upload, flushed ${count} cache entries`);
    return count;
  }
  
  // Call when order is placed (affects analytics)
  async onOrderPlaced() {
    const patterns = [`${cacheConfig.prefixes.ANALYTICS}:*`];
    const count = await cacheService.forgetMany(patterns);
    logger.info(`[Invalidation] Order placed, invalidated ${count} analytics cache`);
    return count;
  }
}

module.exports = new CacheInvalidationService();
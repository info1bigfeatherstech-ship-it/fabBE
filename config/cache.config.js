// Industry-standard cache configuration
const logger = require('../utils/logger');
const crypto = require('crypto');

class CacheConfig {
  constructor() {
    // TTL in seconds for different endpoints
    this.ttl = {
      // Product endpoints
      PRODUCT_LIST: 600,        // 10 minutes
      PRODUCT_DETAIL: 900,      // 15 minutes
      PRODUCT_SEARCH: 300,      // 5 minutes
      PRODUCT_CATEGORY: 600,    // 10 minutes
      PRODUCT_FEATURED: 900,    // 15 minutes
      PRODUCT_RELATED: 600,     // 10 minutes
      
      // Category endpoints
      CATEGORY_LIST: 1800,      // 30 minutes
      CATEGORY_DETAIL: 1800,    // 30 minutes
      
      // Analytics endpoints (admin only)
      ANALYTICS_DASHBOARD: 300, // 5 minutes
      ANALYTICS_USERS: 120,     // 2 minutes
      ANALYTICS_CARTS: 120,     // 2 minutes
      
      // Default
      DEFAULT: 300              // 5 minutes
    };
    
    // Cache key prefixes
    this.prefixes = {
      PRODUCT: 'p',
      CATEGORY: 'c',
      SEARCH: 's',
      ANALYTICS: 'a',
      USER: 'u'
    };
  }
  
  generateKey(prefix, params) {
    // ✅ FIX: Ensure all params are properly serialized
    // Sort params for consistent keys
    const sortedParams = {};
    
    // Explicitly copy all params to ensure they're included
    Object.keys(params).sort().forEach(key => {
      const value = params[key];
      // Include all values except undefined/null/empty string
      if (value !== undefined && value !== null && value !== '') {
        sortedParams[key] = value;
      }
    });
    
    // ✅ Add debug logging in development
    if (process.env.NODE_ENV !== 'production') {
      console.log('🔑 Generating cache key with params:', sortedParams);
    }
    
    // ✅ Use better hash - include full params string
    const paramsString = JSON.stringify(sortedParams);
    
    // Use crypto for better hash distribution
    const hash = crypto
      .createHash('md5')
      .update(paramsString)
      .digest('base64')
      .substring(0, 24)
      .replace(/[/+=]/g, '_');
    
    const cacheKey = `${this.prefixes[prefix] || 'x'}:${hash}`;
    
    if (process.env.NODE_ENV !== 'production') {
      console.log('Cache Key:');
  
      // console.log(`🔑 Cache Key: ${cacheKey} (from: ${paramsString.substring(0, 50)}...)`);
    }
    
    return cacheKey;
  }
  
  getTTL(endpointType) {
    return this.ttl[endpointType] || this.ttl.DEFAULT;
  }
  
  // Invalidation patterns
  getInvalidationPatterns(productId, categoryId) {
    const patterns = [];
    
    if (productId) {
      patterns.push(`${this.prefixes.PRODUCT}:*`);
      patterns.push(`${this.prefixes.SEARCH}:*`);
    }
    
    if (categoryId) {
      patterns.push(`${this.prefixes.CATEGORY}:*`);
      patterns.push(`${this.prefixes.PRODUCT}:*`);
    }
    
    // Always invalidate lists
    patterns.push(`${this.prefixes.PRODUCT}:*`);
    patterns.push(`${this.prefixes.SEARCH}:*`); 
    return patterns;
  }
}

module.exports = new CacheConfig();
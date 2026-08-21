const cacheService = require('../services/cache.service');
const cacheConfig = require('../config/cache.config');
const logger = require('../utils/logger');
const { setApiCacheHeaders } = require('../utils/apiCacheHeaders');

/**
 * Generic cache middleware factory
 * @param {string} endpointType - Type of endpoint (PRODUCT_LIST, CATEGORY_LIST, etc.)
 * @param {Function} keyGenerator - Function that generates cache key from req
 */
const cacheMiddleware = (endpointType, keyGenerator) => {
  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }
    
    // Skip cache for authenticated user-specific data
    if (req.userId && endpointType === 'USER_SPECIFIC') {
      return next();
    }
    
    const cacheKey = keyGenerator(req);
    const ttl = cacheConfig.getTTL(endpointType);
    
    try {
      const cachedData = await cacheService.get(cacheKey);
      
      if (cachedData) {
        res.setHeader('X-Cache', 'HIT');
        setApiCacheHeaders(res);
        return res.json(cachedData);
      }
      
      // Intercept JSON body once — safer than leaving a patched res.json if headers already sent
      const originalJson = res.json.bind(res);

      res.json = function cacheCaptureJson(data) {
        if (res.headersSent) {
          return originalJson(data);
        }
        res.json = originalJson;

        if (data && data.success !== false) {
          cacheService.set(cacheKey, data, ttl).catch((err) => {
            logger.error(`[Cache] Failed to cache: ${err.message}`);
          });
        }

        res.setHeader('X-Cache', 'MISS');
        setApiCacheHeaders(res);

        return originalJson(data);
      };
      
      next();
      
    } catch (error) {
      logger.error(`[Cache] Middleware error: ${error.message}`);
      next();
    }
  };
};

// Pre-defined key generators for different endpoints
const keyGenerators = {
  // Product endpoints
  productList: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      page: req.query.page || 1,
      limit: req.query.limit || 12,
      category: req.query.category,
      featured: req.query.featured,
      q: req.query.q,
      userType: req.userType || 'user'
    });
  },
  
  productDetail: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      slug: req.params.slug,
      userType: req.userType || 'user'
    });
  },
  
  productSearch: (req) => {
    return cacheConfig.generateKey('SEARCH', {
      q: req.query.q,
      page: req.query.page || 1,
      limit: req.query.limit || 12,
      userType: req.userType || 'user'
    });
  },
  
  productCategory: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      slug: req.params.slug,
      page: req.query.page || 1,
      limit: req.query.limit || 12,
      userType: req.userType || 'user'
    });
  },
  
  productFeatured: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      featured: true,
      limit: req.query.limit || 12,
      userType: req.userType || 'user'
    });
  },
  
  productRelated: (req) => {
    return cacheConfig.generateKey('PRODUCT', {
      related: req.params.slug,
      limit: req.query.limit || 8,
      userType: req.userType || 'user'
    });
  },
  
  // Category endpoints
  categoryList: (req) => {
    return cacheConfig.generateKey('CATEGORY', {
      all: true
    });
  },
  
  categoryDetail: (req) => {
    return cacheConfig.generateKey('CATEGORY', {
      id: req.params.id
    });
  },
  
  // Analytics endpoints
  analyticsDashboard: (req) => {
    return cacheConfig.generateKey('ANALYTICS', {
      dashboard: true
    });
  },
  
  analyticsUsers: (req) => {
    return cacheConfig.generateKey('ANALYTICS', {
      users: true,
      page: req.query.page || 1,
      limit: req.query.limit || 20,
      search: req.query.search,
      role: req.query.role
    });
  },
  
  analyticscarts: (req) => {
    return cacheConfig.generateKey('ANALYTICS', {
      carts: true,
      page: req.query.page || 1,
      limit: req.query.limit || 20,
      sortBy: req.query.sortBy,
      order: req.query.order
    });
  }
};

module.exports = { cacheMiddleware, keyGenerators };
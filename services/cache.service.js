const redisManager = require('../config/redis.config');
const cacheConfig = require('../config/cache.config');
const logger = require('../utils/logger');

class CacheService {
  constructor() {
    this.enabled = true;
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0
    };
  }
  
  async get(key) {
    if (!this.isAvailable()) return null;
    
    try {
      const startTime = Date.now();
      const data = await redisManager.getClient().get(key);
      const duration = Date.now() - startTime;
      
      if (data) {
        this.stats.hits++;
        if (duration > 10) {
          logger.debug(`[Cache] HIT: ${key} (${duration}ms)`);
        }
        return JSON.parse(data);
      }
      
      this.stats.misses++;
      return null;
      
    } catch (error) {
      this.stats.errors++;
      logger.error(`[Cache] Get error: ${error.message}`);
      return null;
    }
  }
  
  async set(key, data, ttl = 600) {
    if (!this.isAvailable()) return false;
    
    try {
      await redisManager.getClient().setEx(key, ttl, JSON.stringify(data));
      logger.debug(`[Cache] SET: ${key} (TTL: ${ttl}s)`);
      return true;
    } catch (error) {
      this.stats.errors++;
      logger.error(`[Cache] Set error: ${error.message}`);
      return false;
    }
  }
  
  async remember(key, ttl, callback) {
    // Try to get from cache
    const cached = await this.get(key);
    if (cached !== null) {
      return cached;
    }
    
    // Execute callback and cache result
    const data = await callback();
    if (data) {
      await this.set(key, data, ttl);
    }
    return data;
  }
  
  async forget(pattern) {
    if (!this.isAvailable()) return 0;
    
    try {
      const client = redisManager.getClient();
      const keys = await client.keys(pattern);
      
      if (keys.length > 0) {
        await client.del(keys);
        logger.info(`[Cache] Invalidated ${keys.length} keys matching: ${pattern}`);
        return keys.length;
      }
      return 0;
    } catch (error) {
      logger.error(`[Cache] Invalidate error: ${error.message}`);
      return 0;
    }
  }
  
  async forgetMany(patterns) {
    let total = 0;
    for (const pattern of patterns) {
      total += await this.forget(pattern);
    }
    return total;
  }
  
  async flush() {
    if (!this.isAvailable()) return 0;
    
    try {
      const client = redisManager.getClient();
      const keys = await client.keys('*');
      
      if (keys.length > 0) {
        await client.del(keys);
        logger.info(`[Cache] Flushed ALL ${keys.length} cache keys`);
        return keys.length;
      }
      return 0;
    } catch (error) {
      logger.error(`[Cache] Flush error: ${error.message}`);
      return 0;
    }
  }
  
  isAvailable() {
    return this.enabled && redisManager.isReady();
  }
  
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total * 100).toFixed(2) : 0;
    
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      errors: this.stats.errors,
      hitRate: `${hitRate}%`,
      available: this.isAvailable()
    };
  }
  
  resetStats() {
    this.stats = { hits: 0, misses: 0, errors: 0 };
  }
}

module.exports = new CacheService();
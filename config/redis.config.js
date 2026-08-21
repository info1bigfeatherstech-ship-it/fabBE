

const redis = require('redis');
const logger = require('../utils/logger');

class RedisManager {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 3;
  }

  async connect() {
    try {
      this.client = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > this.maxRetries) {
              logger.error('[Redis] Max reconnection attempts reached');
              return new Error('Max reconnection attempts reached');
            }
            this.connectionAttempts = retries;
            logger.warn(`[Redis] Reconnection attempt ${retries}`);
            return Math.min(retries * 100, 3000);
          },
          connectTimeout: 10000,
          keepAlive: 30000,
        },
        disableOfflineQueue: true,
        lazyConnect: false,
      });

      this.client.on('connect', () => {
        logger.info('[Redis] Client connected');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('ready', () => {
        logger.info('[Redis] Client ready for operations');
      });

      this.client.on('error', (err) => {
        logger.error(`[Redis] Client error: ${err.message}`);
        this.isConnected = false;
        // Don't crash the app on Redis errors
        if (process.env.NODE_ENV === 'production') {
          // Send alert to monitoring system
          this.sendAlertToMonitoring('Redis connection error', err);
        }
      });

      this.client.on('end', () => {
        logger.warn('[Redis] Connection ended');
        this.isConnected = false;
      });

      await this.client.connect();
      logger.info('[Redis] Connected successfully');
      return this.client;
    } catch (error) {
      logger.error(`[Redis] Connection failed: ${error.message}`);
      this.isConnected = false;
      
      // Don't throw - allow app to run without Redis in development
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }
      return null;
    }
  }

  async disconnect() {
    if (this.client && this.client.isOpen) {
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Redis disconnect timeout')), 5000)
      );
      
      await Promise.race([
        this.client.quit(),
        timeout
      ]).catch(err => {
        logger.error(`[Redis] Force closing connection: ${err.message}`);
        return this.client.disconnect();
      });
      
      this.isConnected = false;
      logger.info('[Redis] Disconnected gracefully');
    }
  }

  getClient() {
    return this.client;
  }

  /**
   * Safe client for token blacklist and similar (null when Redis is down / not connected).
   * Prefer this over destructuring a non-existent `redisClient` export.
   */
  getRedisClient() {
    return this.client && this.client.isOpen ? this.client : null;
  }

  isReady() {
    return this.isConnected && this.client && this.client.isOpen;
  }

  sendAlertToMonitoring(message, error) {
    // Integrate with your monitoring system (Datadog, NewRelic, etc.)
    if (process.env.DATADOG_API_KEY) {
      // Send to Datadog
      // Implementation depends on your monitoring setup
    }
  }
}

module.exports = new RedisManager();
/**
 * Cleanup Service
 * Handles periodic database cleanup tasks
 * 
 * @version 1.0.0
 */

const User = require('../models/User');

class CleanupService {
  constructor() {
    this.interval = null;
    this.isRunning = false;
  }

  /**
   * Remove expired refresh tokens from all users
   * Only deletes tokens where expiresAt < current time
   */
  async cleanupExpiredRefreshTokens() {
    if (this.isRunning) {
      console.log('🧹 [Cleanup] Previous cleanup still running, skipping...');
      return;
    }

    this.isRunning = true;
    
    try {
      const now = new Date();
      
      const result = await User.updateMany(
        {},  // Apply to all users
        { 
          $pull: { 
            refreshTokens: { 
              expiresAt: { $lt: now } 
            } 
          } 
        }
      );
      
      if (result.modifiedCount > 0) {
        console.log(`🧹 [Cleanup] Removed expired tokens from ${result.modifiedCount} users`);
      }
      
      return result.modifiedCount;
    } catch (error) {
      console.error('❌ [Cleanup] Refresh token cleanup failed:', error.message);
      return 0;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start cleanup scheduler
   */
  start() {
    if (this.interval) {
      console.log('🧹 [Cleanup] Service already running');
      return;
    }

    // Run once on startup (cleans already expired tokens)
    this.cleanupExpiredRefreshTokens();
    
    // Then run every 24 hours
    this.interval = setInterval(() => {
      this.cleanupExpiredRefreshTokens();
    }, 24 * 60 * 60 * 1000);
    
    console.log('🧹 [Cleanup] Service started (runs every 24 hours)');
  }

  /**
   * Stop cleanup scheduler (for graceful shutdown)
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('🧹 [Cleanup] Service stopped');
    }
  }
}

module.exports = new CleanupService();
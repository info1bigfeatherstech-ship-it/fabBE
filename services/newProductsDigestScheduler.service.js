const logger = require('../utils/logger');
const { maybeRunDigestForNow, isPushConfigured, envDigestEnabled } = require('./newProductsDigest.service');

class NewProductsDigestSchedulerService {
  constructor() {
    this.interval = null;
    this.isRunning = false;
  }

  async maybeRun() {
    if (this.isRunning) return { skipped: true, reason: 'IN_PROGRESS' };
    if (!envDigestEnabled() || !isPushConfigured()) {
      return { skipped: true, reason: 'DISABLED_OR_UNCONFIGURED' };
    }

    this.isRunning = true;
    try {
      // Idempotent via queue status pending → sent inside sendDigestForSlot
      return await maybeRunDigestForNow(new Date());
    } catch (err) {
      logger.error('[newProductsDigestScheduler] run failed', {
        message: err?.message || String(err),
      });
      return { skipped: true, reason: 'ERROR', message: err?.message };
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    if (this.interval) return;
    const scanMinutes = Math.min(
      30,
      Math.max(5, Number(process.env.NEW_PRODUCTS_DIGEST_SCAN_MINUTES || 10))
    );
    const tick = () => {
      this.maybeRun().catch((err) => {
        logger.error('[newProductsDigestScheduler] tick failed', {
          message: err?.message || String(err),
        });
      });
    };
    tick();
    this.interval = setInterval(tick, scanMinutes * 60 * 1000);
    logger.info('[newProductsDigestScheduler] started', { scanMinutes });
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

module.exports = new NewProductsDigestSchedulerService();

const logger = require('../utils/logger');
const { isPushConfigured, sendAutoWishlistReminderPushes, getWishlistAutoHourIst } =
  require('./wishlistReminderPush.service');
const leadsPushSettingsService = require('./leadsPushSettings.service');
const {
  getIstCalendarParts,
  isWishlistReminderDayIst,
  wishlistReminderDaysLabel,
} = require('../utils/reminderPushSchedule');

class WishlistReminderPushSchedulerService {
  constructor() {
    this.interval = null;
    this.isRunning = false;
    this.lastAutoRunDateKey = null;
  }

  async maybeRunAutoPush() {
    if (this.isRunning) {
      return { skipped: true, reason: 'IN_PROGRESS' };
    }
    if (!isPushConfigured()) return { skipped: true, reason: 'PUSH_NOT_CONFIGURED' };

    const enabled = await leadsPushSettingsService.isAutoWishlistPushEnabled('ecomm');
    if (!enabled) return { skipped: true, reason: 'AUTO_DISABLED' };

    const { hour, dateKey, weekdayName } = getIstCalendarParts();
    const targetHour = getWishlistAutoHourIst();

    if (!isWishlistReminderDayIst()) {
      return {
        skipped: true,
        reason: 'NOT_SCHEDULED_WEEKDAY',
        weekdayName,
        allowedDays: wishlistReminderDaysLabel(),
      };
    }

    if (hour !== targetHour) {
      return { skipped: true, reason: 'NOT_SCHEDULED_HOUR', hour, targetHour };
    }
    if (this.lastAutoRunDateKey === dateKey) {
      return { skipped: true, reason: 'ALREADY_RAN_TODAY' };
    }

    this.isRunning = true;
    try {
      const result = await sendAutoWishlistReminderPushes({
        scopeQuery: { userType: 'user' },
      });
      this.lastAutoRunDateKey = dateKey;
      return result;
    } catch (err) {
      logger.error('[wishlistReminderPushScheduler] auto run failed', {
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
      60,
      Math.max(5, Number(process.env.WISHLIST_REMINDER_PUSH_AUTO_SCAN_MINUTES || 15))
    );
    const tick = () => {
      this.maybeRunAutoPush().catch((err) => {
        logger.error('[wishlistReminderPushScheduler] tick failed', {
          message: err?.message || String(err),
        });
      });
    };
    tick();
    this.interval = setInterval(tick, scanMinutes * 60 * 1000);
    logger.info('[wishlistReminderPushScheduler] started', {
      scanMinutes,
      hourIst: getWishlistAutoHourIst(),
      weekdaysIst: wishlistReminderDaysLabel(),
    });
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

module.exports = new WishlistReminderPushSchedulerService();

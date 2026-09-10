const logger = require('../utils/logger');
const { isPushConfigured, sendAutoCartReminderPushes } = require('./cartReminderPush.service');
const leadsPushSettingsService = require('./leadsPushSettings.service');
const {
  getIstCalendarParts,
  isCartReminderDayIst,
  cartReminderDaysLabel,
} = require('../utils/reminderPushSchedule');

function getAutoRunHour() {
  return leadsPushSettingsService.getAutoPushHourIst();
}

class CartReminderPushSchedulerService {
  constructor() {
    this.interval = null;
    this.isRunning = false;
    this.lastAutoRunDateKey = null;
  }

  async maybeRunAutoPush() {
    if (this.isRunning) {
      logger.debug('[cartReminderPushScheduler] previous run in progress, skip');
      return { skipped: true, reason: 'IN_PROGRESS' };
    }

    if (!isPushConfigured()) return { skipped: true, reason: 'PUSH_NOT_CONFIGURED' };

    // Per-storefront toggles: ecomm path unchanged; wholesale only when its auto setting is on.
    const ecommEnabled = await leadsPushSettingsService.isAutoPushEnabled('ecomm');
    const wholesaleEnabled = await leadsPushSettingsService.isAutoPushEnabled('wholesale');
    if (!ecommEnabled && !wholesaleEnabled) {
      return { skipped: true, reason: 'AUTO_DISABLED' };
    }

    const { hour, dateKey, weekdayName } = getIstCalendarParts();
    const targetHour = getAutoRunHour();

    if (!isCartReminderDayIst()) {
      return {
        skipped: true,
        reason: 'NOT_SCHEDULED_WEEKDAY',
        weekdayName,
        allowedDays: cartReminderDaysLabel(),
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
      const results = { ecomm: null, wholesale: null };

      if (ecommEnabled) {
        results.ecomm = await sendAutoCartReminderPushes({
          scopeQuery: { userType: 'user' },
          storefront: 'ecomm',
        });
      }

      if (wholesaleEnabled) {
        results.wholesale = await sendAutoCartReminderPushes({
          scopeQuery: { userType: 'wholesaler' },
          storefront: 'wholesale',
        });
      }

      this.lastAutoRunDateKey = dateKey;
      return results;
    } catch (err) {
      logger.error('[cartReminderPushScheduler] auto run failed', {
        message: err?.message || String(err),
      });
      return { failed: true, message: err?.message || String(err) };
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    if (this.interval) {
      logger.info('[cartReminderPushScheduler] already running');
      return;
    }

    const scanMinutes = Math.min(60, Math.max(5, Number(process.env.CART_REMINDER_PUSH_AUTO_SCAN_MINUTES || 15)));
    const scanMs = scanMinutes * 60 * 1000;

    this.maybeRunAutoPush();
    this.interval = setInterval(() => {
      this.maybeRunAutoPush();
    }, scanMs);

    logger.info('[cartReminderPushScheduler] started', {
      scanMinutes,
      autoHourIst: getAutoRunHour(),
      weekdaysIst: cartReminderDaysLabel(),
      autoEnabledSource: 'admin_leads_push_settings',
    });
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('[cartReminderPushScheduler] stopped');
    }
  }
}

module.exports = new CartReminderPushSchedulerService();

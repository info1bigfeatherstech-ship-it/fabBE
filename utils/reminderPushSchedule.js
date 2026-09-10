/**
 * Cart / wishlist auto-push calendar (Asia/Kolkata).
 * Not daily — only these weekdays at the configured hour:
 *   Cart:     Tuesday, Friday, Saturday
 *   Wishlist: Thursday, Sunday
 */

const CART_WEEKDAYS_IST = new Set([2, 5, 6]); // Tue, Fri, Sat (Sun=0)
const WISHLIST_WEEKDAYS_IST = new Set([0, 4]); // Sun, Thu

function getIstCalendarParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(now);
  const map = Object.fromEntries(
    parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );

  const weekdayName = String(map.weekday || '').slice(0, 3).toLowerCase();
  const weekdayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const weekday = weekdayMap[weekdayName];

  return {
    hour: Number(map.hour),
    dateKey: `${map.year}-${map.month}-${map.day}`,
    weekday: Number.isInteger(weekday) ? weekday : -1,
    weekdayName,
  };
}

function isCartReminderDayIst(now = new Date()) {
  const { weekday } = getIstCalendarParts(now);
  return CART_WEEKDAYS_IST.has(weekday);
}

function isWishlistReminderDayIst(now = new Date()) {
  const { weekday } = getIstCalendarParts(now);
  return WISHLIST_WEEKDAYS_IST.has(weekday);
}

function cartReminderDaysLabel() {
  return 'Tue · Fri · Sat';
}

function wishlistReminderDaysLabel() {
  return 'Thu · Sun';
}

module.exports = {
  CART_WEEKDAYS_IST,
  WISHLIST_WEEKDAYS_IST,
  getIstCalendarParts,
  isCartReminderDayIst,
  isWishlistReminderDayIst,
  cartReminderDaysLabel,
  wishlistReminderDaysLabel,
};

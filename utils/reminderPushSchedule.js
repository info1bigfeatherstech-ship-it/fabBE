/**
 * Cart / wishlist auto-push calendar (Asia/Kolkata).
 * Single source of truth for schedulers + admin Leads UI labels.
 *
 * Defaults (override via env CSV of weekday numbers, Sun=0 … Sat=6):
 *   CART_REMINDER_PUSH_WEEKDAYS_IST=2,5,6        → Tue, Fri, Sat
 *   WISHLIST_REMINDER_PUSH_WEEKDAYS_IST=0,4      → Sun, Thu
 */

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseWeekdaySet(envValue, fallbackList) {
  const raw = String(envValue || '').trim();
  if (!raw) return new Set(fallbackList);
  const parts = raw
    .split(/[,|\s]+/)
    .map((p) => Number(String(p).trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return parts.length ? new Set(parts) : new Set(fallbackList);
}

const CART_WEEKDAYS_IST = parseWeekdaySet(
  process.env.CART_REMINDER_PUSH_WEEKDAYS_IST,
  [2, 5, 6]
);
const WISHLIST_WEEKDAYS_IST = parseWeekdaySet(
  process.env.WISHLIST_REMINDER_PUSH_WEEKDAYS_IST,
  [0, 4]
);

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

/** Sorted short labels matching the Sets used by schedulers (e.g. "Tue · Fri · Sat"). */
function formatWeekdaySetLabel(daySet) {
  const ordered = [...daySet].filter((n) => n >= 0 && n <= 6).sort((a, b) => a - b);
  if (!ordered.length) return '—';
  return ordered.map((d) => WEEKDAY_SHORT[d]).join(' · ');
}

function cartReminderDaysLabel() {
  return formatWeekdaySetLabel(CART_WEEKDAYS_IST);
}

function wishlistReminderDaysLabel() {
  return formatWeekdaySetLabel(WISHLIST_WEEKDAYS_IST);
}

function formatIstHourLabel(hour) {
  const h = Math.floor(Number(hour));
  if (!Number.isFinite(h) || h < 0 || h > 23) return '—';
  if (h === 0) return '12:00 AM IST';
  if (h === 12) return '12:00 PM IST';
  if (h < 12) return `${h}:00 AM IST`;
  return `${h - 12}:00 PM IST`;
}

/** Human line for admin UI: "Tue · Fri · Sat · 5:00 PM IST" */
function formatScheduleSummary(daysLabel, hourIst) {
  const days = String(daysLabel || '').trim() || '—';
  const time = formatIstHourLabel(hourIst);
  if (days === '—' && time === '—') return '—';
  return `${days} · ${time}`;
}

module.exports = {
  CART_WEEKDAYS_IST,
  WISHLIST_WEEKDAYS_IST,
  getIstCalendarParts,
  isCartReminderDayIst,
  isWishlistReminderDayIst,
  cartReminderDaysLabel,
  wishlistReminderDaysLabel,
  formatIstHourLabel,
  formatScheduleSummary,
};

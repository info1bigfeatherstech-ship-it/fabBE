/**
 * IST slot helpers for new-products digest.
 * Windows: 11:00–13:00 (morning), 16:00–19:00 (evening).
 * Primary fire: 11:00 / 16:00. Late evening flush: 18:35+ (after wishlist @18).
 * Blackout for new-product sends: 17:00–18:34 (cart @17, wishlist @18).
 */
function getIstParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    dateKey: `${map.year}-${map.month}-${map.day}`,
  };
}

function addIstDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d + days, 6, 30, 0);
  return getIstParts(new Date(utc)).dateKey;
}

/**
 * Next digest slot after listing time.
 * - Before 11 → morning today
 * - Inside 11–13 → morning today (digest may still flush at 11–12)
 * - 13:00–18:59 → evening today (flush @16 and late @18:35)
 * - From 19:00 → morning tomorrow
 */
function resolveNextDigestSlot(now = new Date()) {
  const { hour, dateKey } = getIstParts(now);

  if (hour < 11) {
    return { dateKey, slot: 'morning', fireHour: 11 };
  }
  if (hour >= 11 && hour < 13) {
    return { dateKey, slot: 'morning', fireHour: 11 };
  }
  if (hour >= 13 && hour < 19) {
    return { dateKey, slot: 'evening', fireHour: 16 };
  }
  return {
    dateKey: addIstDays(dateKey, 1),
    slot: 'morning',
    fireHour: 11,
  };
}

function slotFireHour(slot) {
  return slot === 'evening' ? 16 : 11;
}

function isWithinSlotWindow(slot, hour) {
  if (slot === 'morning') return hour >= 11 && hour < 13;
  if (slot === 'evening') return hour >= 16 && hour < 19;
  return false;
}

/**
 * Whether scheduler should attempt a digest send right now for this slot.
 */
function shouldFireDigestNow(slot, now = new Date()) {
  const { hour, minute, dateKey } = getIstParts(now);
  if (slot === 'morning') {
    // 11:00–12:59 — flush pending (covers mid-morning listings)
    return isWithinSlotWindow('morning', hour)
      ? { fire: true, dateKey }
      : { fire: false, dateKey };
  }
  if (slot === 'evening') {
    // Primary: 16:00–16:59. Late flush after wishlist: 18:35–18:59.
    if (hour === 16) return { fire: true, dateKey };
    if (hour === 18 && minute >= 35) return { fire: true, dateKey };
    return { fire: false, dateKey };
  }
  return { fire: false, dateKey };
}

module.exports = {
  getIstParts,
  addIstDays,
  resolveNextDigestSlot,
  slotFireHour,
  isWithinSlotWindow,
  shouldFireDigestNow,
};

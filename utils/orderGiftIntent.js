/**
 * Checkout order intent: my_order (default) vs gift/other.
 * Snapshot stored on Order at place-time; optional gift fields when gift_other.
 * Does not affect pricing, shipping, or payment.
 *
 * Occasion is free text (frontend owns any dropdown labels). Backend only
 * sanitizes + enforces max length — no fixed occasion enum.
 */

const ORDER_INTENT_TYPES = Object.freeze(['my_order', 'gift_other']);

const NAME_MAX = 80;
const MESSAGE_MAX = 1000;
/** Free-text occasion label from customer / FE (not an enum). */
const OCCASION_MAX = 80;

const DEFAULT_ORDER_INTENT = Object.freeze({
  type: 'my_order',
  giftDetails: null
});

function stripControlChars(value) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '');
}

function normalizeOptionalText(raw, maxLen) {
  const s = stripControlChars(raw).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, maxLen);
}

function emptyGiftDetails() {
  return {
    recipientName: null,
    senderName: null,
    message: null,
    occasion: null
  };
}

function toPublicOrderIntent(doc) {
  if (!doc || typeof doc !== 'object') {
    return {
      type: 'my_order',
      giftDetails: null
    };
  }
  const type = ORDER_INTENT_TYPES.includes(doc.type) ? doc.type : 'my_order';
  if (type !== 'gift_other') {
    return { type: 'my_order', giftDetails: null };
  }
  const g = doc.giftDetails && typeof doc.giftDetails === 'object' ? doc.giftDetails : {};
  return {
    type: 'gift_other',
    giftDetails: {
      recipientName: g.recipientName || null,
      senderName: g.senderName || null,
      message: g.message || null,
      occasion: g.occasion || null
    }
  };
}

/**
 * Normalize + validate client payload for create/update.
 * Missing / null / {} → my_order (backward compatible).
 *
 * @param {unknown} raw
 * @param {{ requireExplicitType?: boolean }} [opts]
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[], code: string }}
 */
function parseOrderIntentInput(raw, opts = {}) {
  if (raw == null || raw === '') {
    if (opts.requireExplicitType) {
      return {
        ok: false,
        code: 'ORDER_INTENT_REQUIRED',
        errors: ['orderIntent is required']
      };
    }
    return { ok: true, value: { ...DEFAULT_ORDER_INTENT } };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'ORDER_INTENT_INVALID',
      errors: ['orderIntent must be an object']
    };
  }

  const typeRaw = raw.type != null ? String(raw.type).trim().toLowerCase() : 'my_order';
  if (!ORDER_INTENT_TYPES.includes(typeRaw)) {
    return {
      ok: false,
      code: 'ORDER_INTENT_TYPE_INVALID',
      errors: [`orderIntent.type must be one of: ${ORDER_INTENT_TYPES.join(', ')}`]
    };
  }

  if (typeRaw === 'my_order') {
    return {
      ok: true,
      value: {
        type: 'my_order',
        giftDetails: null
      }
    };
  }

  const detailsRaw =
    raw.giftDetails != null && typeof raw.giftDetails === 'object' && !Array.isArray(raw.giftDetails)
      ? raw.giftDetails
      : raw;

  const errors = [];
  const recipientName = normalizeOptionalText(detailsRaw.recipientName, NAME_MAX);
  const senderName = normalizeOptionalText(detailsRaw.senderName, NAME_MAX);
  const message = normalizeOptionalText(detailsRaw.message, MESSAGE_MAX);
  const occasion = normalizeOptionalText(detailsRaw.occasion, OCCASION_MAX);

  if (detailsRaw.recipientName != null && String(detailsRaw.recipientName).trim() !== '' && !recipientName) {
    errors.push('recipientName is invalid');
  }
  if (detailsRaw.senderName != null && String(detailsRaw.senderName).trim() !== '' && !senderName) {
    errors.push('senderName is invalid');
  }
  if (detailsRaw.message != null && String(detailsRaw.message).trim() !== '' && !message) {
    errors.push('message is invalid');
  }
  if (detailsRaw.occasion != null && String(detailsRaw.occasion).trim() !== '' && !occasion) {
    errors.push('occasion is invalid');
  }
  if (
    detailsRaw.occasion != null &&
    String(detailsRaw.occasion).trim().length > OCCASION_MAX
  ) {
    errors.push(`occasion must be at most ${OCCASION_MAX} characters`);
  }

  if (errors.length) {
    return { ok: false, code: 'ORDER_INTENT_VALIDATION_FAILED', errors };
  }

  return {
    ok: true,
    value: {
      type: 'gift_other',
      giftDetails: {
        recipientName,
        senderName,
        message,
        occasion
      }
    }
  };
}

/** Stable shape for idempotency request hash (sorted keys via fixed order). */
function orderIntentForIdempotencyHash(intent) {
  const publicIntent = toPublicOrderIntent(intent);
  if (publicIntent.type !== 'gift_other') {
    return { type: 'my_order' };
  }
  const g = publicIntent.giftDetails || emptyGiftDetails();
  return {
    type: 'gift_other',
    recipientName: g.recipientName || '',
    senderName: g.senderName || '',
    message: g.message || '',
    occasion: g.occasion || ''
  };
}

function getGiftIntentOptions() {
  return {
    types: [
      { value: 'my_order', label: 'My order', default: true },
      { value: 'gift_other', label: 'Gift / Other order', default: false }
    ],
    /** FE owns occasion labels/dropdown; backend accepts any sanitized free text. */
    occasions: [],
    fields: {
      recipientName: { required: false, maxLength: NAME_MAX },
      senderName: { required: false, maxLength: NAME_MAX },
      message: { required: false, maxLength: MESSAGE_MAX },
      occasion: { required: false, maxLength: OCCASION_MAX, freeText: true }
    },
    notes: [
      'Default is my_order when orderIntent is omitted (backward compatible).',
      'All giftDetails fields are optional when type is gift_other.',
      'occasion is free text (maxLength enforced); frontend may offer its own dropdown.',
      'orderIntent does not affect price, shipping, or payment.'
    ]
  };
}

module.exports = {
  ORDER_INTENT_TYPES,
  NAME_MAX,
  MESSAGE_MAX,
  OCCASION_MAX,
  DEFAULT_ORDER_INTENT,
  emptyGiftDetails,
  toPublicOrderIntent,
  parseOrderIntentInput,
  orderIntentForIdempotencyHash,
  getGiftIntentOptions
};

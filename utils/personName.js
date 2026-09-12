/**
 * Customer person-name rules (register + delivery address).
 * English letters only, 1–3 words, 3–50 chars after trim/collapse.
 */

const PERSON_NAME_MIN_LEN = 3;
const PERSON_NAME_MAX_LEN = 50;
const PERSON_NAME_MAX_WORDS = 3;
const PERSON_NAME_MIN_WORD_LEN = 2;
const PERSON_NAME_PATTERN = /^[A-Za-z]+(?: [A-Za-z]+){0,2}$/;
const TITLE_SET = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'sir']);

function normalizePersonName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function parsePersonName(raw) {
  const value = normalizePersonName(raw);
  if (!value) {
    return { ok: false, code: 'REQUIRED', message: 'Full name is required.' };
  }
  if (value.length < PERSON_NAME_MIN_LEN) {
    return { ok: false, code: 'TOO_SHORT', message: 'Name must be at least 3 characters.' };
  }
  if (value.length > PERSON_NAME_MAX_LEN) {
    return { ok: false, code: 'TOO_LONG', message: 'Name must be at most 50 characters.' };
  }

  const words = value.split(' ');
  if (words.length > PERSON_NAME_MAX_WORDS) {
    return {
      ok: false,
      code: 'TOO_MANY_WORDS',
      message: 'Use at most 3 words (first, middle, last).'
    };
  }
  if (!PERSON_NAME_PATTERN.test(value)) {
    return {
      ok: false,
      code: 'INVALID_CHARS',
      message: 'Use English letters only. No numbers or special characters.'
    };
  }
  if (words.some((word) => word.length < PERSON_NAME_MIN_WORD_LEN)) {
    return {
      ok: false,
      code: 'WORD_TOO_SHORT',
      message: 'Each name word must be at least 2 letters.'
    };
  }
  if (words.some((word) => TITLE_SET.has(word.toLowerCase()))) {
    return {
      ok: false,
      code: 'TITLE_NOT_ALLOWED',
      message: 'Do not include titles like Mr or Dr.'
    };
  }
  if (words.some((word) => /^(.)\1{2,}$/i.test(word))) {
    return { ok: false, code: 'INVALID_NAME', message: 'Enter a valid name.' };
  }

  return { ok: true, value };
}

module.exports = {
  PERSON_NAME_MIN_LEN,
  PERSON_NAME_MAX_LEN,
  PERSON_NAME_MAX_WORDS,
  PERSON_NAME_MIN_WORD_LEN,
  normalizePersonName,
  parsePersonName
};

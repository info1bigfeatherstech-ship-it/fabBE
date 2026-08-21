/**
 * Fixed security-question catalog for ecomm customer accounts.
 * Users pick exactly ONE question at registration; answers are unique per user.
 * Do not change `id` values after users have registered.
 */
const SECURITY_QUESTIONS = Object.freeze([
  Object.freeze({
    id: 'nick_name',
    text: ' What is your nickname?'
  }),
  Object.freeze({
    id: 'first_school',
    text: 'What was the name of your first school?'
  }),
  Object.freeze({
    id: 'grandmother_name',
    text: "What is your grandmother's name?"
  }),
  Object.freeze({
    id: 'eye_color',
    text: 'What is your eye color?'
  }),
  Object.freeze({
    id: 'favorite_place',
    text: 'What is your favorite place?'
  })
]);

const SECURITY_QUESTION_IDS = Object.freeze(SECURITY_QUESTIONS.map((q) => q.id));
/** Catalog size (how many questions are offered to choose from). */
const SECURITY_QUESTION_CATALOG_COUNT = SECURITY_QUESTIONS.length;
/** How many answers a user must set at registration. */
const REQUIRED_SECURITY_ANSWER_COUNT = 1;
const MIN_SECURITY_ANSWER_LENGTH = 2;
const MAX_SECURITY_ANSWER_LENGTH = 80;
/** Wrong-answer attempts allowed on forgot-password before email-OTP fallback. */
const SECURITY_ANSWER_MAX_ATTEMPTS = 3;

module.exports = {
  SECURITY_QUESTIONS,
  SECURITY_QUESTION_IDS,
  SECURITY_QUESTION_CATALOG_COUNT,
  REQUIRED_SECURITY_ANSWER_COUNT,
  MIN_SECURITY_ANSWER_LENGTH,
  MAX_SECURITY_ANSWER_LENGTH,
  SECURITY_ANSWER_MAX_ATTEMPTS,
  // Back-compat aliases used by older call sites during migration
  REQUIRED_SECURITY_QUESTION_COUNT: REQUIRED_SECURITY_ANSWER_COUNT,
  MIN_SECURITY_ANSWER_MATCHES: 1
};

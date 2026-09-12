/**
 * Ecomm security-question helpers.
 * User picks exactly one catalog question at register; answer is bcrypt-hashed.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const {
  SECURITY_QUESTIONS,
  SECURITY_QUESTION_IDS,
  REQUIRED_SECURITY_ANSWER_COUNT,
  MIN_SECURITY_ANSWER_LENGTH,
  MAX_SECURITY_ANSWER_LENGTH,
  SECURITY_ANSWER_MAX_ATTEMPTS
} = require('../constants/securityQuestions');

const ANSWER_HASH_ROUNDS = 12;
const QUESTION_ID_SET = new Set(SECURITY_QUESTION_IDS);
const QUESTION_BY_ID = new Map(SECURITY_QUESTIONS.map((q) => [q.id, q]));

class SecurityQuestionError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'SecurityQuestionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const getPublicSecurityQuestions = () =>
  SECURITY_QUESTIONS.map((question) => ({
    id: question.id,
    text: question.text
  }));

const getQuestionById = (questionId) => {
  const id = String(questionId || '').trim();
  const found = QUESTION_BY_ID.get(id);
  return found ? { id: found.id, text: found.text } : null;
};

const normalizeAnswer = (raw) =>
  String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * Accepts:
 * - [{ questionId, answer }]
 * - { questionId, answer }
 * - { securityQuestion: { questionId, answer } }
 */
const coerceAnswerPayload = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (raw.securityQuestion && typeof raw.securityQuestion === 'object') {
      return [raw.securityQuestion];
    }
    if (raw.questionId || raw.id) return [raw];
  }
  return null;
};

const parseSingleSubmittedAnswer = (rawAnswers) => {
  const list = coerceAnswerPayload(rawAnswers);
  if (!list || list.length === 0) {
    throw new SecurityQuestionError(
      'SECURITY_ANSWER_REQUIRED',
      'Please choose one security question and provide an answer.'
    );
  }
  if (list.length > REQUIRED_SECURITY_ANSWER_COUNT) {
    throw new SecurityQuestionError(
      'SECURITY_ANSWER_TOO_MANY',
      'Please choose only one security question.'
    );
  }

  const item = list[0] || {};
  const questionId = String(item.questionId || item.id || '').trim();
  const answer = normalizeAnswer(item.answer);

  if (!QUESTION_ID_SET.has(questionId)) {
    throw new SecurityQuestionError(
      'SECURITY_QUESTION_INVALID',
      'Please choose a valid security question.'
    );
  }
  if (answer.length < MIN_SECURITY_ANSWER_LENGTH) {
    throw new SecurityQuestionError(
      'SECURITY_ANSWER_TOO_SHORT',
      `Security answer must be at least ${MIN_SECURITY_ANSWER_LENGTH} characters.`
    );
  }
  if (answer.length > MAX_SECURITY_ANSWER_LENGTH) {
    throw new SecurityQuestionError(
      'SECURITY_ANSWER_TOO_LONG',
      `Security answer must be at most ${MAX_SECURITY_ANSWER_LENGTH} characters.`
    );
  }

  return { questionId, answer };
};

const validateCompleteAnswers = (rawAnswers) => {
  const single = parseSingleSubmittedAnswer(rawAnswers);
  return new Map([[single.questionId, single.answer]]);
};

const hashAnswer = async (normalizedAnswer) => {
  const salt = await bcrypt.genSalt(ANSWER_HASH_ROUNDS);
  return bcrypt.hash(normalizedAnswer, salt);
};

const buildHashedAnswersForRegister = async (rawAnswers) => {
  const { questionId, answer } = parseSingleSubmittedAnswer(rawAnswers);
  return [
    {
      questionId,
      answerHash: await hashAnswer(answer)
    }
  ];
};

const hasCompleteStoredAnswers = (storedAnswers) => {
  if (!Array.isArray(storedAnswers) || storedAnswers.length < 1) return false;
  return storedAnswers.some(
    (item) =>
      QUESTION_ID_SET.has(String(item?.questionId || '')) &&
      typeof item?.answerHash === 'string' &&
      Boolean(item.answerHash)
  );
};

const getStoredPublicQuestion = (storedAnswers) => {
  if (!Array.isArray(storedAnswers) || storedAnswers.length < 1) return null;
  // Prefer the first valid stored question (new users have exactly one).
  for (const item of storedAnswers) {
    const publicQ = getQuestionById(item?.questionId);
    if (publicQ && item?.answerHash) return publicQ;
  }
  return null;
};

/**
 * Stable dummy question for unknown / ineligible identifiers.
 * Same identifier always gets the same catalog item so we never leak
 * "everyone unknown sees nickname" while still avoiding account enumeration.
 */
const getAntiEnumerationPublicQuestion = (identifier) => {
  const questions = getPublicSecurityQuestions();
  if (!questions.length) return null;
  const key = String(identifier || '').trim().toLowerCase();
  if (!key) return questions[0];
  const digest = crypto.createHash('sha256').update(`owb-reset-q:${key}`).digest();
  return questions[digest.readUInt32BE(0) % questions.length];
};

/**
 * Verify against the question we actually issued on the challenge,
 * not whatever questionId the client chooses to send.
 */
const bindSubmittedAnswerToQuestion = (rawAnswers, questionId) => {
  const forcedId = String(questionId || '').trim();
  if (!forcedId || !QUESTION_ID_SET.has(forcedId)) return rawAnswers;
  const list = coerceAnswerPayload(rawAnswers);
  const answer = list?.[0]?.answer;
  return [{ questionId: forcedId, answer }];
};

let dummyAnswerHashPromise = null;
const getDummyAnswerHash = () => {
  if (!dummyAnswerHashPromise) {
    dummyAnswerHashPromise = bcrypt.hash('__owb_dummy_security_answer__', ANSWER_HASH_ROUNDS);
  }
  return dummyAnswerHashPromise;
};

/**
 * Verify the single stored answer. Uses a dummy hash compare when missing
 * so timing stays roughly consistent.
 */
const verifyStoredAnswer = async (storedAnswers, rawSubmitted) => {
  const submitted = parseSingleSubmittedAnswer(rawSubmitted);
  const dummyHash = await getDummyAnswerHash();

  const list = Array.isArray(storedAnswers) ? storedAnswers : [];
  const stored = list.find((item) => String(item?.questionId || '') === submitted.questionId);
  const storedHash = stored?.answerHash || dummyHash;

  let ok = false;
  try {
    ok = await bcrypt.compare(submitted.answer, storedHash);
  } catch {
    ok = false;
  }

  return Boolean(ok && stored?.answerHash);
};

/** @deprecated use verifyStoredAnswer — kept for call-site compatibility */
const countMatchingAnswers = async (storedAnswers, rawSubmitted) => {
  const matched = await verifyStoredAnswer(storedAnswers, rawSubmitted);
  return matched ? 1 : 0;
};

const meetsResetMatchThreshold = (matchCount) => Number(matchCount) >= 1;

module.exports = {
  SecurityQuestionError,
  getPublicSecurityQuestions,
  getQuestionById,
  getStoredPublicQuestion,
  getAntiEnumerationPublicQuestion,
  bindSubmittedAnswerToQuestion,
  normalizeAnswer,
  parseSingleSubmittedAnswer,
  validateCompleteAnswers,
  buildHashedAnswersForRegister,
  hasCompleteStoredAnswers,
  verifyStoredAnswer,
  countMatchingAnswers,
  meetsResetMatchThreshold,
  REQUIRED_SECURITY_ANSWER_COUNT,
  SECURITY_ANSWER_MAX_ATTEMPTS
};

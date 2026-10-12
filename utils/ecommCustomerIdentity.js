/**
 * Resolve a single ecomm storefront customer by email and/or Google subject.
 * Prevents duplicate Google/register accounts when identity already exists.
 *
 * Production rules:
 * - Never invent a second ecomm customer for the same Google email / subject.
 * - Prefer the account that already holds purchase history when duplicates exist.
 * - Match legacy mixed-case emails and missing accountScope docs.
 */
const User = require('../models/User');
const {
  ACCOUNT_SCOPES,
  andFilters,
  customerScopeFilter
} = require('./accountScope');

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function loyaltyOrderCount(user) {
  const n = Number(user?.loyalty?.lifetimeOrderCount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function loyaltySpend(user) {
  const n = Number(user?.loyalty?.lifetimeSpendInr);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function loyaltyPoints(user) {
  const n = Number(user?.loyalty?.pointsBalance);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Higher = better login target when duplicates exist.
 * Purchase history outranks an empty Google shell that only has googleId.
 */
function scoreCustomerIdentity(user) {
  if (!user) return -1;
  let score = 0;

  const orders = loyaltyOrderCount(user);
  const spend = loyaltySpend(user);
  const points = loyaltyPoints(user);

  // Strong preference for accounts that already own storefront history.
  score += Math.min(orders, 100) * 100;
  score += Math.min(spend, 1_000_000) / 10;
  score += Math.min(points, 100_000) / 20;

  if (String(user.googleId || '').trim()) score += 8;
  if (normalizeEmail(user.email)) score += 4;
  if (String(user.phone || '').trim()) score += 4;
  if (user.isEmailVerified || user.isPhoneVerified) score += 2;
  if (user.isProfileComplete) score += 1;

  const status = String(user.status || '').trim().toLowerCase();
  if (status === 'active') score += 2;
  else if (status === 'inactive' || status === 'blocked' || status === 'suspended') {
    score -= 3;
  }

  return score;
}

/**
 * Prefer the richest identity; ties break to oldest document
 * (orders/addresses/wishlist usually live on the first account).
 */
function pickCanonicalEcommCustomer(users) {
  const list = Array.isArray(users) ? users.filter(Boolean) : [];
  if (!list.length) return null;
  return [...list].sort((a, b) => {
    const byScore = scoreCustomerIdentity(b) - scoreCustomerIdentity(a);
    if (byScore !== 0) return byScore;
    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return String(a._id).localeCompare(String(b._id));
  })[0];
}

function ecommCustomerGoogleIdQuery(googleId) {
  const gid = String(googleId || '').trim();
  if (!gid) return null;
  return andFilters({ googleId: gid }, customerScopeFilter(ACCOUNT_SCOPES.ECOMM));
}

/**
 * Exact lowercase email (index-friendly) OR case-insensitive legacy match.
 */
function ecommCustomerEmailQuery(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return andFilters(
    {
      $or: [
        { email: normalized },
        { email: { $regex: `^${escapeRegex(normalized)}$`, $options: 'i' } }
      ]
    },
    customerScopeFilter(ACCOUNT_SCOPES.ECOMM)
  );
}

function dedupeUsersById(users) {
  const byId = new Map();
  for (const doc of users || []) {
    if (!doc || doc._id == null) continue;
    byId.set(String(doc._id), doc);
  }
  return [...byId.values()];
}

/**
 * @returns {Promise<import('mongoose').Document[]>}
 */
async function listEcommCustomersByGoogleOrEmail({ googleId, email } = {}) {
  const queries = [];
  const byGoogle = ecommCustomerGoogleIdQuery(googleId);
  const byEmail = ecommCustomerEmailQuery(email);
  if (byGoogle) queries.push(User.find(byGoogle).sort({ createdAt: 1 }));
  if (byEmail) queries.push(User.find(byEmail).sort({ createdAt: 1 }));
  if (!queries.length) return [];

  const batches = await Promise.all(queries);
  return dedupeUsersById(batches.flatMap((batch) => batch || []));
}

/**
 * @returns {Promise<import('mongoose').Document|null>}
 */
async function findEcommCustomerByGoogleOrEmail({ googleId, email } = {}) {
  const candidates = await listEcommCustomersByGoogleOrEmail({ googleId, email });
  return pickCanonicalEcommCustomer(candidates);
}

/**
 * Resolve which ecomm customer Google login must use.
 * Does not create users — caller creates only when `{ user: null, code: null }`.
 *
 * @returns {Promise<{
 *   user: import('mongoose').Document|null,
 *   candidates: import('mongoose').Document[],
 *   code?: string,
 *   message?: string
 * }>}
 */
async function resolveEcommCustomerForGoogleLogin({ googleId, email } = {}) {
  const gid = String(googleId || '').trim();
  const normalizedEmail = normalizeEmail(email);
  const candidates = await listEcommCustomersByGoogleOrEmail({
    googleId: gid,
    email: normalizedEmail
  });

  if (!candidates.length) {
    return { user: null, candidates: [] };
  }

  const googleMatches = candidates.filter(
    (u) => String(u.googleId || '').trim() === gid
  );

  for (const match of googleMatches) {
    const matchEmail = normalizeEmail(match.email);
    if (matchEmail && matchEmail !== normalizedEmail) {
      return {
        user: null,
        candidates,
        code: 'GOOGLE_ID_EMAIL_MISMATCH',
        message:
          'This Google account is already linked to a different email. Please contact support.'
      };
    }
  }

  /**
   * Pool = same email docs (plus contact-stripped googleId shells for this subject).
   * Always pick the richest/oldest, then caller claims googleId onto that winner.
   * This prevents empty Google shells from stealing login away from order history.
   */
  const emailMatches = candidates.filter(
    (u) => normalizeEmail(u.email) === normalizedEmail
  );
  const googleShells = googleMatches.filter((u) => !normalizeEmail(u.email));
  const pool = dedupeUsersById([...emailMatches, ...googleShells]);

  return {
    user: pickCanonicalEcommCustomer(pool.length ? pool : candidates),
    candidates
  };
}

/**
 * Ensure `googleId` can be saved on `user` without unique-index clashes from
 * same-email duplicate ecomm rows (legacy bugs). Does not touch unrelated emails.
 *
 * @param {import('mongoose').Document} user
 * @param {string} googleId
 * @param {string} email normalized lowercase
 */
async function claimGoogleIdForEcommCustomer(user, googleId, email) {
  const gid = String(googleId || '').trim();
  const normalizedEmail = normalizeEmail(email);
  if (!user || !gid || !normalizedEmail) return;

  const current = String(user.googleId || '').trim();
  if (current === gid) {
    return;
  }
  if (current && current !== gid) {
    const err = new Error('GOOGLE_EMAIL_LINKED_TO_OTHER');
    err.code = 'GOOGLE_EMAIL_LINKED_TO_OTHER';
    throw err;
  }

  const holders = await User.find(
    andFilters({ googleId: gid }, customerScopeFilter(ACCOUNT_SCOPES.ECOMM))
  );

  for (const holder of holders) {
    if (String(holder._id) === String(user._id)) continue;
    const holderEmail = normalizeEmail(holder.email);
    // Only heal clear duplicates of this email (or contact-stripped shells).
    if (holderEmail && holderEmail !== normalizedEmail) {
      const err = new Error('GOOGLE_ID_EMAIL_MISMATCH');
      err.code = 'GOOGLE_ID_EMAIL_MISMATCH';
      throw err;
    }
    holder.set('googleId', undefined);
    if (typeof holder.$unset === 'function') holder.$unset('googleId');
    if (holder._doc) delete holder._doc.googleId;

    const stillHasContact =
      Boolean(holderEmail) || Boolean(String(holder.phone || '').trim());
    // Contact-less shells must not fail ecomm validate() after releasing googleId.
    if (!stillHasContact) {
      holder.status = 'inactive';
      await holder.save({ validateBeforeSave: false });
    } else {
      await holder.save();
    }
  }

  user.googleId = gid;
}

module.exports = {
  scoreCustomerIdentity,
  pickCanonicalEcommCustomer,
  ecommCustomerGoogleIdQuery,
  ecommCustomerEmailQuery,
  listEcommCustomersByGoogleOrEmail,
  findEcommCustomerByGoogleOrEmail,
  resolveEcommCustomerForGoogleLogin,
  claimGoogleIdForEcommCustomer
};

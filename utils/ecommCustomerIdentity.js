/**
 * Resolve a single ecomm storefront customer by email and/or Google subject.
 * Prevents duplicate Google/register accounts when identity already exists.
 */
const User = require('../models/User');
const {
  ACCOUNT_SCOPES,
  buildCustomerContactLookup,
  andFilters,
  customerScopeFilter
} = require('./accountScope');

function scoreCustomerIdentity(user) {
  if (!user) return -1;
  let score = 0;
  if (user.googleId) score += 8;
  if (String(user.email || '').trim()) score += 4;
  if (String(user.phone || '').trim()) score += 4;
  if (user.isEmailVerified || user.isPhoneVerified) score += 2;
  if (String(user.status || '') === 'active') score += 1;
  return score;
}

/**
 * Prefer the richest verified identity; ties break to oldest document
 * (orders/addresses usually live on the first account).
 */
function pickCanonicalEcommCustomer(users) {
  const list = Array.isArray(users) ? users.filter(Boolean) : [];
  if (!list.length) return null;
  return [...list].sort((a, b) => {
    const byScore = scoreCustomerIdentity(b) - scoreCustomerIdentity(a);
    if (byScore !== 0) return byScore;
    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    return aTime - bTime;
  })[0];
}

function ecommCustomerGoogleIdQuery(googleId) {
  const gid = String(googleId || '').trim();
  if (!gid) return null;
  return andFilters({ googleId: gid }, customerScopeFilter(ACCOUNT_SCOPES.ECOMM));
}

/**
 * @returns {Promise<import('mongoose').Document|null>}
 */
async function findEcommCustomerByGoogleOrEmail({ googleId, email } = {}) {
  const queries = [];
  const byGoogle = ecommCustomerGoogleIdQuery(googleId);
  const byEmail = buildCustomerContactLookup(
    { email: String(email || '').trim().toLowerCase() },
    ACCOUNT_SCOPES.ECOMM
  );
  if (byGoogle) queries.push(User.find(byGoogle).sort({ createdAt: 1 }));
  if (byEmail) queries.push(User.find(byEmail).sort({ createdAt: 1 }));
  if (!queries.length) return null;

  const batches = await Promise.all(queries);
  const byId = new Map();
  for (const batch of batches) {
    for (const doc of batch || []) {
      byId.set(String(doc._id), doc);
    }
  }
  return pickCanonicalEcommCustomer([...byId.values()]);
}

module.exports = {
  scoreCustomerIdentity,
  pickCanonicalEcommCustomer,
  ecommCustomerGoogleIdQuery,
  findEcommCustomerByGoogleOrEmail
};

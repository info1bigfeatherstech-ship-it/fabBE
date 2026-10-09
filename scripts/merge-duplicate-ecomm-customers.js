/**
 * Production-safe merge for duplicate / shell ecomm customers.
 *
 * Default is DRY RUN (no writes). To apply:
 *   APPLY=1 node scripts/merge-duplicate-ecomm-customers.js
 *
 * Optional:
 *   EMAIL=metamannaw3@gmail.com   # only merge this email cluster
 *   MONGODB_DB_NAME=...           # if URI has no db path
 *
 * What it does when APPLY=1:
 * 1) Same-email ecomm duplicates → keep canonical (richest + oldest),
 *    reassign Order / Address / Cart userId, deactivate losers.
 * 2) Contact-less shell users (no email/phone/googleId) with zero orders
 *    and zero addresses → mark inactive (not deleted).
 *
 * Does NOT delete users. Does NOT touch wholesale/staff.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../models/User');
const Order = require('../models/Order');
const Address = require('../models/Address');
const {
  ACCOUNT_SCOPES,
  customerScopeFilter
} = require('../utils/accountScope');
const {
  pickCanonicalEcommCustomer
} = require('../utils/ecommCustomerIdentity');

const APPLY = String(process.env.APPLY || '').trim() === '1';
const ONLY_EMAIL = String(process.env.EMAIL || '')
  .trim()
  .toLowerCase();

function resolveMongoUri() {
  return (
    process.env.MONGO_DB_URI ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    ''
  ).trim();
}

async function reassignUserOwnedDocs(fromId, toId, session) {
  const filter = { userId: fromId };
  const update = { $set: { userId: toId } };
  const opts = session ? { session } : {};
  const [orders, addresses] = await Promise.all([
    Order.updateMany(filter, update, opts),
    Address.updateMany(filter, update, opts)
  ]);

  let carts = { modifiedCount: 0 };
  try {
    const Cart = mongoose.model('Cart');
    carts = await Cart.updateMany(filter, update, opts);
  } catch {
    /* Cart model optional */
  }

  return {
    orders: orders.modifiedCount || 0,
    addresses: addresses.modifiedCount || 0,
    carts: carts.modifiedCount || 0
  };
}

async function mergeEmailCluster(email, users) {
  const canonical = pickCanonicalEcommCustomer(users);
  if (!canonical) return null;
  const losers = users.filter((u) => String(u._id) !== String(canonical._id));
  if (!losers.length) return { email, canonicalId: String(canonical._id), losers: [] };

  const report = {
    email,
    canonicalId: String(canonical._id),
    losers: []
  };

  for (const loser of losers) {
    const fromId = loser._id;
    let moved = { orders: 0, addresses: 0, carts: 0 };

    if (APPLY) {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        moved = await reassignUserOwnedDocs(fromId, canonical._id, session);
        loser.status = 'inactive';
        loser.name = String(loser.name || 'merged').slice(0, 80);
        // Drop contact fields so unique indexes free the email for canonical only.
        loser.set('email', undefined);
        loser.set('phone', undefined);
        loser.set('googleId', undefined);
        if (loser._doc) {
          delete loser._doc.email;
          delete loser._doc.phone;
          delete loser._doc.googleId;
        }
        await loser.save({ session, validateBeforeSave: false });
        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        throw err;
      } finally {
        session.endSession();
      }
    } else {
      moved = {
        orders: await Order.countDocuments({ userId: fromId }),
        addresses: await Address.countDocuments({ userId: fromId }),
        carts: 0
      };
    }

    report.losers.push({
      id: String(fromId),
      name: loser.name,
      wouldMove: moved
    });
  }

  return report;
}

async function deactivateEmptyShells() {
  const shells = await User.find({
    ...customerScopeFilter(ACCOUNT_SCOPES.ECOMM),
    status: { $ne: 'inactive' },
    $and: [
      { $or: [{ email: { $exists: false } }, { email: null }, { email: '' }] },
      { $or: [{ phone: { $exists: false } }, { phone: null }, { phone: '' }] },
      {
        $or: [
          { googleId: { $exists: false } },
          { googleId: null },
          { googleId: '' }
        ]
      }
    ]
  }).select('_id name email phone googleId status createdAt');

  const report = [];
  for (const shell of shells) {
    const [orderCount, addressCount] = await Promise.all([
      Order.countDocuments({ userId: shell._id }),
      Address.countDocuments({ userId: shell._id })
    ]);
    const entry = {
      id: String(shell._id),
      name: shell.name,
      orderCount,
      addressCount,
      action:
        orderCount === 0 && addressCount === 0
          ? 'deactivate'
          : 'skip_has_data'
    };
    if (APPLY && entry.action === 'deactivate') {
      shell.status = 'inactive';
      await shell.save({ validateBeforeSave: false });
    }
    report.push(entry);
  }
  return report;
}

async function main() {
  const uri = resolveMongoUri();
  if (!uri) {
    console.error('MONGO_DB_URI / MONGODB_URI missing');
    process.exit(1);
  }

  const dbName = String(process.env.MONGODB_DB_NAME || '').trim() || undefined;
  await mongoose.connect(uri, dbName ? { dbName } : undefined);
  console.log(`[merge-ecomm] mode=${APPLY ? 'APPLY' : 'DRY_RUN'} db=${mongoose.connection.name}`);

  const emailMatch = ONLY_EMAIL
    ? { email: ONLY_EMAIL }
    : { email: { $type: 'string', $gt: '' } };

  const withEmail = await User.find({
    ...customerScopeFilter(ACCOUNT_SCOPES.ECOMM),
    ...emailMatch
  }).select('_id name email phone googleId status isEmailVerified isPhoneVerified accountScope createdAt');

  const byEmail = new Map();
  for (const u of withEmail) {
    const key = String(u.email || '').trim().toLowerCase();
    if (!key) continue;
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(u);
  }

  const mergeReports = [];
  for (const [email, users] of byEmail.entries()) {
    if (users.length < 2) continue;
    mergeReports.push(await mergeEmailCluster(email, users));
  }

  console.log('[merge-ecomm] email duplicate clusters:', mergeReports.length);
  console.log(JSON.stringify(mergeReports, null, 2));

  const shells = await deactivateEmptyShells();
  console.log('[merge-ecomm] contact-less shells:', shells.length);
  console.log(JSON.stringify(shells, null, 2));

  await mongoose.disconnect();
  console.log('[merge-ecomm] done');
}

main().catch(async (err) => {
  console.error('[merge-ecomm] failed:', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

/**
 * One-time migration: set channelStatus / channelVisibility from legacy status / isActive.
 * Run from repo root: node scripts/backfill-channel-catalog.js
 * Requires MONGO_DB_URI in .env (same as app).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Product = require('../models/Product');
const {
  deriveProductChannelStatusFromLegacy,
  deriveVariantChannelVisibilityFromLegacy
} = require('../utils/storefrontCatalog');

async function main() {
  const uri = process.env.MONGO_DB_URI;
  if (!uri) {
    console.error('MONGO_DB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const cursor = Product.find({}).cursor();
  let updated = 0;
  let scanned = 0;

  for await (const doc of cursor) {
    scanned += 1;
    let modified = false;
    const setOps = {};

    const st = doc.status || 'draft';
    if (!doc.channelStatus || typeof doc.channelStatus !== 'object') {
      setOps.channelStatus = deriveProductChannelStatusFromLegacy(st, null);
      modified = true;
    } else {
      const hasE = doc.channelStatus.ecomm != null;
      const hasW = doc.channelStatus.wholesale != null;
      if (!hasE && !hasW) {
        setOps.channelStatus = deriveProductChannelStatusFromLegacy(st, doc.channelStatus);
        modified = true;
      }
    }

    for (let i = 0; i < (doc.variants || []).length; i += 1) {
      const v = doc.variants[i];
      const isAct = v.isActive !== false;
      const isWholesaleEligible =
        v.wholesale === true && Number(v?.price?.wholesaleBase) > 0;
      if (!v.channelVisibility || typeof v.channelVisibility !== 'object') {
        setOps[`variants.${i}.channelVisibility`] = deriveVariantChannelVisibilityFromLegacy(
          isAct,
          null,
          { isWholesaleEligible }
        );
        modified = true;
      } else {
        const ve = v.channelVisibility.ecomm != null;
        const vw = v.channelVisibility.wholesale != null;
        if (!ve && !vw) {
          setOps[`variants.${i}.channelVisibility`] = deriveVariantChannelVisibilityFromLegacy(
            isAct,
            v.channelVisibility,
            { isWholesaleEligible }
          );
          modified = true;
        }
      }
    }

    if (modified) {
      await Product.updateOne(
        { _id: doc._id },
        { $set: setOps },
        { runValidators: false }
      );
      updated += 1;
    }
  }

  console.log(`Scanned ${scanned} products, updated ${updated}.`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

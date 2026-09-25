/**
 * Append-only loyalty points ledger. Balance is User.loyalty.pointsBalance;
 * ledger is the audit trail + idempotency source of truth.
 */
const mongoose = require('mongoose');

const ENTRY_TYPES = [
  'earn',
  'redeem',
  'redeem_restore',
  'earn_clawback',
  'expire',
  'adjust'
];

const loyaltyPointLedgerSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    storefront: {
      type: String,
      enum: ['ecomm', 'wholesale'],
      default: 'ecomm',
      index: true
    },
    type: {
      type: String,
      enum: ENTRY_TYPES,
      required: true,
      index: true
    },
    /** Signed points delta (+earn, −redeem, etc.). */
    points: { type: Number, required: true },
    /** Snapshot of balance after this entry. */
    balanceAfter: { type: Number, required: true, min: 0 },
    orderId: { type: String, default: null, index: true },
    orderMongoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    /**
     * Idempotency key — unique per user+key so retries never double-apply.
     * e.g. earn:OWB-ECOMM-123, redeem:OWB-ECOMM-123, clawback:OWB-ECOMM-123
     */
    idempotencyKey: { type: String, required: true },
    rupeeValue: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null, index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '', maxlength: 500 }
  },
  { timestamps: true }
);

loyaltyPointLedgerSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, name: 'user_idempotency_unique' }
);
loyaltyPointLedgerSchema.index({ type: 1, createdAt: -1 });

loyaltyPointLedgerSchema.statics.ENTRY_TYPES = ENTRY_TYPES;

module.exports = mongoose.model('LoyaltyPointLedger', loyaltyPointLedgerSchema);

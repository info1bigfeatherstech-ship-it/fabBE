// models/DeliveryZone.js
const mongoose = require('mongoose');

const deliveryZoneSchema = new mongoose.Schema({
    name: { type: String, required: true }, // e.g., "Metro Cities", "Tier 2", "Remote"
    pincodes: [{ type: String, required: true }], // Array of pincodes in this zone
    baseCharge: { type: Number, required: true, default: 0 },
    perKgCharge: { type: Number, default: 0 },
    freeDeliveryAbove: { type: Number, default: 0 }, // Free delivery above this amount
    estimatedDays: { type: String, required: true }, // e.g., "2-3", "3-5"
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('DeliveryZone', deliveryZoneSchema);
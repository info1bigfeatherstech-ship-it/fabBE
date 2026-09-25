const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const {
  getMyPoints,
  getMyLedger,
  getPublicSettings
} = require('../controllers/loyaltyPoints.controller');

router.get('/settings', getPublicSettings);
router.get('/me', verifyToken, getMyPoints);
router.get('/me/ledger', verifyToken, getMyLedger);

module.exports = router;

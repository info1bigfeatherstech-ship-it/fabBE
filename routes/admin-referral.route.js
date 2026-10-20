const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const {
  adminGetSettings,
  adminUpdateSettings,
  adminListCodes,
  adminGetCode,
  adminListRedemptions
} = require('../controllers/referral.controller');

router.use(verifyToken);
router.use(authorizeRoles('admin', 'marketing_manager'));

router.get('/settings', adminGetSettings);
router.put('/settings', adminUpdateSettings);
router.get('/codes', adminListCodes);
router.get('/codes/:code', adminGetCode);
router.get('/redemptions', adminListRedemptions);

module.exports = router;

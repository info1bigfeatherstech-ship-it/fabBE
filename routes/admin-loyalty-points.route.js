const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const {
  adminGetSettings,
  adminUpdateSettings,
  adminListRules,
  adminCreateRule,
  adminUpdateRule,
  adminDeleteRule,
  adminAdjust,
  adminGetUserPoints,
  adminRepairBalances
} = require('../controllers/loyaltyPoints.controller');

router.use(verifyToken);
router.use(authorizeRoles('admin', 'marketing_manager', 'product_manager'));

router.get('/settings', adminGetSettings);
router.put('/settings', adminUpdateSettings);
router.get('/rules', adminListRules);
router.post('/rules', adminCreateRule);
router.put('/rules/:id', adminUpdateRule);
router.delete('/rules/:id', adminDeleteRule);
router.post('/adjust', adminAdjust);
router.post('/repair-balances', adminRepairBalances);
router.get('/users/:userId', adminGetUserPoints);

module.exports = router;

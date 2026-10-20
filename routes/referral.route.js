const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const {
  getPublicSettings,
  getMine,
  generateMine,
  validate
} = require('../controllers/referral.controller');

router.get('/settings', getPublicSettings);
router.get('/me', verifyToken, getMine);
router.post('/generate', verifyToken, generateMine);
router.post('/validate', verifyToken, validate);

module.exports = router;

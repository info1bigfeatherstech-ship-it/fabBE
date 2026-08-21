const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { validateCoupon, getAvailableCoupons } = require('../controllers/coupon.controller');

router.use(verifyToken);

router.post('/validate', validateCoupon);
router.get('/available', getAvailableCoupons);

module.exports = router;

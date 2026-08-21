const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { checkDeliveryAvailability, getDeliveryCharges } = require('../controllers/delivery.controller');

router.post('/check-delivery', verifyToken, checkDeliveryAvailability);
router.get('/delivery-charges/:pincode', getDeliveryCharges);

module.exports = router;

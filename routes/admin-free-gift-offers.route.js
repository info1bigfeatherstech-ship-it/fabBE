const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const {
  createGiftOffer,
  getAllGiftOffers,
  getGiftOfferById,
  updateGiftOffer,
  deleteGiftOffer,
  toggleGiftOfferStatus,
  saveOrderGiftRecord
} = require('../controllers/freeGiftOffer.controller');

router.use(verifyToken);

// Gift label on order: order_manager also allowed (they process orders)
router.post('/order-gift-record', authorizeRoles('admin', 'product_manager', 'order_manager'), saveOrderGiftRecord);

// Offer CRUD: admin + product_manager only
router.use(authorizeRoles('admin', 'product_manager'));
router.post('/', createGiftOffer);
router.get('/', getAllGiftOffers);
router.get('/:id', getGiftOfferById);
router.put('/:id', updateGiftOffer);
router.delete('/:id', deleteGiftOffer);
router.patch('/:id/toggle', toggleGiftOfferStatus);

module.exports = router;

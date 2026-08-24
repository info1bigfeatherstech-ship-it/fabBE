const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const {
  createOffer,
  getAllOffers,
  getOfferById,
  updateOffer,
  deleteOffer,
  toggleOfferStatus
} = require('../controllers/freeShippingOffer.controller');

router.use(verifyToken);
router.use(authorizeRoles('admin', 'product_manager'));

router.post('/', createOffer);
router.get('/', getAllOffers);
router.get('/:id', getOfferById);
router.put('/:id', updateOffer);
router.delete('/:id', deleteOffer);
router.patch('/:id/toggle', toggleOfferStatus);

module.exports = router;

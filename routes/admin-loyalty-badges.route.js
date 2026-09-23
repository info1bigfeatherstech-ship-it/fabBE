const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const {
  createBadge,
  listBadges,
  getBadgeById,
  updateBadge,
  deleteBadge,
  toggleBadge,
  recomputeUser,
  recomputeUserLookup,
  listBadgeMembers
} = require('../controllers/loyaltyBadge.controller');

router.use(verifyToken);
router.use(authorizeRoles('admin', 'marketing_manager', 'product_manager'));

router.post('/', createBadge);
router.get('/', listBadges);
router.post('/recompute', recomputeUserLookup);
router.post('/recompute/:userId', recomputeUser);
router.get('/:id/members', listBadgeMembers);
router.get('/:id', getBadgeById);
router.put('/:id', updateBadge);
router.delete('/:id', deleteBadge);
router.patch('/:id/toggle', toggleBadge);

module.exports = router;

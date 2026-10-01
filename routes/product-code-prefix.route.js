const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const productCodePrefixSettingsController = require('../controllers/product-code-prefix-settings.controller');

router.get(
  '/settings',
  verifyToken,
  authorizeRoles('admin', 'product_manager'),
  requireAdminStorefrontScope,
  productCodePrefixSettingsController.getAdminProductCodePrefixSettings
);

router.put(
  '/settings',
  verifyToken,
  authorizeRoles('admin'),
  requireAdminStorefrontScope,
  productCodePrefixSettingsController.updateAdminProductCodePrefixSettings
);

module.exports = router;

const express = require('express');
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const saleLiveSettingsController = require('../controllers/saleLiveSettings.controller');

/** Public storefront badge config — GET /api/marketing/sale-live */
const publicRouter = express.Router();
publicRouter.get('/', saleLiveSettingsController.getPublicSaleLiveSettings);

/** Admin label + visibility — /api/admin/marketing/sale-live */
const adminRouter = express.Router();
adminRouter.use(verifyToken);
adminRouter.use(authorizeRoles('admin', 'marketing_manager', 'product_manager'));
adminRouter.get('/', saleLiveSettingsController.getAdminSaleLiveSettings);
adminRouter.put('/', saleLiveSettingsController.updateAdminSaleLiveSettings);

module.exports = { publicRouter, adminRouter };

const express = require('express');
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const festiveOfferSettingsController = require('../controllers/festiveOfferSettings.controller');

/** Public storefront badge config — GET /api/marketing/festive-offer */
const publicRouter = express.Router();
publicRouter.get('/', festiveOfferSettingsController.getPublicFestiveOfferSettings);

/** Admin label + visibility — /api/admin/marketing/festive-offer */
const adminRouter = express.Router();
adminRouter.use(verifyToken);
adminRouter.use(authorizeRoles('admin', 'marketing_manager', 'product_manager'));
adminRouter.get('/', festiveOfferSettingsController.getAdminFestiveOfferSettings);
adminRouter.put('/', festiveOfferSettingsController.updateAdminFestiveOfferSettings);

module.exports = { publicRouter, adminRouter };

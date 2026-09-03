const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { uploadCategoryImages } = require('../middlewares/upload.middleware');
const categoryController = require('../controllers/category.controller');

function runCategoryUpload(req, res, next) {
  uploadCategoryImages(req, res, (err) => {
    if (!err) return next();
    const isMulter = err.name === 'MulterError' || err.code === 'LIMIT_FILE_SIZE';
    const message = isMulter
      ? err.code === 'LIMIT_FILE_SIZE'
        ? 'Image must be under 10 MB'
        : `Upload failed: ${err.message}`
      : err.message || 'Invalid image upload';
    console.error('[category.upload] multer error', {
      code: err.code,
      message: err.message,
      field: err.field,
    });
    return res.status(400).json({
      success: false,
      message,
      error: err.message,
    });
  });
}

// Public category endpoints
router.get('/categories', categoryController.getAllCategories);
router.get('/categories/moving-fast', categoryController.getMovingFastCategories);
router.get('/admin/categories', categoryController.getAdminAllCategories);
router.get('/categories/:id', categoryController.getCategoryById);

// Admin routes for reordering and visibility
router.post('/admin/categories/reorder', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.reorderCategories);
router.patch('/admin/categories/:id/toggle-visibility', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.toggleCategoryVisibility);
router.patch('/admin/categories/:id/toggle-moving-fast', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.toggleCategoryMovingFast);
router.get('/admin/categories/all', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.getAllCategoriesAdmin);

// Admin category endpoints
router.post('/admin/categories', verifyToken, authorizeRoles('admin', 'product_manager'), runCategoryUpload, categoryController.createCategory);
router.put('/admin/categories/:id', verifyToken, authorizeRoles('admin', 'product_manager'), runCategoryUpload, categoryController.updateCategory);
router.delete('/admin/categories/:id/hard', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.hardDeleteCategory);
router.delete('/admin/categories/:id', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.deleteCategory);

module.exports = router;

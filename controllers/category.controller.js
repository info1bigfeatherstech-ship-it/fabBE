const mongoose = require('mongoose');
const Category = require('../models/Category');
const Product = require('../models/Product');
const slugify = require('slugify');
const {
  uploadToCloudinary,
  deleteFromCloudinary,
  optimizeProductImageBuffer
} = require('../utils/cloudinaryHelper');

//  ADD THESE 2 LINES AT THE TOP
const cacheService = require('../services/cache.service');
const cacheConfig = require('../config/cache.config');
const { setApiCacheHeaders } = require('../utils/apiCacheHeaders');
const {
  MOVING_FAST_MAX,
  assignMovingFastOrder,
  assertMovingFastCapacity,
  categoryHasDisplayImage,
} = require('../utils/categoryMovingFast');
const { invalidateCategoryCaches } = require('../utils/categoryCache');

/** Category tiles / headers: slightly tighter cap than product gallery (override via env). */
const CATEGORY_IMAGE_MAX_WIDTH = Math.min(
  2048,
  Math.max(400, Number(process.env.CATEGORY_IMAGE_MAX_WIDTH) || 1200)
);

/** Wide PLP banner backgrounds (override via env). */
const CATEGORY_BANNER_IMAGE_MAX_WIDTH = Math.min(
  3200,
  Math.max(800, Number(process.env.CATEGORY_BANNER_IMAGE_MAX_WIDTH) || 2400)
);

function getCategoryImageOptimizeOptions() {
  const opts = { maxWidth: CATEGORY_IMAGE_MAX_WIDTH };
  const q = process.env.CATEGORY_IMAGE_WEBP_QUALITY;
  if (q !== undefined && q !== '' && !Number.isNaN(Number(q))) {
    opts.quality = Math.min(100, Math.max(50, Number(q)));
  }
  return opts;
}

function getCategoryBannerImageOptimizeOptions() {
  const opts = { maxWidth: CATEGORY_BANNER_IMAGE_MAX_WIDTH };
  const q = process.env.CATEGORY_BANNER_IMAGE_WEBP_QUALITY || process.env.CATEGORY_IMAGE_WEBP_QUALITY;
  if (q !== undefined && q !== '' && !Number.isNaN(Number(q))) {
    opts.quality = Math.min(100, Math.max(50, Number(q)));
  }
  return opts;
}

function getUploadedFile(req, fieldName) {
  if (!req) return null;

  // multer.any() → req.files is an array of files with fieldname
  if (Array.isArray(req.files)) {
    return req.files.find((f) => f && f.fieldname === fieldName) || null;
  }

  // multer.fields() → req.files is a map of field → file[]
  const fromFields = req.files?.[fieldName];
  if (Array.isArray(fromFields) && fromFields[0]) return fromFields[0];

  // multer.single('image') legacy
  if (fieldName === 'image' && req.file) return req.file;
  return null;
}

function isTruthyFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
}

async function safeDeleteCloudinary(publicId) {
  if (!publicId) return;
  try {
    await deleteFromCloudinary(publicId);
  } catch (mediaErr) {
    console.error('Category media cleanup failed:', mediaErr.message);
  }
}

/**
 * Optimize + upload category tile OR banner via shared media helper.
 * Provider is NEVER hardcoded: follows MEDIA_PROVIDER_DEFAULT / MEDIA_STORAGE_MODE
 * (cloudinary | r2) — same path as product images. `kind` only affects resize + publicId tag.
 * @param {Buffer} buffer — multer memory buffer
 * @param {{ nameHint: string, uniqueSuffix: string, kind?: 'image' | 'banner' }} meta
 */
async function processAndUploadCategoryImage(buffer, { nameHint, uniqueSuffix, kind = 'image' }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Invalid or empty image buffer');
  }
  const isBanner = kind === 'banner';
  const optimized = await optimizeProductImageBuffer(
    buffer,
    isBanner ? getCategoryBannerImageOptimizeOptions() : getCategoryImageOptimizeOptions()
  );
  const base = slugify(String(nameHint || 'category'), { lower: true, strict: true }).slice(0, 60);
  const suffix = String(uniqueSuffix || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '');
  const kindTag = isBanner ? 'banner' : 'tile';
  const publicId = `${base}-${kindTag}-${suffix}`.slice(0, 120);
  // Env-driven: cloudinary or r2 — identical for tile + banner
  return uploadToCloudinary(optimized, 'categories', publicId);
}


// =============================================
// GET /admin/categories - WITH CACHE (ALL statuses)
// =============================================
const getAdminAllCategories = async (req, res) => {
  try {
    // Skip cache — admin always needs fresh + complete data
    let categories = await Category.find()
      .sort({ order: 1, name: 1 })
      .lean();

    // Add isHidden flag, reset children
    categories = categories.map(cat => ({
      ...cat,
      isHidden: cat.status === 'inactive',
      children: []
    }));

    // Return flat list — no tree building (tree was causing empty array bug
    // because all cats were going into children, roots was always [])
    return res.status(200).json({
      success: true,
      count: categories.length,
      categories: categories
    });

  } catch (error) {
    console.error('Get admin categories error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
};

// =============================================
// GET /categories - WITH CACHE
// =============================================
const getAllCategories = async (req, res) => {
  try {
    // Categories are shared across storefronts; keep one cache key for all panels.
    const cacheKey = cacheConfig.generateKey('CATEGORY', { all: true });

    //  CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      setApiCacheHeaders(res);
      return res.status(200).json(cachedData);
    }

    let categories = await Category.find({ status: 'active' })
      .sort({ order: 1, name: 1 })
      .lean();

    const map = new Map();
    categories.forEach(cat => {
      cat.children = [];
      map.set(String(cat._id), cat);
    });

    const roots = [];
    categories.forEach(cat => {
      if (cat.parent) {
        const parent = map.get(String(cat.parent));
        if (parent) parent.children.push(cat);
        else roots.push(cat);
      } else {
        roots.push(cat);
      }
    });

    const responseData = {
      success: true,
      count: categories.length,
      categories: roots
    };

    //  STORE IN CACHE (30 minutes)
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.CATEGORY_LIST);

    res.setHeader('X-Cache', 'MISS');
    setApiCacheHeaders(res);
    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Get categories error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
};

// =============================================
// GET /categories/moving-fast - WITH CACHE
// =============================================
const getMovingFastCategories = async (req, res) => {
  try {
    const bypassCache = req.query._cb === '1';
    const cacheKey = cacheConfig.generateKey('CATEGORY', { movingFast: true });

    const cachedData = bypassCache ? null : await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      setApiCacheHeaders(res);
      return res.status(200).json(cachedData);
    }

    const categories = await Category.find({
      status: 'active',
      showInMovingFast: true,
    })
      .sort({ movingFastOrder: 1, order: 1, name: 1 })
      .limit(MOVING_FAST_MAX)
      .lean();

    const withImages = categories.filter(categoryHasDisplayImage);

    const responseData = {
      success: true,
      count: withImages.length,
      max: MOVING_FAST_MAX,
      categories: withImages,
    };

    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.CATEGORY_MOVING_FAST);

    res.setHeader('X-Cache', 'MISS');
    setApiCacheHeaders(res);
    return res.status(200).json(responseData);
  } catch (error) {
    console.error('Get moving fast categories error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching moving fast categories',
      error: error.message,
    });
  }
};


// =============================================
// GET /categories/:id - WITH CACHE
// =============================================
const getCategoryById = async (req, res) => {
  try {
    const { id } = req.params;
    // Categories are shared across storefronts; keep one cache key for all panels.
    const cacheKey = cacheConfig.generateKey('CATEGORY', { id });

    //  CHECK CACHE FIRST
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      setApiCacheHeaders(res);
      return res.status(200).json(cachedData);
    }

    const category = await Category.findOne({
      _id: id,
      status: 'active'
    }).lean();

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const responseData = {
      success: true,
      category
    };

    //  STORE IN CACHE
    await cacheService.set(cacheKey, responseData, cacheConfig.ttl.CATEGORY_DETAIL);

    res.setHeader('X-Cache', 'MISS');
    setApiCacheHeaders(res);
    return res.status(200).json(responseData);

  } catch (error) {
    console.error('Get category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching category',
      error: error.message
    });
  }
};

// =============================================
// REST ALL FUNCTIONS SAME AS BEFORE (NO CHANGE)
// =============================================

const createCategory = async (req, res) => {
  try {
    const {
      name,
      description,
      parent,
      order,
      status,
      showInMenu
    } = req.body;

    if (!name) { 
      return res.status(400).json({
        success: false,
        message: 'Category name is required'
      });
    }

    if (parent) {
      const parentExists = await Category.findById(parent);
      if (!parentExists || parentExists.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: 'Invalid or inactive parent category'
        });
      }
    }
    
    const existingCategory = await Category.findOne({
      name: { $regex: new RegExp(`^${name}$`, 'i') },
      parent: parent || null
    });
    
    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: 'Category with the same name already exists under the same parent'
      });
    }

    const category = new Category({
      name,
      description: description || '',
      parent: parent || null,
      order: order || 0,
      status: status !== undefined ? status : 'active',
      showInMenu: showInMenu !== undefined ? showInMenu : true
    });

    if (parent) {
      const p = await Category.findById(parent);
      category.level = p ? (p.level || 0) + 1 : 0;
    } else {
      category.level = 0;
    }

    console.info('[category.create] multipart', {
      fileCount: Array.isArray(req.files) ? req.files.length : 0,
      files: Array.isArray(req.files)
        ? req.files.map((f) => `${f.fieldname}:${f.mimetype}:${f.size}`)
        : [],
      contentType: req.headers['content-type'],
    });

    const tileFile = getUploadedFile(req, 'image');
    if (tileFile?.buffer) {
      try {
        const { url, publicId } = await processAndUploadCategoryImage(tileFile.buffer, {
          nameHint: name,
          uniqueSuffix: `${Date.now()}`,
          kind: 'image',
        });
        category.image = { url, publicId };
      } catch (err) {
        console.error('Category image upload failed:', err.message);
        return res.status(400).json({
          success: false,
          message: 'Category image could not be processed or uploaded',
          error: err.message
        });
      }
    }

    const bannerFile = getUploadedFile(req, 'bannerImage');
    if (bannerFile?.buffer) {
      try {
        const { url, publicId } = await processAndUploadCategoryImage(bannerFile.buffer, {
          nameHint: name,
          uniqueSuffix: `${Date.now()}`,
          kind: 'banner',
        });
        category.bannerImage = { url, publicId };
      } catch (err) {
        console.error('Category banner image upload failed:', err.message);
        return res.status(400).json({
          success: false,
          message: 'Category banner image could not be processed or uploaded',
          error: err.message
        });
      }
    }

    await category.save();

    //  INVALIDATE CATEGORY CACHE AFTER CREATE
    await invalidateCategoryCaches(category._id);

    return res.status(201).json({
      success: true,
      message: 'Category created successfully',
      category
    });

  } catch (error) {
    console.error('Create category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error creating category',
      error: error.message
    });
  }
};

const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, parent, order, status, clearBannerImage, clearImage } = req.body;

    const category = await Category.findById(id);
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

    const receivedFields = Array.isArray(req.files)
      ? req.files.map((f) => `${f.fieldname}:${f.mimetype}:${f.size}`)
      : Object.keys(req.files || {});
    // Always log — silent missing files was hard to debug in admin.
    console.info('[category.update] multipart', {
      id,
      fileCount: Array.isArray(req.files) ? req.files.length : receivedFields.length,
      files: receivedFields,
      hasBannerFlag: Boolean(req.body?.clearBannerImage),
      contentType: req.headers['content-type'],
    });

    if (name) category.name = name;
    if (description !== undefined) category.description = description;
    if (order !== undefined) category.order = order;
    if (status) category.status = status;

    if (category.status === 'inactive') {
      category.showInMovingFast = false;
      category.movingFastOrder = 0;
    }

    if (parent) {
      const p = await Category.findById(parent);
      category.parent = p ? p._id : null;
      category.level = p ? (p.level || 0) + 1 : 0;
    } else if (parent === null || parent === 'null') {
      category.parent = null;
      category.level = 0;
    }

    const displayName = name || category.name;
    const tileFile = getUploadedFile(req, 'image');
    const bannerFile = getUploadedFile(req, 'bannerImage');

    if (tileFile?.buffer) {
      try {
        const { url, publicId } = await processAndUploadCategoryImage(tileFile.buffer, {
          nameHint: displayName,
          uniqueSuffix: `${String(id)}-${Date.now()}`,
          kind: 'image',
        });
        const previousPublicId = category.image?.publicId;
        category.image = { url, publicId };
        if (previousPublicId && previousPublicId !== publicId) {
          await safeDeleteCloudinary(previousPublicId);
        }
      } catch (err) {
        console.error('Category image upload failed:', err.message);
        return res.status(400).json({
          success: false,
          message: 'Category image could not be processed or uploaded',
          error: err.message
        });
      }
    } else if (isTruthyFlag(clearImage)) {
      const previousPublicId = category.image?.publicId;
      category.image = { url: '', publicId: '' };
      await safeDeleteCloudinary(previousPublicId);
      if (category.showInMovingFast) {
        category.showInMovingFast = false;
        category.movingFastOrder = 0;
      }
    }

    if (bannerFile?.buffer) {
      try {
        const { url, publicId } = await processAndUploadCategoryImage(bannerFile.buffer, {
          nameHint: displayName,
          uniqueSuffix: `${String(id)}-${Date.now()}`,
          kind: 'banner',
        });
        const previousPublicId = category.bannerImage?.publicId;
        category.bannerImage = { url, publicId };
        if (previousPublicId && previousPublicId !== publicId) {
          await safeDeleteCloudinary(previousPublicId);
        }
      } catch (err) {
        console.error('Category banner image upload failed:', err.message);
        return res.status(400).json({
          success: false,
          message: 'Category banner image could not be processed or uploaded',
          error: err.message
        });
      }
    } else if (isTruthyFlag(clearBannerImage)) {
      const previousPublicId = category.bannerImage?.publicId;
      category.bannerImage = { url: '', publicId: '' };
      await safeDeleteCloudinary(previousPublicId);
    }

    if (category.showInMovingFast && !categoryHasDisplayImage(category)) {
      category.showInMovingFast = false;
      category.movingFastOrder = 0;
    }

    await category.save();

    await invalidateCategoryCaches(category._id);

    return res.status(200).json({ success: true, message: 'Category updated', category });
  } catch (error) {
    console.error('Update category error:', error);
    return res.status(500).json({ success: false, message: 'Error updating category', error: error.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    if (category.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Category is already inactive'
      });
    }

    const childCategories = await Category.countDocuments({
      parent: id,
      status: 'active'
    });

    if (childCategories > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. ${childCategories} active subcategory(s) exist.`
      });
    }

    const productCount = await Product.countDocuments({
      category: id
    });

    if (productCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. ${productCount} product(s) are using this category.`
      });
    }

    const previousPublicId = category.image?.publicId;
    const previousBannerPublicId = category.bannerImage?.publicId;
    category.status = 'inactive';
    category.showInMenu = false;
    category.showInMovingFast = false;
    category.movingFastOrder = 0;
    category.image = { url: '', publicId: '' };
    category.bannerImage = { url: '', publicId: '' };
    await category.save();

    await safeDeleteCloudinary(previousPublicId);
    await safeDeleteCloudinary(previousBannerPublicId);

    //  INVALIDATE CATEGORY CACHE AFTER DELETE
    await invalidateCategoryCaches(category._id);

    return res.status(200).json({
      success: true,
      message: 'Category archived successfully',
      category
    });

  } catch (error) {
    console.error('Delete category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error deleting category',
      error: error.message
    });
  }
};

const hardDeleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid category id'
      });
    }

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    if (category.status === 'active') {
      return res.status(400).json({
        success: false,
        message: 'Only inactive categories can be permanently deleted. Hide the category first.'
      });
    }

    const childCount = await Category.countDocuments({ parent: id });
    if (childCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot permanently delete category. ${childCount} subcategory(ies) still exist.`
      });
    }

    const productCount = await Product.countDocuments({ category: id });
    if (productCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot permanently delete category. ${productCount} product(s) are still linked to this category.`
      });
    }

    const previousPublicId = category.image?.publicId;
    const previousBannerPublicId = category.bannerImage?.publicId;
    const deletedSnapshot = category.toObject();

    await Category.findByIdAndDelete(id);

    await safeDeleteCloudinary(previousPublicId);
    await safeDeleteCloudinary(previousBannerPublicId);

    await invalidateCategoryCaches(category._id);

    return res.status(200).json({
      success: true,
      message: 'Category permanently deleted',
      category: deletedSnapshot
    });
  } catch (error) {
    console.error('Hard delete category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error permanently deleting category',
      error: error.message
    });
  }
};

const reorderCategories = async (req, res) => {
  try {
    const { categories } = req.body;

    if (!categories || !Array.isArray(categories)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request. Expected { categories: [{ id, order }] }',
      });
    }

    if (categories.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one category is required to reorder',
      });
    }

    const bulkOps = [];
    const seenIds = new Set();

    for (const cat of categories) {
      const id = cat?.id ?? cat?._id;
      const idStr = id != null ? String(id) : '';

      if (!idStr || !mongoose.Types.ObjectId.isValid(idStr)) {
        return res.status(400).json({
          success: false,
          message: `Invalid category id: ${idStr || 'missing'}`,
        });
      }

      if (seenIds.has(idStr)) {
        return res.status(400).json({
          success: false,
          message: `Duplicate category id in reorder payload: ${idStr}`,
        });
      }
      seenIds.add(idStr);

      const order = cat?.order;
      if (typeof order !== 'number' || !Number.isFinite(order) || order < 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid order for category ${idStr}. Expected a non-negative number.`,
        });
      }

      bulkOps.push({
        updateOne: {
          filter: { _id: idStr },
          update: { order: Math.floor(order) },
        },
      });
    }

    await Category.bulkWrite(bulkOps);

    // Reorder affects the full category list — no single category scope.
    await invalidateCategoryCaches();

    const updatedCategories = await Category.find()
      .sort({ order: 1, name: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: 'Categories reordered successfully',
      categories: updatedCategories,
    });
  } catch (error) {
    console.error('Reorder categories error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error reordering categories',
      error: error.message,
    });
  }
};

const toggleCategoryVisibility = async (req, res) => {
  try {
    const { id } = req.params;
    const { isHidden } = req.body;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    category.status = isHidden ? 'inactive' : 'active';
    if (isHidden) {
      category.showInMovingFast = false;
      category.movingFastOrder = 0;
    }
    await category.save();

    //  INVALIDATE CATEGORY CACHE AFTER TOGGLE
    await invalidateCategoryCaches(category._id);

    return res.status(200).json({
      success: true,
      message: `Category ${isHidden ? 'hidden' : 'shown'} successfully`,
      category
    });
  } catch (error) {
    console.error('Toggle category visibility error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error toggling category visibility',
      error: error.message
    });
  }
};

const toggleCategoryMovingFast = async (req, res) => {
  try {
    const { id } = req.params;
    const { showInMovingFast } = req.body;

    if (typeof showInMovingFast !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'showInMovingFast must be a boolean',
      });
    }

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found',
      });
    }

    if (showInMovingFast && category.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Only active categories can appear in Moving Fast. Show the category first.',
      });
    }

    if (showInMovingFast && !categoryHasDisplayImage(category)) {
      return res.status(400).json({
        success: false,
        message: 'Upload a category image before adding it to Moving Fast.',
      });
    }

    if (showInMovingFast) {
      if (!category.showInMovingFast) {
        await assertMovingFastCapacity(category._id);
        await assignMovingFastOrder(category);
        category.showInMovingFast = true;
      }
    } else {
      category.showInMovingFast = false;
      category.movingFastOrder = 0;
    }

    await category.save();

    await invalidateCategoryCaches(category._id);

    return res.status(200).json({
      success: true,
      message: category.showInMovingFast
        ? 'Category added to Moving Fast'
        : 'Category removed from Moving Fast',
      category,
    });
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
        code: error.code || 'MOVING_FAST_ERROR',
      });
    }
    console.error('Toggle moving fast category error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error updating Moving Fast category',
      error: error.message,
    });
  }
};

const getAllCategoriesAdmin = async (req, res) => {
  try {
    const categories = await Category.find()
      .sort({ order: 1, name: 1 })
      .lean();

    const map = new Map();
    categories.forEach(cat => {
      cat.children = [];
      cat.isHidden = cat.status === 'inactive';
      map.set(String(cat._id), cat);
    });

    const roots = [];
    categories.forEach(cat => {
      if (cat.parent) {
        const parent = map.get(String(cat.parent));
        if (parent) parent.children.push(cat);
        else roots.push(cat);
      } else {
        roots.push(cat);
      }
    });

    return res.status(200).json({
      success: true,
      count: categories.length,
      categories: roots
    });
  } catch (error) {
    console.error('Get all categories admin error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
};

module.exports = {
  getAllCategories,
  getMovingFastCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  hardDeleteCategory,
  reorderCategories,
  toggleCategoryVisibility,
  toggleCategoryMovingFast,
  getAllCategoriesAdmin,
  getAdminAllCategories
};
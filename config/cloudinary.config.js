const cloudinary = require('cloudinary').v2;

// ============================================================================
// CLOUDINARY CONFIGURATION
// ============================================================================
// PDF proofs: if public .pdf URLs return 401, enable "Allow delivery of PDF and ZIP files"
// (Settings → Security). Wholesaler flows also use a page-1 JPEG preview URL to bypass that limit.

function initCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  
  console.log('[Cloudinary] ✓ Configured successfully');
}

module.exports = {
  initCloudinary,
  cloudinary
};
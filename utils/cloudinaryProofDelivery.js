/**
 * Wholesaler proof URLs on Cloudinary.
 *
 * Many product environments block **public PDF/ZIP delivery** (Security → PDF and ZIP files).
 * That returns HTTP 401 on the original `.pdf` URL. Rasterizing page 1 as JPEG uses
 * **image** delivery and still works when PDF delivery is restricted.
 *
 * @see https://support.cloudinary.com/hc/en-us/articles/360016480179
 */

const { cloudinary } = require('../config/cloudinary.config');

/**
 * @param {string} secureUrl
 * @returns {{ cloudName: string, resourceType: 'image'|'raw', version: string, publicId: string } | null}
 */
function parseCloudinaryDeliveryUrl(secureUrl) {
  try {
    const u = new URL(String(secureUrl).trim());
    if (!u.hostname.endsWith('cloudinary.com')) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 4) return null;

    const cloudName = segs[0];
    const resourceType = segs[1];
    const uploadLiteral = segs[2];

    if (uploadLiteral !== 'upload' || (resourceType !== 'image' && resourceType !== 'raw')) {
      return null;
    }

    let i = 3;
    let version = '';
    if (segs[i] && /^v\d+$/i.test(segs[i])) {
      version = segs[i];
      i += 1;
    }

    const rest = segs.slice(i).join('/');
    if (!rest) return null;

    const lastDot = rest.lastIndexOf('.');
    const publicId = lastDot > 0 ? rest.slice(0, lastDot) : rest;

    return { cloudName, resourceType, version, publicId };
  } catch {
    return null;
  }
}

/**
 * First page of a PDF uploaded as `resource_type: image`, delivered as JPEG (works when raw PDF delivery is blocked).
 * @param {string} publicId
 * @returns {string|null}
 */
function buildPdfFirstPageJpegDeliveryUrl(publicId) {
  if (!publicId || !String(process.env.CLOUDINARY_CLOUD_NAME || '').trim()) return null;
  try {
    return cloudinary.url(publicId, {
      resource_type: 'image',
      secure: true,
      format: 'jpg',
      transformation: [{ page: 1 }, { width: 1600, height: 1600, crop: 'limit' }, { quality: 'auto:good' }]
    });
  } catch {
    return null;
  }
}

/**
 * @param {string} storedSecureUrl
 * @returns {string|null}
 */
function buildWholesalerPdfPreviewUrl(storedSecureUrl) {
  const parsed = parseCloudinaryDeliveryUrl(storedSecureUrl);
  if (!parsed || parsed.resourceType !== 'image') return null;
  return buildPdfFirstPageJpegDeliveryUrl(parsed.publicId);
}

module.exports = {
  parseCloudinaryDeliveryUrl,
  buildPdfFirstPageJpegDeliveryUrl,
  buildWholesalerPdfPreviewUrl
};

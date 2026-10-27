/**
 * Image groups for flat SKUs.
 * Photos follow the look-changing option (Color, Fragrance, Model, …),
 * not each size/capacity row. No nested variant schema.
 */

const SIZE_LIKE_KEY_RE = /^(size|capacity|fit|qty|quantity|volume)$/i
const COLOR_KEY_RE = /color|colour|shade/i

function normalizeKey(key) {
  return String(key || '').trim().toLowerCase()
}

function normalizeValue(value) {
  return String(value || '').trim().toLowerCase()
}

function isSizeLikeKey(key) {
  return SIZE_LIKE_KEY_RE.test(String(key || '').trim())
}

function isColorKey(key) {
  return COLOR_KEY_RE.test(String(key || '').trim())
}

function getAttrValue(attrs, key) {
  const nk = normalizeKey(key)
  if (!nk) return ''
  const hit = (Array.isArray(attrs) ? attrs : []).find(
    (a) => normalizeKey(a?.key) === nk && String(a?.value || '').trim()
  )
  return hit ? String(hit.value).trim() : ''
}

/**
 * Which option owns photos.
 * Color if present; else first non-size-like key; else '' (share across the product).
 */
function resolveImageAxisKey(variantAttrLists = []) {
  const lists = Array.isArray(variantAttrLists) ? variantAttrLists : []
  for (const attrs of lists) {
    const color = (Array.isArray(attrs) ? attrs : []).find(
      (attr) => isColorKey(attr?.key) && String(attr?.value || '').trim()
    )
    if (color) return String(color.key).trim()
  }
  for (const attrs of lists) {
    const look = (Array.isArray(attrs) ? attrs : []).find((attr) => {
      const key = String(attr?.key || '').trim()
      const value = String(attr?.value || '').trim()
      return key && value && !isSizeLikeKey(key) && !isColorKey(key)
    })
    if (look) return String(look.key).trim()
  }
  return ''
}

function imageGroupToken(attrs, axisKey) {
  if (!axisKey) return '__all__'
  const value = getAttrValue(attrs, axisKey)
  if (!value) return '__ungrouped__'
  return `${normalizeKey(axisKey)}=${normalizeValue(value)}`
}

function cloneSharedImages(images) {
  return (Array.isArray(images) ? images : [])
    .filter((img) => img && typeof img === 'object' && img.url)
    .map((img, index) => {
      const next = {
        url: img.url,
        publicId: img.publicId || img.public_id || '',
        altText: img.altText || '',
        order: index
      }
      return next
    })
}

function variantHasImages(variant) {
  return cloneSharedImages(variant?.images).length > 0
}

/**
 * Fill empty image arrays from the first sibling in the same image group.
 * Does not overwrite a SKU that already has images.
 */
function applyInheritedGroupImages(variants) {
  const list = Array.isArray(variants) ? variants : []
  const axisKey = resolveImageAxisKey(list.map((v) => v?.attributes))
  const sourceByToken = new Map()
  for (const variant of list) {
    const token = imageGroupToken(variant?.attributes, axisKey)
    const images = cloneSharedImages(variant?.images)
    if (images.length && !sourceByToken.has(token)) sourceByToken.set(token, images)
  }
  let filled = 0
  for (const variant of list) {
    if (variantHasImages(variant)) continue
    const token = imageGroupToken(variant?.attributes, axisKey)
    const source = sourceByToken.get(token)
    if (!source?.length) continue
    variant.images = cloneSharedImages(source)
    filled += 1
  }
  return { filled, axisKey }
}

/**
 * Copy source images onto every SKU in the same image group (shared gallery).
 */
function shareImagesAcrossGroup(variants, sourceIndex) {
  const list = Array.isArray(variants) ? variants : []
  const source = list[sourceIndex]
  if (!source || !variantHasImages(source)) return { shared: 0, axisKey: '' }
  const axisKey = resolveImageAxisKey(list.map((v) => v?.attributes))
  const token = imageGroupToken(source.attributes, axisKey)
  const images = cloneSharedImages(source.images)
  let shared = 0
  list.forEach((variant, index) => {
    if (index === sourceIndex) return
    if (imageGroupToken(variant?.attributes, axisKey) !== token) return
    variant.images = cloneSharedImages(images)
    shared += 1
  })
  return { shared, axisKey }
}

/**
 * Keep file uploads only on the first SKU of each image group.
 * Later indexes inherit after upload (no duplicate Cloudinary objects).
 */
function dropRedundantVariantImageFiles(variantsInput, filesByVariant) {
  const input = Array.isArray(variantsInput) ? variantsInput : []
  const axisKey = resolveImageAxisKey(input.map((v) => v?.attributes))
  const seen = new Set()
  const kept = {}
  const source = filesByVariant && typeof filesByVariant === 'object' ? filesByVariant : {}
  for (let i = 0; i < input.length; i += 1) {
    const files = source[i]
    if (!files?.length) continue
    const token = imageGroupToken(input[i]?.attributes, axisKey)
    if (seen.has(token)) continue
    seen.add(token)
    kept[i] = files
  }
  return kept
}

function rowHasCsvImageUrls(row) {
  return Boolean(String(row?.images || '').trim())
}

module.exports = {
  SIZE_LIKE_KEY_RE,
  normalizeKey,
  normalizeValue,
  isSizeLikeKey,
  isColorKey,
  getAttrValue,
  resolveImageAxisKey,
  imageGroupToken,
  cloneSharedImages,
  variantHasImages,
  applyInheritedGroupImages,
  shareImagesAcrossGroup,
  dropRedundantVariantImageFiles,
  rowHasCsvImageUrls
}

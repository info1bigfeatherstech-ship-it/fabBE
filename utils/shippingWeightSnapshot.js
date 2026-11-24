/**
 * Checkout-time package weight snapshot for orders (Shiprocket quote + fulfilment audit).
 * Keeps per-line and total kg aligned with checkoutComputation / aggregateShipping rules.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const { roundMoney2 } = require('../services/checkoutComputation.service');
const {
  resolveVariantShipping,
  unitWeightKgFromResolvedShipping,
  unitDimsCmFromResolvedShipping
} = require('./variantCatalogFields');

const DIM_WEIGHT_DIVISOR = 5000;

function dimWeightKgFromDimsCm(dims) {
  if (!dims || typeof dims !== 'object') return null;
  const l = Number(dims.lengthCm);
  const w = Number(dims.widthCm);
  const h = Number(dims.heightCm);
  if (![l, w, h].every((n) => Number.isFinite(n) && n > 0)) return null;
  return roundMoney2((l * w * h) / DIM_WEIGHT_DIVISOR);
}

function buildLineDimFieldsFromShipping(shipping, qty) {
  const dims = unitDimsCmFromResolvedShipping(shipping);
  if (!dims) return {};
  const unitDimWeightKg = dimWeightKgFromDimsCm(dims);
  const q = Math.max(0, Number(qty) || 0);
  return {
    lengthCm: dims.lengthCm,
    widthCm: dims.widthCm,
    heightCm: dims.heightCm,
    unitDimWeightKg,
    lineDimWeightKg: unitDimWeightKg != null ? roundMoney2(unitDimWeightKg * q) : null
  };
}

function hasLineDims(row) {
  return [row?.lengthCm, row?.widthCm, row?.heightCm].every(
    (n) => Number.isFinite(Number(n)) && Number(n) > 0
  );
}

/** Normalize ObjectId / populated doc / string to a stable id string. */
function idStr(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object') {
    if (value._id != null) return String(value._id).trim();
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
      const s = String(value.toString()).trim();
      if (s && s !== '[object Object]') return s;
    }
  }
  return String(value).trim();
}

function lineKey(productId, variantId) {
  return `${idStr(productId)}:${idStr(variantId)}`;
}

const MAX_UNIT_WEIGHT_KG = 50;
const MAX_PACKAGE_WEIGHT_KG = 100;
const MAX_DIM_CM = 200;
const MIN_UNIT_WEIGHT_KG = 0.05;
const MIN_DIM_CM = 1;

function hasPackageOverride(snap) {
  const po = snap?.packageOverride;
  if (!po || typeof po !== 'object') return false;
  const w = Number(po.totalWeightKg);
  const l = Number(po.lengthCm);
  const wi = Number(po.widthCm);
  const h = Number(po.heightCm);
  return (
    Number.isFinite(w) &&
    w >= MIN_UNIT_WEIGHT_KG &&
    [l, wi, h].every((n) => Number.isFinite(n) && n >= MIN_DIM_CM)
  );
}

function dimsAggFromPackageOverride(po) {
  return {
    weightKg: Math.max(MIN_UNIT_WEIGHT_KG, roundMoney2(Number(po.totalWeightKg) || MIN_UNIT_WEIGHT_KG)),
    lengthCm: Math.max(MIN_DIM_CM, Number(po.lengthCm) || MIN_DIM_CM),
    widthCm: Math.max(MIN_DIM_CM, Number(po.widthCm) || MIN_DIM_CM),
    heightCm: Math.min(MAX_DIM_CM, Math.max(MIN_DIM_CM, Number(po.heightCm) || MIN_DIM_CM))
  };
}

function validatePackageShippingOverride(raw) {
  const errors = [];
  const totalWeightKg = Number(raw?.totalWeightKg);
  if (!Number.isFinite(totalWeightKg) || totalWeightKg < MIN_UNIT_WEIGHT_KG) {
    errors.push(`totalWeightKg must be ≥ ${MIN_UNIT_WEIGHT_KG}`);
  } else if (totalWeightKg > MAX_PACKAGE_WEIGHT_KG) {
    errors.push(`totalWeightKg must be ≤ ${MAX_PACKAGE_WEIGHT_KG}`);
  }

  const lengthCm = Number(raw?.lengthCm);
  const widthCm = Number(raw?.widthCm);
  const heightCm = Number(raw?.heightCm);
  for (const [label, n] of [
    ['lengthCm', lengthCm],
    ['widthCm', widthCm],
    ['heightCm', heightCm]
  ]) {
    if (!Number.isFinite(n) || n < MIN_DIM_CM) {
      errors.push(`${label} must be ≥ ${MIN_DIM_CM}`);
    } else if (n > MAX_DIM_CM) {
      errors.push(`${label} must be ≤ ${MAX_DIM_CM}`);
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      totalWeightKg: roundMoney2(totalWeightKg),
      lengthCm: roundMoney2(lengthCm),
      widthCm: roundMoney2(widthCm),
      heightCm: roundMoney2(heightCm)
    }
  };
}

/**
 * Proportionally scale order-snapshot line weights so Σ(unitWeight×qty) === packageTotalKg.
 * Also align line L/W to package and split height by unit share (stack ≈ package H).
 * Catalog/Product is never touched — order snapshot only (courier conflict prevention).
 * @param {object[]} lines
 * @param {{ totalWeightKg: number, lengthCm: number, widthCm: number, heightCm: number }} pkg
 */
function alignSnapshotLinesToPackageTotals(lines, pkg) {
  const rows = (lines || []).map((row) => ({ ...row }));
  const active = rows.filter((r) => Math.max(0, Number(r.quantity) || 0) > 0);
  if (!active.length) return rows;

  const targetKg = Math.max(
    MIN_UNIT_WEIGHT_KG,
    roundMoney2(Number(pkg.totalWeightKg) || MIN_UNIT_WEIGHT_KG)
  );
  const pkgL = Math.max(MIN_DIM_CM, Number(pkg.lengthCm) || MIN_DIM_CM);
  const pkgW = Math.max(MIN_DIM_CM, Number(pkg.widthCm) || MIN_DIM_CM);
  const pkgH = Math.min(MAX_DIM_CM, Math.max(MIN_DIM_CM, Number(pkg.heightCm) || MIN_DIM_CM));

  const totalUnits = active.reduce((s, r) => s + Math.max(0, Number(r.quantity) || 0), 0);
  if (!(totalUnits > 0)) return rows;

  // Weight: keep relative shares from current line weights; fallback equal-by-qty.
  let rawShare = active.map((r) => {
    const qty = Math.max(0, Number(r.quantity) || 0);
    const unit = Number(r.unitWeightKg);
    const lineW =
      Number.isFinite(unit) && unit > 0
        ? unit * qty
        : Number(r.lineWeightKg) > 0
          ? Number(r.lineWeightKg)
          : qty;
    return Math.max(0.0001, lineW);
  });
  let shareSum = rawShare.reduce((s, n) => s + n, 0);
  if (!(shareSum > 0)) {
    rawShare = active.map((r) => Math.max(1, Number(r.quantity) || 1));
    shareSum = rawShare.reduce((s, n) => s + n, 0);
  }

  // Height per unit so stacked height (Σ h×qty) ≈ package H.
  const unitHeightCm = Math.max(MIN_DIM_CM, roundMoney2(pkgH / totalUnits));

  let assignedKg = 0;
  for (let i = 0; i < active.length; i += 1) {
    const row = active[i];
    const qty = Math.max(1, Number(row.quantity) || 1);
    let lineKg;
    if (i === active.length - 1) {
      lineKg = roundMoney2(Math.max(MIN_UNIT_WEIGHT_KG * qty, targetKg - assignedKg));
    } else {
      lineKg = roundMoney2((targetKg * rawShare[i]) / shareSum);
      lineKg = Math.max(MIN_UNIT_WEIGHT_KG * qty, lineKg);
      assignedKg = roundMoney2(assignedKg + lineKg);
    }
    const unitWeightKg = Math.max(MIN_UNIT_WEIGHT_KG, roundMoney2(lineKg / qty));
    // Recompute lineKg from rounded unit to keep unit×qty consistent for courier line payloads.
    const consistentLineKg = roundMoney2(unitWeightKg * qty);
    const unitDimWeightKg = dimWeightKgFromDimsCm({
      lengthCm: pkgL,
      widthCm: pkgW,
      heightCm: unitHeightCm
    });
    row.unitWeightKg = unitWeightKg;
    row.lineWeightKg = consistentLineKg;
    row.lengthCm = pkgL;
    row.widthCm = pkgW;
    row.heightCm = unitHeightCm;
    row.unitDimWeightKg = unitDimWeightKg;
    row.lineDimWeightKg =
      unitDimWeightKg != null ? roundMoney2(unitDimWeightKg * qty) : null;
    // Mark as package-aligned (not a catalog edit — order snapshot only).
    row.packageAligned = true;
  }

  // Fix residual kg on last active line after unit rounding (keep package total exact).
  const sumLines = roundMoney2(
    active.reduce((s, r) => s + Number(r.lineWeightKg || 0), 0)
  );
  const drift = roundMoney2(targetKg - sumLines);
  if (Math.abs(drift) >= 0.01 && active.length) {
    const last = active[active.length - 1];
    const qty = Math.max(1, Number(last.quantity) || 1);
    const nextLineKg = Math.max(MIN_UNIT_WEIGHT_KG * qty, roundMoney2(Number(last.lineWeightKg) + drift));
    last.lineWeightKg = nextLineKg;
    last.unitWeightKg = Math.max(MIN_UNIT_WEIGHT_KG, roundMoney2(nextLineKg / qty));
    last.lineWeightKg = roundMoney2(last.unitWeightKg * qty);
  }

  return rows;
}

/**
 * Set order package totals (packed box) and align snapshot line weights/dims so
 * courier item-level + package-level metrics stay consistent (no catalog writes).
 */
function applyPackageShippingOverrideToSnapshot(snap, packageOverride, meta = {}) {
  const checked = validatePackageShippingOverride(packageOverride);
  if (!checked.ok) {
    return { ok: false, code: 'PACKAGE_OVERRIDE_INVALID', message: 'Invalid packageOverride', errors: checked.errors };
  }
  const data = checked.data;
  const packageDims = {
    lengthCm: data.lengthCm,
    widthCm: data.widthCm,
    heightCm: data.heightCm
  };
  const baseLines = Array.isArray(snap?.lines) ? snap.lines.map((row) => ({ ...row })) : [];
  const lines = alignSnapshotLinesToPackageTotals(baseLines, data);
  const next = {
    ...(snap && typeof snap === 'object' ? snap : {}),
    totalWeightKg: data.totalWeightKg,
    totalDimWeightKg: dimWeightKgFromDimsCm(packageDims),
    dims: packageDims,
    lines,
    source: 'admin_package_override',
    packageOverride: {
      totalWeightKg: data.totalWeightKg,
      lengthCm: data.lengthCm,
      widthCm: data.widthCm,
      heightCm: data.heightCm,
      overriddenAt: new Date(),
      overriddenBy: meta.adminUserId || null
    }
  };
  return {
    ok: true,
    snapshot: next,
    dimsAgg: dimsAggFromPackageOverride(data)
  };
}

/**
 * Same package rules as checkoutComputation.aggregateShipping, but from snapshot lines
 * (supports admin weight/dim overrides without touching product catalog).
 * @param {Array<{ quantity?: number, unitWeightKg?: number, lengthCm?: number, widthCm?: number, heightCm?: number }>} lines
 */
function aggregateShippingFromWeightLines(lines) {
  let totalWeightKg = 0;
  let maxL = 0;
  let maxW = 0;
  let heightStack = 0;

  for (const row of lines || []) {
    const qty = Math.max(0, Number(row.quantity) || 0);
    if (qty <= 0) continue;
    const w = Number(row.unitWeightKg);
    const unitW = Number.isFinite(w) && w > 0 ? w : 0.5;
    const l = Number(row.lengthCm);
    const wi = Number(row.widthCm);
    const h = Number(row.heightCm);
    totalWeightKg += unitW * qty;
    if (Number.isFinite(l) && l > 0) maxL = Math.max(maxL, l);
    if (Number.isFinite(wi) && wi > 0) maxW = Math.max(maxW, wi);
    if (Number.isFinite(h) && h > 0) heightStack += h * qty;
  }

  const heightCm = Math.min(200, Math.max(1, heightStack || 1));
  return {
    weightKg: Math.max(0.05, roundMoney2(totalWeightKg)),
    lengthCm: maxL || 1,
    widthCm: maxW || 1,
    heightCm
  };
}

/**
 * Rebuild package totals + per-line kg/vol from line rows.
 * @param {object[]} lineSnapshots
 * @param {{ source?: string }} [opts]
 */
function rebuildShippingWeightSnapshotFromLines(lineSnapshots, opts = {}) {
  const lines = (lineSnapshots || []).map((row) => {
    const qty = Math.max(0, Number(row.quantity) || 0);
    const unitWeightKg = Math.max(
      MIN_UNIT_WEIGHT_KG,
      roundMoney2(Number(row.unitWeightKg) || MIN_UNIT_WEIGHT_KG)
    );
    const dims = hasLineDims(row)
      ? {
          lengthCm: Number(row.lengthCm),
          widthCm: Number(row.widthCm),
          heightCm: Number(row.heightCm)
        }
      : null;
    const unitDimWeightKg = dims ? dimWeightKgFromDimsCm(dims) : null;
    return {
      productId: row.productId || null,
      variantId: row.variantId || null,
      productName: row.productName || 'Product',
      sku: row.sku || null,
      quantity: qty,
      unitWeightKg,
      lineWeightKg: roundMoney2(unitWeightKg * qty),
      lengthCm: dims ? dims.lengthCm : row.lengthCm ?? null,
      widthCm: dims ? dims.widthCm : row.widthCm ?? null,
      heightCm: dims ? dims.heightCm : row.heightCm ?? null,
      unitDimWeightKg,
      lineDimWeightKg: unitDimWeightKg != null ? roundMoney2(unitDimWeightKg * qty) : null,
      overridden: Boolean(row.overridden),
      overriddenAt: row.overriddenAt || null,
      overriddenBy: row.overriddenBy || null
    };
  });

  const dimsAgg = aggregateShippingFromWeightLines(lines);
  const packageDims = {
    lengthCm: dimsAgg.lengthCm,
    widthCm: dimsAgg.widthCm,
    heightCm: dimsAgg.heightCm
  };
  const anyOverride = lines.some((l) => l.overridden);
  const source =
    opts.source ||
    (anyOverride ? 'admin_override' : 'checkout');

  return {
    totalWeightKg: dimsAgg.weightKg,
    totalDimWeightKg: dimWeightKgFromDimsCm(packageDims),
    dims: packageDims,
    lines,
    source
  };
}

/**
 * Overlay stored snapshot unit weight/dims onto checkout lines (prefer order snapshot over catalog).
 * @param {Array} checkoutLines
 * @param {object|null} existingSnap
 */
function applySnapshotOverridesToCheckoutLines(checkoutLines, existingSnap) {
  const byKey = new Map();
  for (const row of existingSnap?.lines || []) {
    byKey.set(lineKey(row.productId, row.variantId), row);
  }
  return (checkoutLines || []).map((line) => {
    const pid = line.product?._id || line.productId;
    const vid = line.variant?._id || line.variantId;
    const snap = byKey.get(lineKey(pid, vid));
    if (!snap) return line;
    const unitWeightKg = Number(snap.unitWeightKg);
    const hasW = Number.isFinite(unitWeightKg) && unitWeightKg > 0;
    const hasD = hasLineDims(snap);
    if (!hasW && !hasD) return line;
    const base = line.resolvedShipping || resolveVariantShipping(line.variant, line.product) || {};
    const resolvedShipping = {
      ...base,
      weight: hasW ? unitWeightKg : base.weight,
      dimensions: hasD
        ? {
            length: Number(snap.lengthCm),
            width: Number(snap.widthCm),
            height: Number(snap.heightCm)
          }
        : base.dimensions
    };
    return { ...line, resolvedShipping };
  });
}

function validateLineShippingOverride(raw) {
  const errors = [];
  const productId = String(raw?.productId || '').trim();
  const variantId = String(raw?.variantId || '').trim();
  if (!productId || !variantId) {
    errors.push('productId and variantId are required');
  }

  const unitWeightKg = Number(raw?.unitWeightKg);
  if (!Number.isFinite(unitWeightKg) || unitWeightKg < MIN_UNIT_WEIGHT_KG) {
    errors.push(`unitWeightKg must be ≥ ${MIN_UNIT_WEIGHT_KG}`);
  } else if (unitWeightKg > MAX_UNIT_WEIGHT_KG) {
    errors.push(`unitWeightKg must be ≤ ${MAX_UNIT_WEIGHT_KG}`);
  }

  const lengthCm = Number(raw?.lengthCm);
  const widthCm = Number(raw?.widthCm);
  const heightCm = Number(raw?.heightCm);
  for (const [label, n] of [
    ['lengthCm', lengthCm],
    ['widthCm', widthCm],
    ['heightCm', heightCm]
  ]) {
    if (!Number.isFinite(n) || n < MIN_DIM_CM) {
      errors.push(`${label} must be ≥ ${MIN_DIM_CM}`);
    } else if (n > MAX_DIM_CM) {
      errors.push(`${label} must be ≤ ${MAX_DIM_CM}`);
    }
  }

  if (errors.length) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      productId,
      variantId,
      unitWeightKg: roundMoney2(unitWeightKg),
      lengthCm: roundMoney2(lengthCm),
      widthCm: roundMoney2(widthCm),
      heightCm: roundMoney2(heightCm)
    }
  };
}

/**
 * Apply per-line weight/dim overrides onto an existing snapshot (remaining order lines).
 * @param {object} snap
 * @param {Array} overrides — validated { productId, variantId, unitWeightKg, lengthCm, widthCm, heightCm }
 * @param {{ adminUserId?: string|null }} [meta]
 */
function findOverrideForSnapshotRow(row, byKey, byVariantId) {
  const key = lineKey(row.productId, row.variantId);
  if (byKey.has(key)) return { override: byKey.get(key), matchKey: key };
  const vid = idStr(row.variantId);
  if (vid && byVariantId.has(vid)) {
    const list = byVariantId.get(vid);
    if (list.length === 1) return { override: list[0], matchKey: lineKey(list[0].productId, list[0].variantId) };
  }
  return null;
}

function applyLineShippingOverridesToSnapshot(snap, overrides, meta = {}) {
  const byKey = new Map();
  const byVariantId = new Map();
  for (const o of overrides || []) {
    const key = lineKey(o.productId, o.variantId);
    byKey.set(key, o);
    const vid = idStr(o.variantId);
    if (!vid) continue;
    if (!byVariantId.has(vid)) byVariantId.set(vid, []);
    byVariantId.get(vid).push(o);
  }
  if (!byKey.size) {
    return { ok: false, code: 'OVERRIDES_REQUIRED', message: 'lineOverrides is required' };
  }

  const existingLines = Array.isArray(snap?.lines) ? snap.lines : [];
  if (!existingLines.length) {
    return { ok: false, code: 'SNAPSHOT_MISSING', message: 'Order has no shipping weight snapshot lines' };
  }

  const matched = new Set();
  const nextLines = existingLines.map((row) => {
    const found = findOverrideForSnapshotRow(row, byKey, byVariantId);
    if (!found) {
      return {
        ...row,
        productId: idStr(row.productId) || row.productId || null,
        variantId: idStr(row.variantId) || row.variantId || null
      };
    }
    matched.add(found.matchKey);
    const o = found.override;
    const unitDimWeightKg = dimWeightKgFromDimsCm({
      lengthCm: o.lengthCm,
      widthCm: o.widthCm,
      heightCm: o.heightCm
    });
    const qty = Math.max(0, Number(row.quantity) || 0);
    return {
      ...row,
      productId: idStr(o.productId) || idStr(row.productId) || row.productId || null,
      variantId: idStr(o.variantId) || idStr(row.variantId) || row.variantId || null,
      unitWeightKg: o.unitWeightKg,
      lineWeightKg: roundMoney2(o.unitWeightKg * qty),
      lengthCm: o.lengthCm,
      widthCm: o.widthCm,
      heightCm: o.heightCm,
      unitDimWeightKg,
      lineDimWeightKg: unitDimWeightKg != null ? roundMoney2(unitDimWeightKg * qty) : null,
      overridden: true,
      overriddenAt: new Date(),
      overriddenBy: meta.adminUserId || null
    };
  });

  for (const key of byKey.keys()) {
    if (!matched.has(key)) {
      return {
        ok: false,
        code: 'LINE_NOT_ON_ORDER',
        message: `No snapshot line for ${key}`
      };
    }
  }

  const rebuilt = rebuildShippingWeightSnapshotFromLines(nextLines, { source: 'admin_override' });
  // Per-line edits own the package math — clear any prior packed-box override.
  if (rebuilt.packageOverride) delete rebuilt.packageOverride;
  return { ok: true, snapshot: rebuilt, dimsAgg: aggregateShippingFromWeightLines(rebuilt.lines) };
}

/**
 * @param {{ lines: Array<{ product: object, variant: object, quantity: number, resolvedShipping?: object }>, totalWeightKg?: number, dims?: object }} input
 */
function buildShippingWeightSnapshotFromCheckoutLines({ lines, totalWeightKg, dims }) {
  const lineSnapshots = (lines || []).map((line) => {
    const qty = Math.max(0, Number(line.quantity) || 0);
    const shipping =
      line.resolvedShipping || resolveVariantShipping(line.variant, line.product);
    const unitWeightKg = unitWeightKgFromResolvedShipping(shipping);
    const variant = line.variant;
    const sku = variant?.sku ? String(variant.sku).trim() : null;
    return {
      productId: line.product?._id || null,
      variantId: variant?._id || null,
      productName: String(line.product?.name || 'Product').trim() || 'Product',
      sku: sku || null,
      quantity: qty,
      unitWeightKg,
      lineWeightKg: roundMoney2(unitWeightKg * qty),
      ...buildLineDimFieldsFromShipping(shipping, qty)
    };
  });

  const sumLines = roundMoney2(lineSnapshots.reduce((s, l) => s + Number(l.lineWeightKg || 0), 0));
  const total = Math.max(0.05, roundMoney2(Number(totalWeightKg) || sumLines));
  const packageDims = {
    lengthCm: dims?.lengthCm != null ? Number(dims.lengthCm) : null,
    widthCm: dims?.widthCm != null ? Number(dims.widthCm) : null,
    heightCm: dims?.heightCm != null ? Number(dims.heightCm) : null
  };

  return {
    totalWeightKg: total,
    totalDimWeightKg: dimWeightKgFromDimsCm(packageDims),
    dims: packageDims,
    lines: lineSnapshots,
    source: 'checkout'
  };
}

/**
 * Legacy orders: derive weights from current catalog (display-only fallback).
 * @param {import('mongoose').Document|object} order
 */
async function buildShippingWeightSnapshotFromOrderItems(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return null;

  const lineSnapshots = [];
  for (const item of items) {
    let productName = 'Product';
    let sku = null;
    let variant = null;
    let product = null;

    if (item.productId) {
      const pid = mongoose.Types.ObjectId.isValid(item.productId) ? item.productId : item.productId?._id;
      let loaded = item.productId;
      if (pid && (!loaded.shipping || typeof loaded.shipping !== 'object' || !loaded.variants)) {
        loaded = await Product.findById(pid).select('name shipping variants').lean();
      }
      if (loaded) {
        product = loaded;
        productName = loaded.name || productName;
        variant = (loaded.variants || []).find((x) => String(x._id) === String(item.variantId)) || null;
        if (variant?.sku) sku = String(variant.sku).trim();
      }
    }

    const shipping = resolveVariantShipping(variant, product);
    const unitWeightKg = unitWeightKgFromResolvedShipping(shipping);
    const qty = Math.max(0, Number(item.quantity) || 0);
    lineSnapshots.push({
      productId: item.productId?._id || item.productId || null,
      variantId: item.variantId || null,
      productName,
      sku,
      quantity: qty,
      unitWeightKg,
      lineWeightKg: roundMoney2(unitWeightKg * qty),
      ...buildLineDimFieldsFromShipping(shipping, qty)
    });
  }

  const totalWeightKg = Math.max(
    0.05,
    roundMoney2(lineSnapshots.reduce((s, l) => s + Number(l.lineWeightKg || 0), 0))
  );

  return {
    totalWeightKg,
    totalDimWeightKg: null,
    dims: { lengthCm: null, widthCm: null, heightCm: null },
    lines: lineSnapshots,
    source: 'catalog_fallback'
  };
}

/**
 * Fill missing per-line dims on stored snapshots (legacy orders) from current catalog.
 * @param {object|null} snap
 */
async function enrichShippingWeightSnapshotDims(snap) {
  if (!snap?.lines?.length) return snap;

  const lines = [...snap.lines];
  const missingProductIds = [
    ...new Set(
      lines
        .filter((row) => !hasLineDims(row) && row?.productId)
        .map((row) => String(row.productId))
    )
  ];

  const productById = new Map();
  if (missingProductIds.length) {
    const ids = missingProductIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const products = await Product.find({ _id: { $in: ids } }).select('shipping variants').lean();
    for (const p of products) {
      productById.set(String(p._id), p);
    }
  }

  let changed = false;
  const enrichedLines = lines.map((row) => {
    if (hasLineDims(row)) return row;
    const product = productById.get(String(row.productId));
    if (!product) return row;
    const variant = (product.variants || []).find((v) => String(v._id) === String(row.variantId)) || null;
    const shipping = resolveVariantShipping(variant, product);
    const dimFields = buildLineDimFieldsFromShipping(shipping, row.quantity);
    if (!Object.keys(dimFields).length) return row;
    changed = true;
    return { ...row, ...dimFields };
  });

  const packageDims = snap.dims || {};
  const totalDimWeightKg =
    snap.totalDimWeightKg != null
      ? snap.totalDimWeightKg
      : dimWeightKgFromDimsCm(packageDims);

  if (!changed && snap.totalDimWeightKg != null) return snap;

  return {
    ...snap,
    totalDimWeightKg,
    lines: enrichedLines
  };
}

/**
 * Package metrics for Shiprocket create/assign — prefer frozen checkout snapshot.
 * @param {object} order
 * @returns {Promise<{ totalWeight: number, maxL: number, maxB: number, maxH: number, lineWeightByVariantId: Map<string, number>, lineDimsByVariantId: Map<string, object> }|null>}
 */
async function resolveShiprocketPackageMetrics(order) {
  const snap = order?.shippingWeightSnapshot;
  const lineWeightByVariantId = new Map();
  const lineDimsByVariantId = new Map();

  if (snap?.lines?.length || hasPackageOverride(snap)) {
    for (const row of snap?.lines || []) {
      if (row?.variantId != null) {
        const vid = String(row.variantId);
        lineWeightByVariantId.set(vid, Number(row.unitWeightKg) || 0.5);
        if (hasLineDims(row)) {
          lineDimsByVariantId.set(vid, {
            length: row.lengthCm,
            width: row.widthCm,
            height: row.heightCm
          });
        }
      }
    }
    // Packed-box override is authoritative for courier package metrics (any provider).
    const pkg = hasPackageOverride(snap) ? dimsAggFromPackageOverride(snap.packageOverride) : null;
    const maxL = Math.max(1, Number(pkg?.lengthCm ?? snap.dims?.lengthCm) || 1);
    const maxB = Math.max(1, Number(pkg?.widthCm ?? snap.dims?.widthCm) || 1);
    const maxH = Math.max(1, Number(pkg?.heightCm ?? snap.dims?.heightCm) || 1);
    const totalWeight = Math.max(
      0.05,
      Number(pkg?.weightKg ?? snap.totalWeightKg) || 0.5
    );
    const dims = {
      lengthCm: maxL,
      widthCm: maxB,
      heightCm: maxH
    };
    return {
      // Canonical names (Shiprocket + shared)
      totalWeight,
      maxL,
      maxB,
      maxH,
      // Aliases for Shipmozo / other readers
      totalWeightKg: totalWeight,
      dims,
      lineWeightByVariantId,
      lineDimsByVariantId,
      packageOverrideApplied: Boolean(pkg)
    };
  }

  return null;
}

module.exports = {
  buildShippingWeightSnapshotFromCheckoutLines,
  buildShippingWeightSnapshotFromOrderItems,
  enrichShippingWeightSnapshotDims,
  resolveShiprocketPackageMetrics,
  dimWeightKgFromDimsCm,
  aggregateShippingFromWeightLines,
  rebuildShippingWeightSnapshotFromLines,
  applySnapshotOverridesToCheckoutLines,
  validateLineShippingOverride,
  applyLineShippingOverridesToSnapshot,
  hasLineDims,
  lineKey,
  idStr,
  hasPackageOverride,
  dimsAggFromPackageOverride,
  validatePackageShippingOverride,
  applyPackageShippingOverrideToSnapshot,
  alignSnapshotLinesToPackageTotals,
  MIN_UNIT_WEIGHT_KG,
  MAX_UNIT_WEIGHT_KG,
  MAX_PACKAGE_WEIGHT_KG,
  MIN_DIM_CM,
  MAX_DIM_CM
};

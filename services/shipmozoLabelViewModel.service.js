/**
 * Build a print view-model for custom Shipmozo 4×6 labels.
 * Shiprocket orders never call this module.
 */

const { sanitizeSettings, defaultSettings } = require('./shipmozoLabelSettings.service');
const { getAppName } = require('../utils/appBrand');

const roundMoney2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function trimText(value, max) {
  const s = String(value || '').trim();
  if (!s) return '';
  const n = Math.max(1, Number(max) || 10);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatInr(n) {
  const v = roundMoney2(n);
  if (!Number.isFinite(v)) return 'Rs. 0';
  return `Rs. ${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatYmd(d) {
  try {
    if (!d) return '';
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  } catch {
    return '';
  }
}

function customerName(addr) {
  return (
    String(addr?.fullName || addr?.name || '').trim() ||
    [addr?.firstName, addr?.lastName].filter(Boolean).join(' ').trim() ||
    'Customer'
  );
}

function customerPhone(addr) {
  const raw = String(addr?.phone || addr?.mobile || addr?.phoneNumber || '').replace(/\D/g, '');
  return raw.slice(-10);
}

function addressLines(addr) {
  const lines = [
    [addr?.houseNumber, addr?.building, addr?.floor].filter(Boolean).join(', '),
    addr?.addressLine1,
    addr?.addressLine2,
    addr?.area,
    addr?.landmark,
    [addr?.city, addr?.state, addr?.postalCode || addr?.pincode].filter(Boolean).join(', '),
    addr?.country || 'India'
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  return lines;
}

function resolveSku(item) {
  try {
    const prod = item?.productId;
    if (prod && typeof prod === 'object' && Array.isArray(prod.variants) && item.variantId) {
      const v = prod.variants.find((x) => String(x._id) === String(item.variantId));
      if (v?.sku) return String(v.sku).trim();
    }
    const snapSku =
      item?.sku ||
      (Array.isArray(item?.variantAttributesSnapshot)
        ? item.variantAttributesSnapshot.find((a) => String(a?.key || '').toLowerCase() === 'sku')
            ?.value
        : null);
    return snapSku ? String(snapSku).trim() : '';
  } catch {
    return '';
  }
}

function resolveProductName(item) {
  try {
    if (item?.productId && typeof item.productId === 'object' && item.productId.name) {
      return String(item.productId.name).trim();
    }
    return String(item?.productName || 'Product').trim() || 'Product';
  } catch {
    return 'Product';
  }
}

/**
 * Label payment strip:
 * - PREPAID → collectable 0
 * - COD (full) → collectable = full order total
 * - PARTIAL (COD) → collectable = remaining balance only
 * Order Total always shows the full customer order total.
 */
function labelPaymentMode(collectable, paidInr) {
  const c = roundMoney2(Number(collectable) || 0);
  const paid = roundMoney2(Number(paidInr) || 0);
  if (!(c > 0.005)) return 'PREPAID';
  if (paid > 0.005) return 'PARTIAL (COD)';
  return 'COD';
}

function paymentAndCollectable(order) {
  const paidInr = roundMoney2(Number(order?.amountPaidInr) || 0);
  try {
    const {
      hasCourierCollectableLock,
      getCustomerFacingCollectableInr,
      getCustomerFacingDeliveryInr,
      getCustomerFacingOrderTotalInr,
      computeLiveCourierCollectable
    } = require('./courierCollectableLock.service');

    if (hasCourierCollectableLock(order)) {
      const collectable = roundMoney2(getCustomerFacingCollectableInr(order));
      return {
        paymentMode: labelPaymentMode(collectable, paidInr),
        collectable,
        orderTotal: getCustomerFacingOrderTotalInr(order),
        shippingCharges: getCustomerFacingDeliveryInr(order)
      };
    }

    const live = computeLiveCourierCollectable(order);
    const collectable = roundMoney2(Number(live.collectable) || 0);
    return {
      paymentMode: labelPaymentMode(collectable, paidInr > 0.005 ? paidInr : live.paidInr),
      collectable,
      orderTotal: live.orderTotal,
      shippingCharges: live.shippingCharges
    };
  } catch {
    // Fallback: previous live math (never break label generation)
    const payMethod = String(order?.paymentInfo?.method || order?.paymentMethod || '')
      .toLowerCase()
      .trim();
    const balanceViaCod =
      String(order?.paymentInfo?.balanceCollectionMethod || '').toLowerCase() === 'cod';
    const totalInr = roundMoney2(Number(order?.totalAmount) || 0);
    let balanceDue = roundMoney2(Math.max(0, Number(order?.balanceDueInr) || 0));
    if (!(balanceDue > 0.005) && paidInr > 0.005 && totalInr > 0.005) {
      balanceDue = roundMoney2(Math.max(0, totalInr - paidInr));
    }
    const unpaidInr = roundMoney2(Math.max(0, totalInr - paidInr));
    if (balanceDue > unpaidInr + 0.005) balanceDue = unpaidInr;
    const useCodAtDoor = payMethod === 'cod' || (balanceViaCod && balanceDue > 0.005);
    const collectable = useCodAtDoor ? (payMethod === 'cod' ? totalInr : balanceDue) : 0;
    return {
      paymentMode: labelPaymentMode(collectable, paidInr),
      collectable: roundMoney2(collectable),
      orderTotal: totalInr,
      shippingCharges: roundMoney2(Number(order?.deliveryCharges) || 0)
    };
  }
}

/** Assigned courier for the label header. Skip aggregator brand; keep original casing. */
function displayCourierName(order) {
  const candidates = [
    order?.shipmentInfo?.courier,
    order?.shippingSnapshot?.courierName
  ];
  for (const raw of candidates) {
    const name = String(raw || '').trim();
    if (!name) continue;
    if (/^ship\s*mozo$/i.test(name)) continue;
    return name;
  }
  return 'Courier';
}

function dimsAndWeight(order) {
  const dims = order?.shippingWeightSnapshot?.dims || {};
  const lengthCm = Math.max(0, Number(dims.lengthCm) || 0);
  const widthCm = Math.max(0, Number(dims.widthCm) || 0);
  const heightCm = Math.max(0, Number(dims.heightCm) || 0);
  const weightKg = Number(order?.shippingWeightSnapshot?.totalWeightKg);
  return {
    dimensionText:
      lengthCm && widthCm && heightCm
        ? `${lengthCm}x${widthCm}x${heightCm}`
        : '—',
    weightText:
      Number.isFinite(weightKg) && weightKg > 0 ? `${roundMoney2(weightKg)} kg` : '—'
  };
}

/**
 * Label pickup / RTO block — always from STORE_* env (not Shipmozo warehouse).
 * Optional Label Settings sellerName overrides the display name only.
 */
function storeAddressLines() {
  const raw = String(process.env.STORE_ADDRESS || '').trim();
  if (!raw) return [];
  const byNl = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byNl.length > 1) return byNl;
  // Soft-wrap long single-line addresses on commas for the 4×6 label.
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 2) return [raw];
  const mid = Math.ceil(parts.length / 2);
  return [parts.slice(0, mid).join(', '), parts.slice(mid).join(', ')];
}

async function resolvePickupWarehouse(_storefront, sellerNameOverride) {
  const override = String(sellerNameOverride || '').trim();
  const envName = String(process.env.STORE_LEGAL_NAME || process.env.STORE_NAME || 'Seller').trim();
  const name = override || envName;
  const phone = String(process.env.STORE_PHONE || '').replace(/\D/g, '').slice(-10);
  const pincode = String(process.env.STORE_PINCODE || '').trim();
  const lines = storeAddressLines();
  return {
    name,
    phone,
    lines,
    pincode,
    source: override ? 'override' : 'env'
  };
}

function resolveItemGstRate(item) {
  const fromItem = Number(item?.gstRate);
  if (Number.isFinite(fromItem) && fromItem >= 0) return fromItem;
  const prod = item?.productId;
  if (prod && typeof prod === 'object') {
    const fromProd = Number(prod.gstRate);
    if (Number.isFinite(fromProd) && fromProd >= 0) return fromProd;
  }
  return 0;
}

function buildLineItems(order, productsCfg) {
  const max = productsCfg.showAllItems
    ? 40
    : Math.max(1, Number(productsCfg.maxLineItems) || 10);
  const items = Array.isArray(order?.items) ? order.items : [];
  const nameMax = Number(productsCfg.trimProductNameUpto) || 18;
  const skuMax = Number(productsCfg.trimSkuUpto) || 10;
  const showGst = Boolean(productsCfg.showGst);
  const lines = [];
  let totalQty = 0;
  let itemsTotal = 0;
  for (const item of items) {
    const qty = Math.max(0, Number(item.quantity) || 0);
    totalQty += qty;
    const unit = roundMoney2(
      qty > 0
        ? (Number(item.priceSnapshot?.total) || 0) / qty
        : Number(item.priceSnapshot?.sale || item.priceSnapshot?.base) || 0
    );
    /** Line sale (pre-tax) — matches checkout priceSnapshot.total. */
    const saleTotal = roundMoney2(Number(item.priceSnapshot?.total) || unit * qty);
    const gstRate = resolveItemGstRate(item);
    const gst =
      showGst && gstRate > 0 && saleTotal > 0 ? roundMoney2((saleTotal * gstRate) / 100) : 0;
    const total = roundMoney2(saleTotal + (showGst ? gst : 0));
    itemsTotal = roundMoney2(itemsTotal + total);
    if (lines.length >= max) continue;
    lines.push({
      name: trimText(resolveProductName(item), nameMax),
      sku: trimText(resolveSku(item), skuMax),
      qty,
      price: unit,
      saleTotal,
      gst,
      gstRate,
      total,
      hsn: String(item.hsnCode || item?.productId?.hsnCode || '').trim(),
      discount: roundMoney2(Number(item.priceSnapshot?.discount) || 0)
    });
  }
  return {
    lines,
    totalQty,
    itemsTotal,
    hiddenCount: Math.max(0, items.length - lines.length)
  };
}

/**
 * @param {object} order
 * @param {object} [settingsPatch]
 */
async function buildLabelViewModel(order, settingsPatch) {
  const settings = sanitizeSettings(settingsPatch || defaultSettings());
  const storefront = String(order?.storefront || '').toLowerCase() === 'wholesale' ? 'wholesale' : 'ecomm';
  const addr = order?.addressSnapshot || {};
  const pay = paymentAndCollectable(order);
  const pack = dimsAndWeight(order);
  const pickup = await resolvePickupWarehouse(storefront, settings.pickup?.sellerName);
  const { lines, totalQty, itemsTotal, hiddenCount } = buildLineItems(order, settings.products);
  const awb = String(order?.shipmentInfo?.awbCode || order?.shipmentInfo?.trackingNumber || '').trim();
  const courier = displayCourierName(order);
  const routingCode = String(
    order?.shipmentInfo?.routingCode || order?.shipmentInfo?.sortCode || ''
  ).trim();
  const rtoRoutingCode = String(order?.shipmentInfo?.rtoRoutingCode || '').trim();
  const eway = String(
    order?.shipmentInfo?.ewayBillNumber ||
      order?.paymentInfo?.ewayBillNumber ||
      order?.gstEwayBill ||
      ''
  ).trim();
  const created = order?.createdAt || new Date();
  const orderId = String(order?.orderId || '').trim();
  const shipmozoId = String(
    order?.shipmentInfo?.shipmozoOrderId ||
      order?.shipmentInfo?.shipmozoReferenceId ||
      order?.shipmentInfo?.shipmentId ||
      ''
  ).trim();

  return {
    settings,
    storefront,
    labelSize: '4x6',
    courier,
    awb,
    shipmozoId,
    orderId,
    shipToName: customerName(addr),
    shipToLines: addressLines(addr),
    shipToPhone: customerPhone(addr),
    paymentMode: pay.paymentMode,
    collectable: pay.collectable,
    /** Full customer order total (prepaid or COD) — meta strip only. */
    orderTotal: pay.orderTotal,
    /** Sum of all line totals (incl. GST when showGst). */
    itemsTotal,
    shippingCharges: pay.shippingCharges,
    dimensionText: pack.dimensionText,
    weightText: pack.weightText,
    routingCode,
    rtoRoutingCode,
    pickup,
    rto: pickup,
    supportEmail: settings.support.email,
    supportMobile: settings.support.mobile,
    invoiceNo: orderId ? `Retail${String(orderId).replace(/\W/g, '').slice(-8)}` : '',
    invoiceDate: formatYmd(created),
    orderDate: formatYmd(created),
    ewayBill: eway,
    lines,
    totalQty,
    hiddenCount,
    gstin: settings.pickup.gstin || String(process.env.STORE_GSTIN || '').trim(),
    poweredBy: getAppName()
  };
}

const SAMPLE_ITEMS = [
  { name: 'SP 312 Wireless Bluetooth Speaker', sku: 'SKU-2734-1', qty: 1, price: 1900, saleTotal: 1900, gstRate: 3, hsn: '85182200', discount: 0 },
  { name: 'Portable Mini Hair Dryer 1800W', sku: 'SKU-2823-1', qty: 1, price: 1200, saleTotal: 1200, gstRate: 3, hsn: '85163200', discount: 0 },
  { name: 'Migraine Relief Head Massager', sku: 'SKU-2682-1', qty: 2, price: 850, saleTotal: 1700, gstRate: 3, hsn: '90191090', discount: 0 },
  { name: '3 in 1 Multi Charging Cable', sku: 'SKU-2659-1', qty: 1, price: 450, saleTotal: 450, gstRate: 3, hsn: '85444900', discount: 0 },
  { name: 'Travel Neck Pillow Memory Foam', sku: 'SKU-0643-1', qty: 1, price: 650, saleTotal: 650, gstRate: 3, hsn: '94049090', discount: 0 },
  { name: '2-in-1 Bedside Lamp with Wireless Charger', sku: 'SKU-0057-1', qty: 1, price: 2100, saleTotal: 2100, gstRate: 3, hsn: '94054090', discount: 0 },
  { name: 'Neev Electra Smart Watch Band', sku: 'SKU-0004-1', qty: 1, price: 990, saleTotal: 990, gstRate: 3, hsn: '91021200', discount: 0 },
  { name: 'Premium Stainless Steel Water Bottle 1L', sku: 'SKU-1188-1', qty: 2, price: 399, saleTotal: 798, gstRate: 3, hsn: '73239390', discount: 0 },
  { name: 'Organic Bamboo Toothbrush Set of 4', sku: 'SKU-3021-1', qty: 1, price: 299, saleTotal: 299, gstRate: 3, hsn: '96032100', discount: 0 },
  { name: 'LED Desk Lamp Adjustable Brightness', sku: 'SKU-4455-1', qty: 1, price: 1550, saleTotal: 1550, gstRate: 3, hsn: '94054020', discount: 0 }
];

function buildSampleLineItems(settings) {
  const p = settings.products || {};
  const nameMax = Number(p.trimProductNameUpto) || 999;
  const skuMax = Number(p.trimSkuUpto) || 999;
  const showGst = Boolean(p.showGst);
  const maxItems = p.showAllItems
    ? SAMPLE_ITEMS.length
    : Math.max(1, Number(p.maxLineItems) || 5);
  const visible = SAMPLE_ITEMS.slice(0, maxItems);
  const hiddenCount = Math.max(0, SAMPLE_ITEMS.length - visible.length);
  let itemsTotal = 0;
  let totalQtyAll = 0;
  for (const item of SAMPLE_ITEMS) {
    const saleTotal = roundMoney2(Number(item.saleTotal) || Number(item.price) * Number(item.qty) || 0);
    const gstRate = Number(item.gstRate) || 0;
    const gst = showGst && gstRate > 0 && saleTotal > 0 ? roundMoney2((saleTotal * gstRate) / 100) : 0;
    itemsTotal = roundMoney2(itemsTotal + saleTotal + (showGst ? gst : 0));
    totalQtyAll += Number(item.qty) || 0;
  }
  const lines = visible.map((item) => {
    const saleTotal = roundMoney2(Number(item.saleTotal) || Number(item.price) * Number(item.qty) || 0);
    const gstRate = Number(item.gstRate) || 0;
    const gst = showGst && gstRate > 0 && saleTotal > 0 ? roundMoney2((saleTotal * gstRate) / 100) : 0;
    return {
      name: trimText(item.name, nameMax),
      sku: trimText(item.sku, skuMax),
      qty: item.qty,
      price: item.price,
      saleTotal,
      gst,
      gstRate,
      total: roundMoney2(saleTotal + (showGst ? gst : 0)),
      hsn: item.hsn,
      discount: item.discount || 0
    };
  });
  return {
    lines,
    totalQty: totalQtyAll,
    itemsTotal,
    hiddenCount
  };
}

function buildSampleViewModel(settingsPatch, storefront) {
  const settings = sanitizeSettings(settingsPatch || defaultSettings());
  const sf = String(storefront || '').toLowerCase() === 'wholesale' ? 'wholesale' : 'ecomm';
  return {
    settings,
    storefront: sf,
    labelSize: '4x6',
    courier: 'XpressBees 10Kg',
    awb: 'SM1234567890',
    shipmozoId: '86543821',
    orderId: sf === 'wholesale' ? 'OWB-WH-865438' : 'OWB-ECOMM-865438',
    shipToName: 'John Wick',
    shipToLines: ['221B Baker Street', 'Connaught Place', 'New Delhi, Delhi, 110001', 'India'],
    shipToPhone: '9999999999',
    paymentMode: 'COD',
    collectable: 2000.6,
    orderTotal: 2000.6,
    shippingCharges: 0,
    dimensionText: '10x10x10',
    weightText: '1.5 kg',
    routingCode: 'DEL/UKH',
    rtoRoutingCode: 'DEL/UEY',
    pickup: {
      name: 'Manish Hasmukh Mehta',
      phone: '9001234567',
      lines: ['Sunshine Plaza, Sector 12', 'Near Main Road', 'Gurgaon, Haryana, 122018'],
      pincode: '122018'
    },
    rto: {
      name: 'Manish Hasmukh Mehta',
      phone: '9001234567',
      lines: ['Sunshine Plaza, Sector 12', 'Gurgaon, Haryana, 122018'],
      pincode: '122018'
    },
    supportEmail: settings.support.email,
    supportMobile: settings.support.mobile,
    invoiceNo: 'Retail16366',
    invoiceDate: '2025/01/03',
    orderDate: '2025/01/01',
    ewayBill: '1234567890',
    ...buildSampleLineItems(settings),
    gstin: settings.pickup.gstin,
    poweredBy: getAppName()
  };
}

module.exports = {
  buildLabelViewModel,
  buildSampleViewModel,
  resolvePickupWarehouse,
  formatInr,
  trimText,
  labelPaymentMode,
  paymentAndCollectable
};

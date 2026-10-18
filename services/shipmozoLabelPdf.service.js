  /**
 * Render Shipmozo 4×6 shipping label as PDF (288×432 pt) and preview HTML.
 * Visual layout matches Shiprocket standard label: stacked bands, not cramped cells.
 */

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const axios = require('axios');
const sharp = require('sharp');
const { formatInr } = require('./shipmozoLabelViewModel.service');
const { labelLogoActive } = require('./shipmozoLabelLogo.service');
const logger = require('../utils/logger');
const { getAppName, getAppNameSlug } = require('../utils/appBrand');

const PAGE_W = 4 * 72;
const PAGE_H = 6 * 72;
const MARGIN = 7;
/** Square logo target — preview (px) and print (pt). */
const LABEL_LOGO_SQUARE_PX = 96;
const LABEL_LOGO_SQUARE_PT = 90;

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Barcode flush with caption left edge — no left quiet-zone indent. */
const BARCODE_OPTS = {
  bcid: 'code128',
  includetext: false,
  backgroundcolor: 'FFFFFF',
  paddingleft: 0,
  paddingright: 4,
  paddingtop: 0,
  paddingbottom: 0,
  paddingwidth: 0
};

async function barcodePng(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    return await bwipjs.toBuffer({
      ...BARCODE_OPTS,
      text: value,
      scale: 3,
      height: 14
    });
  } catch (err) {
    logger.warn('barcodePng failed', { message: err?.message });
    return null;
  }
}

function barcodeSvgMarkup(text, className) {
  const value = String(text || '').trim();
  if (!value) return '';
  try {
    const svg = bwipjs.toSVG({
      ...BARCODE_OPTS,
      text: value,
      scale: 3,
      height: 12,
      paddingheight: 0
    });
    return `<div class="${className}">${svg}</div>`;
  } catch (err) {
    logger.warn('barcodeSvgMarkup failed', { message: err?.message });
    return '';
  }
}

/**
 * Column weights from trim settings.
 * Item width follows name trim (do not shrink name to “save” SKU).
 * SKU gets enough width for trimSkuUpto chars; room taken from GST / Price / Total.
 */
function buildProductColDefs(productsCfg) {
  const p = productsCfg || {};
  const nameMax = Math.max(4, Number(p.trimProductNameUpto) || 18);
  const skuMax = Math.max(4, Number(p.trimSkuUpto) || 15);
  const showGst = Boolean(p.showGst);
  // Keep Item readable for configured name trim (e.g. 18 chars).
  const itemW = Math.min(0.3, Math.max(0.14, 0.04 + nameMax * 0.011));
  // SKU must fit trimmed value (e.g. SKU-2734-1) — was capped too low → "SKU-…".
  const skuW = Math.min(0.22, Math.max(0.14, 0.055 + skuMax * 0.0095));
  const qtyW = 0.055;
  const hsnW = 0.08;
  // GST / money cols tightened so SKU + Item both stay readable on 4×6.
  const priceW = showGst ? 0.11 : 0.145;
  const gstW = showGst ? 0.155 : 0;
  const totalW = showGst ? 0.11 : 0.14;
  const cols = [];
  if (p.showItem) cols.push({ key: 'name', title: 'Item', w: itemW });
  if (p.showSku) cols.push({ key: 'sku', title: 'SKU', w: skuW });
  if (p.showHsn) cols.push({ key: 'hsn', title: 'HSN', w: hsnW });
  if (p.showQty) cols.push({ key: 'qty', title: 'Qty', w: qtyW, center: true });
  if (p.showPrice) cols.push({ key: 'price', title: 'Price', w: priceW });
  if (p.showGst) cols.push({ key: 'gst', title: 'GST - %', w: gstW });
  if (p.showTotal) cols.push({ key: 'total', title: 'Total', w: totalW });
  return cols;
}

/** GST cell: "Rs. 57 - 3%" — amount then rate. */
function formatGstWithRate(line) {
  const amount = formatInr(line?.gst);
  const rate = Number(line?.gstRate);
  const rateStr =
    Number.isFinite(rate) && rate > 0
      ? `${Number.isInteger(rate) ? rate : Math.round(rate * 100) / 100}%`
      : '0%';
  return `${amount} - ${rateStr}`;
}

/** Spaces between "Key:" and value (visual gap on the label). */
const KEY_VAL_GAP = '   ';
/** HTML collapses normal spaces — use nbsp so the gap shows in preview. */
const KEY_VAL_GAP_HTML = '&nbsp;&nbsp;&nbsp;';

/** Draw "Key:   value" with lightly bold key and gap before the value. */
function txtKeyValue(doc, keyLabel, value, x, y, w, opts = {}) {
  const fontSize = opts.fontSize || 7;
  const height = opts.height || 9;
  const keyText = /:\s*$/.test(String(keyLabel))
    ? `${String(keyLabel).trim()}${KEY_VAL_GAP}`
    : `${String(keyLabel).trim()}:${KEY_VAL_GAP}`;
  const val = String(value == null ? '' : value);
  doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#111111');
  const kw = doc.widthOfString(keyText);
  if (kw >= w - 4) {
    txt(doc, `${keyText}${val}`, x, y, w, { fontSize, bold: true, height, wrap: false, align: opts.align || 'left' });
    return;
  }
  doc.text(keyText, x, y, { width: kw + 1, height, lineBreak: false, ellipsis: false });
  doc.font(opts.valueBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
  doc.text(val, x + kw, y, {
    width: Math.max(6, w - kw),
    height,
    lineBreak: false,
    ellipsis: true,
    align: opts.align || 'left'
  });
}

function strokeRect(doc, x, y, w, h) {
  doc.save();
  doc.lineWidth(0.8).strokeColor('#333333').rect(x, y, w, h).stroke();
  doc.restore();
}

function hLine(doc, x, y, w) {
  doc.save();
  doc.lineWidth(0.5).strokeColor('#333333').moveTo(x, y).lineTo(x + w, y).stroke();
  doc.restore();
}

function txt(doc, text, x, y, w, opts = {}) {
  const fontSize = opts.fontSize || 7;
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor('#111111');
  const wrap = opts.wrap !== false;
  const ellipsis = opts.ellipsis === true || (!wrap && opts.ellipsis !== false);
  doc.text(String(text == null ? '' : text), x, y, {
    width: w,
    height: opts.height || 11,
    ellipsis,
    lineBreak: wrap,
    align: opts.align || 'left',
    lineGap: opts.lineGap ?? 0
  });
}

function wrappedTextHeight(doc, text, width, fontSize, bold = false) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
  return doc.heightOfString(String(text || ''), { width, lineGap: 0.5 });
}

function computeShipBandHeight(doc, vm, s, custW, showLogoCol, logoColW) {
  const textW = Math.max(48, custW - 14);
  let h = 4 + 10;
  if (s.delivery?.showCustomerAddress) {
    h += 11;
    const addrText = (vm.shipToLines || []).join('\n');
    h += wrappedTextHeight(doc, addrText, textW, 7) + 1;
  }
  if (s.delivery?.showCustomerPhone && vm.shipToPhone) h += 9;
  h += 3;
  const logoNeed = showLogoCol ? LABEL_LOGO_SQUARE_PT + 10 : 0;
  return Math.min(120, Math.max(h, logoNeed, 36));
}

function computeMetaBandHeight(vm, s) {
  const metas = metaLines(vm, s);
  const lineH = 9.5;
  const leftH = 4 + metas.length * lineH + 3;
  let rightH = 14;
  if (s.delivery?.showAwbBarcode) {
    if (String(vm.providerChannelId || vm.shipmozoId || '').trim()) rightH += 9;
    rightH += 36 + 2;
    if (vm.awb) rightH += 9;
  }
  rightH += 3;
  return Math.max(leftH, rightH, 36);
}

function computeShippedByBandHeight(doc, vm, s) {
  const innerW = PAGE_W - MARGIN * 2;
  const shipW = Math.round(innerW * 0.52);
  const textW = Math.max(48, shipW - 10);
  let h = 4 + 10;
  if (s.pickup?.showPickupName && vm.pickup?.name) h += 10;
  if (s.pickup?.showPickupAddress) {
    const addrText = (vm.pickup?.lines || []).join('\n');
    h += wrappedTextHeight(doc, addrText, textW, 6.5) + 2;
  }
  if (s.pickup?.showPickupPhone && vm.pickup?.phone) h += 9;
  if (s.support?.showCustomerSupport) {
    const support = [vm.supportEmail, vm.supportMobile].filter(Boolean).join('  ');
    if (support) {
      h += wrappedTextHeight(doc, `Customer Care: ${support}`, textW, 6) + 3;
    }
  }
  if (s.pickup?.showGstin && vm.gstin) h += 9;
  h += 8;
  const invCount = [
    s.misc?.showInvoiceNumber && vm.invoiceNo,
    s.misc?.showInvoiceDate && vm.invoiceDate,
    s.misc?.showOrderDate && vm.orderDate
  ].filter(Boolean).length;
  const rightMinH = 4 + 12 + (s.delivery?.showOrderBarcode ? 24 : 0) + invCount * 8 + 8;
  return Math.max(h, rightMinH);
}

function computeTableLayout(vm, s, shipH, band2H = 90, band3H = 70) {
  const pageInnerH = PAGE_H - MARGIN * 2;
  const notesShown = Boolean(s.misc?.showNotes && s.misc?.notes);
  const footShown = Boolean(s.misc?.showAutoGeneratedDisclaimer || s.misc?.showPoweredBy);
  const sourceLines = Array.isArray(vm.lines) ? vm.lines : [];
  const baseHidden = Math.max(0, Number(vm.hiddenCount) || 0);
  const showCollectable = Boolean(s.products?.showCollectableAmount);
  const showQty = Boolean(s.products?.showTotalQuantity);
  // Items Total + Qty + Collectable Amount (same weight as before — no oversized COLLECT).
  const totalsLines = 1 + (showQty ? 1 : 0) + (showCollectable ? 1 : 0);
  const totalsH = Math.max(22, 6 + totalsLines * 10);
  const variants = [
    {
      awbBarH: 38,
      orderBarH: 20,
      notesGap: notesShown ? 6 : 2,
      headerH: 13,
      rowH: 13,
      totalsH,
      notesH: notesShown ? 24 : 0,
      footH: footShown ? 18 : 0,
      metaFont: 7,
      valueFont: 7,
      courierFont: 8.3,
      secondaryFont: 6.7,
      compactHtmlClass: 'compact'
    },
    {
      awbBarH: 30,
      orderBarH: 16,
      notesGap: notesShown ? 4 : 1,
      headerH: 13,
      rowH: 12,
      totalsH,
      notesH: notesShown ? 22 : 0,
      footH: footShown ? 16 : 0,
      metaFont: 6.5,
      valueFont: 6.5,
      courierFont: 7.6,
      secondaryFont: 6.1,
      compactHtmlClass: 'tight'
    }
  ];

  let chosen = null;
  for (const variant of variants) {
    const reserveBase =
      shipH + band2H + band3H + variant.totalsH + variant.notesH + variant.footH + variant.notesGap + variant.headerH;
    const fitWithoutHidden = Math.floor((pageInnerH - reserveBase) / variant.rowH);
    const fitWithHidden = Math.floor((pageInnerH - reserveBase - 10) / variant.rowH);
    const needHiddenHint = baseHidden > 0 || sourceLines.length > Math.max(0, fitWithoutHidden);
    const maxRows = Math.max(1, needHiddenHint ? fitWithHidden : fitWithoutHidden);
    const visibleCount = Math.max(1, Math.min(sourceLines.length || 1, maxRows));
    const hiddenCount = baseHidden + Math.max(0, sourceLines.length - visibleCount);
    chosen = {
      ...variant,
      band2: band2H,
      band3: band3H,
      visibleLines: sourceLines.slice(0, visibleCount),
      hiddenCount
    };
    if (hiddenCount === 0) break;
  }
  return chosen || {
    ...variants[variants.length - 1],
    band2: band2H,
    band3: band3H,
    visibleLines: sourceLines.slice(0, 1),
    hiddenCount: baseHidden + Math.max(0, sourceLines.length - 1)
  };
}

function fitOneLine(doc, text, x, y, w, opts = {}) {
  const raw = String(text == null ? '' : text);
  let size = opts.fontSize || 8;
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#111111');
  while (size > 5.5) {
    doc.fontSize(size);
    if (doc.widthOfString(raw) <= w) break;
    size -= 0.35;
  }
  txt(doc, raw, x, y, w, { ...opts, fontSize: size, wrap: false });
}

function metaPairs(vm, s) {
  const pairs = [];
  if (vm.dimensionText) pairs.push(['Dimensions', vm.dimensionText]);
  if (s.delivery?.showPaymentMode && vm.paymentMode) pairs.push(['Payment', vm.paymentMode]);
  if (s.misc?.showOrderTotal) pairs.push(['Order Total', formatInr(vm.orderTotal)]);
  if (vm.weightText) pairs.push(['Weight', vm.weightText]);
  if (s.misc?.showEwayBill) pairs.push(['EWaybill No', vm.ewayBill || 'NA']);
  if (s.delivery?.showRoutingCode) pairs.push(['Routing code', vm.routingCode || 'NA']);
  if (s.delivery?.showRtoRoutingCode) pairs.push(['RTO Routing code', vm.rtoRoutingCode || 'NA']);
  return pairs;
}

function metaLines(vm, s) {
  return metaPairs(vm, s).map(([k, v]) => `${k}:${KEY_VAL_GAP}${v}`);
}

function shipToBandHtml(vm, s, addr) {
  const phone =
    s.delivery?.showCustomerPhone && vm.shipToPhone
      ? `<div><span class="meta-k">Ph:</span>${KEY_VAL_GAP_HTML}${escapeHtml(vm.shipToPhone)}</div>`
      : '';
  const addressBlock =
    s.delivery?.showCustomerAddress
      ? `<div class="b h ship-to-name">${escapeHtml(vm.shipToName)}</div><div class="ship-to-addr">${addr}</div>`
      : '';
  const left = `<div class="ship-to-left"><div class="b">Ship To</div>${addressBlock}${phone}</div>`;
  const logoUrl = String(s.branding?.logoUrl || '').trim();
  if (labelLogoActive(s) && logoUrl) {
    return `<div class="ship-to-band rule">${left}<div class="ship-to-logo"><div class="ship-to-logo-box"><img src="${escapeHtml(logoUrl)}" alt="" /></div></div></div>`;
  }
  return `<div class="pad rule">${left}</div>`;
}

async function fetchLogoBuffer(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  try {
    const res = await axios.get(u, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 2 * 1024 * 1024,
      headers: { Accept: 'image/*,*/*', 'User-Agent': `${getAppNameSlug()}-Label/1.0` },
      validateStatus: (st) => st >= 200 && st < 400
    });
    const buf = Buffer.from(res.data || []);
    if (buf.length < 32) return null;
    // PDFKit cannot embed WebP; convert to PNG for print.
    return await sharp(buf).rotate().png().toBuffer();
  } catch (err) {
    logger.warn('fetchLogoBuffer failed', { message: err?.message, url: u.slice(0, 80) });
    return null;
  }
}

async function renderLabelPdf(vm) {
  const s = vm.settings || {};
  const innerW = PAGE_W - MARGIN * 2;
  const chunks = [];
  const awbBar = s.delivery?.showAwbBarcode ? await barcodePng(vm.awb) : null;
  const orderBar = s.delivery?.showOrderBarcode ? await barcodePng(vm.orderId) : null;
  let logoBuf = null;
  if (labelLogoActive(s)) {
    logoBuf = await fetchLogoBuffer(s.branding?.logoUrl);
    if (!logoBuf) {
      logger.warn('label logo enabled but fetchLogoBuffer returned null', {
        logoUrl: s.branding?.logoUrl,
        showLogo: s.branding?.showLogo
      });
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    try {
      const doc = new PDFDocument({
        size: [PAGE_W, PAGE_H],
        margin: 0,
        autoFirstPage: true,
        info: { Title: `Shipmozo label ${vm.orderId || vm.awb || ''}`.trim() }
      });
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', fail);

      const x0 = MARGIN;
      let y = MARGIN;
      const pageInnerH = PAGE_H - MARGIN * 2;
      strokeRect(doc, x0, y, innerW, pageInnerH);

      const showLogoCol = Boolean(logoBuf);
      const custW = showLogoCol ? Math.round(innerW * 0.6) : innerW;
      const logoColW = innerW - custW;
      const addrTextW = Math.max(60, custW - 14);
      const shipH = computeShipBandHeight(doc, vm, s, custW, showLogoCol, logoColW);
      const band2H = computeMetaBandHeight(vm, s);
      const band3H = computeShippedByBandHeight(doc, vm, s);
      const layout = computeTableLayout(vm, s, shipH, band2H, band3H);

      let cy = y + 4;
      txt(doc, 'Ship To', x0 + 6, cy, addrTextW, { fontSize: 7, bold: true, height: 9 });
      cy += 10;
      if (s.delivery?.showCustomerAddress) {
        txt(doc, vm.shipToName, x0 + 6, cy, addrTextW, {
          fontSize: 7.5, bold: true, height: 10, wrap: false, ellipsis: true
        });
        cy += 11;
        const addrText = (vm.shipToLines || []).join('\n');
        const addrH = wrappedTextHeight(doc, addrText, addrTextW, 7);
        txt(doc, addrText, x0 + 6, cy, addrTextW, {
          fontSize: 7, wrap: true, height: addrH + 1, ellipsis: false, lineGap: 0.3
        });
        cy += addrH + 1;
      }
      if (s.delivery?.showCustomerPhone && vm.shipToPhone) {
        txtKeyValue(doc, 'Ph', vm.shipToPhone, x0 + 6, cy, addrTextW, { fontSize: 6.5, height: 8 });
      }
      if (showLogoCol) {
        try {
          const logoPad = 4;
          const logoBox = Math.min(LABEL_LOGO_SQUARE_PT, logoColW - logoPad * 2, shipH - logoPad * 2);
          const logoX = x0 + custW + (logoColW - logoBox) / 2;
          const logoY = y + (shipH - logoBox) / 2;
          doc.image(logoBuf, logoX, logoY, { fit: [logoBox, logoBox], align: 'center', valign: 'center' });
        } catch (imgErr) {
          logger.warn('label logo image failed', { message: imgErr?.message });
        }
      }
      hLine(doc, x0, y + shipH, innerW);
      y += shipH;

      const band2 = layout.band2;
      const splitX = x0 + Math.round(innerW * 0.52);
      const leftW = splitX - x0;
      const rightW = innerW - leftW;
      const barX = splitX + 6;
      const barW = rightW - 12;
      const metas = metaPairs(vm, s);
      let my = y + 4;
      metas.forEach(([k, v]) => {
        txtKeyValue(doc, k, v, x0 + 6, my, leftW - 10, { fontSize: layout.metaFont, height: 9 });
        my += 9.5;
      });
      // Right column barcode stack — all captions flush-left with barcode (barX).
      let rcy = y + 4;
      fitOneLine(doc, vm.courier || 'Courier', barX, rcy, barW, {
        fontSize: layout.courierFont, bold: true, align: 'left', height: 9
      });
      rcy += 10;
      const providerChannelId = String(vm.providerChannelId || vm.shipmozoId || '').trim();
      const providerChannelIdLabel = String(
        vm.providerChannelIdLabel || (vm.shipmozoId ? 'Shipmozo ID' : 'Shipment ID')
      ).trim();
      const awbId = String(vm.awb || '').trim();
      if (s.delivery?.showAwbBarcode) {
        const barH = layout.awbBarH;
        if (providerChannelId && providerChannelIdLabel) {
          txtKeyValue(doc, providerChannelIdLabel, providerChannelId, barX, rcy, barW, {
            fontSize: layout.secondaryFont, height: 8
          });
          rcy += 9;
        }
        if (awbBar) {
          try {
            // fit + align left: same left edge as captions (no centered stretch).
            doc.image(awbBar, barX, rcy, { fit: [barW, barH], align: 'left', valign: 'center' });
          } catch (e) { logger.warn('AWB barcode image failed', { message: e?.message }); }
          rcy += barH + 2;
        }
        if (awbId) {
          txtKeyValue(doc, 'AWB', awbId, barX, rcy, barW, {
            fontSize: layout.valueFont, height: 8
          });
        }
      }
      hLine(doc, x0, y + band2, innerW);
      y += band2;

      const band3 = layout.band3;
      const shipW = leftW;
      let lcy = y + 4;
      txt(doc, 'Shipped By (if undelivered, return to)', x0 + 6, lcy, shipW - 10, {
        fontSize: 6, bold: true, height: 8
      });
      lcy += 9;
      if (s.pickup?.showPickupName && vm.pickup?.name) {
        txt(doc, vm.pickup.name, x0 + 6, lcy, shipW - 10, { fontSize: 7, bold: true, height: 9 });
        lcy += 9;
      }
      if (s.pickup?.showPickupAddress) {
        const addrText = (vm.pickup?.lines || []).join('\n');
        const addrH = wrappedTextHeight(doc, addrText, shipW - 10, 6.5);
        txt(doc, addrText, x0 + 6, lcy, shipW - 10, { fontSize: 6.5, wrap: true, height: addrH + 1 });
        lcy += addrH + 1;
      }
      if (s.pickup?.showPickupPhone && vm.pickup?.phone) {
        txtKeyValue(doc, 'Ph', vm.pickup.phone, x0 + 6, lcy, shipW - 10, { fontSize: 6.5, height: 7 });
        lcy += 8;
      }
      if (s.support?.showCustomerSupport) {
        const support = [vm.supportEmail, vm.supportMobile].filter(Boolean).join('  ');
        if (support) {
          const careH = wrappedTextHeight(doc, `Customer Care: ${support}`, shipW - 10, 6);
          txtKeyValue(doc, 'Customer Care', support, x0 + 6, lcy, shipW - 10, {
            fontSize: 6, height: Math.max(9, careH + 1)
          });
          lcy += Math.max(9, careH + 1);
        }
      }
      if (s.pickup?.showGstin && vm.gstin) {
        txtKeyValue(doc, 'GSTIN', vm.gstin, x0 + 6, lcy, shipW - 10, { fontSize: 6.5, height: 7 });
      }

      let rcy2 = y + 4;
      txtKeyValue(doc, 'Order#', vm.orderId || '', barX, rcy2, barW, {
        fontSize: 7, height: 9, valueBold: true
      });
      rcy2 += 10;
      if (orderBar) {
        try {
          doc.image(orderBar, barX, rcy2, {
            fit: [barW, layout.orderBarH],
            align: 'left',
            valign: 'center'
          });
        } catch (e) { logger.warn('Order barcode image failed', { message: e?.message }); }
        rcy2 += layout.orderBarH + 2;
      }
      const inv = [];
      if (s.misc?.showInvoiceNumber && vm.invoiceNo) inv.push(['Invoice No', vm.invoiceNo]);
      if (s.misc?.showInvoiceDate && vm.invoiceDate) inv.push(['Invoice Date', vm.invoiceDate]);
      if (s.misc?.showOrderDate && vm.orderDate) inv.push(['Order Date', vm.orderDate]);
      if (inv.length) {
        for (const [ik, iv] of inv) {
          txtKeyValue(doc, ik, iv, barX, rcy2, barW, {
            fontSize: 6.2, height: 8
          });
          rcy2 += 8;
        }
      }
      const usedBand3 = Math.max(band3, lcy - y + 6, rcy2 - y + 6);
      hLine(doc, x0, y + usedBand3, innerW);
      y += usedBand3;

      const p = s.products || {};
      const cols = buildProductColDefs(p);
      const colSum = cols.reduce((a, c) => a + c.w, 0) || 1;
      cols.forEach((c) => {
        c.px = (c.w / colSum) * innerW;
      });

      const rowH = layout.rowH;
      const headerH = 13;
      const visibleLines = layout.visibleLines;
      const hiddenCount = layout.hiddenCount;
      const totalsH = layout.totalsH || 22;
      let cx = x0;
      cols.forEach((c) => {
        txt(doc, c.title, cx + 4, y + 3, c.px - 6, { fontSize: 6.5, bold: true, height: 9 });
        cx += c.px;
      });
      hLine(doc, x0, y + headerH, innerW);
      let ry = y + headerH + 2;
      visibleLines.forEach((line, idx) => {
        cx = x0;
        cols.forEach((c) => {
          let val = line[c.key];
          if (c.key === 'gst') val = formatGstWithRate(line);
          else if (c.key === 'price' || c.key === 'total') val = formatInr(val);
          txt(doc, val, cx + 4, ry, c.px - 6, { fontSize: 6.5, height: 10, wrap: false });
          cx += c.px;
        });
        ry += rowH;
        if (idx < visibleLines.length - 1) {
          doc.save();
          doc.lineWidth(0.3).strokeColor('#cccccc').moveTo(x0, ry - 1).lineTo(x0 + innerW, ry - 1).stroke();
          doc.restore();
        }
      });
      if (hiddenCount > 0) {
        txt(doc, `+${hiddenCount} more item(s)`, x0 + 4, ry, innerW - 8, { fontSize: 6, height: 7 });
        ry += 9;
      }
      hLine(doc, x0, ry, innerW);
      if (p.showShippingCharges) {
        txtKeyValue(doc, 'Shipping Charges', formatInr(vm.shippingCharges), x0 + 4, ry + 4, innerW * 0.42, {
          fontSize: 6.5, height: 9
        });
      }
      const rightColX = x0 + innerW * 0.42;
      const rightColW = innerW * 0.56 - 6;
      let rightY = ry + 3;
      // Order: Items Total → Qty → Collectable (door). Meta "Order Total" stays full order total.
      const itemsTotalNum = Math.round((Number(vm.itemsTotal) || 0) * 100) / 100;
      txt(doc, `Items Total:${KEY_VAL_GAP}${formatInr(itemsTotalNum)}`, rightColX, rightY, rightColW, {
        fontSize: 7, bold: false, align: 'right', height: 9
      });
      rightY += 9;
      if (p.showTotalQuantity) {
        txt(doc, `Total Quantity:${KEY_VAL_GAP}${vm.totalQty}`, rightColX, rightY, rightColW, {
          fontSize: 7, bold: false, align: 'right', height: 9
        });
        // Tight gap before Collectable (was too large).
        rightY += 8;
      }
      if (p.showCollectableAmount) {
        const collectableNum = Math.round((Number(vm.collectable) || 0) * 100) / 100;
        txt(doc, `Collectable Amount:${KEY_VAL_GAP}${formatInr(collectableNum)}`, rightColX, rightY, rightColW, {
          fontSize: 8.5,
          bold: true,
          align: 'right',
          height: 10
        });
      }
      y = ry + totalsH;
      hLine(doc, x0, y, innerW);

      const pageBottom = MARGIN + pageInnerH;
      const hasFooter = s.misc?.showAutoGeneratedDisclaimer || s.misc?.showPoweredBy;
      const hasNotes = layout.notesH > 0;
      // Footer near page bottom; clear gap above it from notes / content.
      const footY = hasFooter ? pageBottom - 7 : pageBottom;
      if (hasNotes) {
        const notesTop = footY - 10 - layout.notesH;
        doc.save();
        doc.lineWidth(0.5).strokeColor('#333333').rect(x0 + 5, notesTop, innerW - 10, layout.notesH).stroke();
        doc.restore();
        txt(doc, s.misc.notes, x0 + 8, notesTop + 3, innerW - 16, {
          fontSize: layout.secondaryFont,
          wrap: true,
          height: layout.notesH - 6
        });
      }
      if (s.misc?.showAutoGeneratedDisclaimer) {
        txt(
          doc,
          'This is an auto generated label and does not require any signature.',
          x0 + 6,
          footY,
          innerW - 110,
          { fontSize: 5.2, height: 8 }
        );
      }
      if (s.misc?.showPoweredBy) {
        txt(doc, String(vm.poweredBy || getAppName()), x0 + innerW - 108, footY - 1, 102, {
          fontSize: 7,
          bold: true,
          align: 'right',
          height: 9
        });
      }

      doc.end();
    } catch (err) {
      fail(err);
    }
  });
}

async function renderLabelHtml(vm) {
  const s = vm.settings || {};
  const p = s.products || {};
  const showLogoCol = labelLogoActive(s) && String(s.branding?.logoUrl || '').trim();
  const shipH = showLogoCol ? 96 : 72;
  const metaArr = metaPairs(vm, s);
  const band2H = Math.max(40, 10 + metaArr.length * 10.5);
  const band3H = 60;
  const layout = computeTableLayout(vm, s, shipH, band2H, band3H);
  const awbBar =
    s.delivery?.showAwbBarcode && vm.awb ? barcodeSvgMarkup(vm.awb, 'bc-awb') : '';
  const orderBar =
    s.delivery?.showOrderBarcode && vm.orderId ? barcodeSvgMarkup(vm.orderId, 'bc-ord') : '';
  const addr = (vm.shipToLines || []).map(escapeHtml).join('<br/>');
  const pickup = (vm.pickup?.lines || []).map(escapeHtml).join('<br/>');
  const support = [vm.supportEmail, vm.supportMobile].filter(Boolean).join('  ');
  const kvInner = (k, v) =>
    `<span class="meta-k">${escapeHtml(k)}:</span>${KEY_VAL_GAP_HTML}${escapeHtml(v)}`;
  const kv = (k, v) => `<div>${kvInner(k, v)}</div>`;
  const metas = metaArr.map(([k, v]) => kv(k, v)).join('');
  const shipToHtml = shipToBandHtml(vm, s, addr);
  const colDefs = buildProductColDefs(p);
  const colSumPct = colDefs.reduce((a, c) => a + c.w, 0) || 1;
  const colgroup = `<colgroup>${colDefs
    .map((c) => `<col style="width:${((c.w / colSumPct) * 100).toFixed(2)}%" />`)
    .join('')}</colgroup>`;
  const heads = colDefs.map((c) => `<th>${escapeHtml(c.title)}</th>`);
  const visibleLines = layout.visibleLines;
  const hiddenCount = layout.hiddenCount;
  const rows = visibleLines
    .map((line) => {
      const cells = colDefs.map((c) => {
        let val = line[c.key];
        if (c.key === 'gst') val = formatGstWithRate(line);
        else if (c.key === 'price' || c.key === 'total') val = formatInr(val);
        const cls = c.center ? ' class="c"' : '';
        return `<td${cls}>${escapeHtml(val)}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');

  const itemsTotalNum = Math.round((Number(vm.itemsTotal) || 0) * 100) / 100;
  const itemsTotalHtml = `<div>Items Total:${KEY_VAL_GAP_HTML}${escapeHtml(formatInr(itemsTotalNum))}</div>`;
  let collectableHtml = '';
  if (p.showCollectableAmount) {
    const c = Math.round((Number(vm.collectable) || 0) * 100) / 100;
    collectableHtml = `<div class="collectable-line">Collectable Amount:${KEY_VAL_GAP_HTML}${escapeHtml(formatInr(c))}</div>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: #f5f5f5; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }
  .sheet {
    width: calc(100% - 16px); height: calc(100% - 16px);
    border: 1.2px solid #333;
    font-family: Arial, Helvetica, sans-serif;
    color: #111; font-size: 8.5px; line-height: 1.3;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .sheet > .pad, .sheet > .split, .sheet > .ship-to-band { flex: 0 0 auto; }
  .body-tail {
    flex: 1 1 auto; min-height: 0;
    display: flex; flex-direction: column;
  }
  .notes-spacer {
    flex: 1 1 12px;
    min-height: 10px;
    max-height: 26px;
  }
  .pad { padding: 4px 8px; }
  .ship-to-band {
    display: flex; flex-direction: row; align-items: stretch; min-height: ${shipH}px;
    overflow: hidden;
  }
  .ship-to-left {
    flex: 0 1 60%; width: 60%; max-width: 60%; min-width: 0;
    padding: 4px 8px; overflow: hidden;
  }
  .ship-to-name { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 8px; }
  .ship-to-addr {
    margin-top: 1px; font-size: 7.5px; line-height: 1.18;
    word-wrap: break-word; overflow-wrap: break-word; word-break: break-word;
  }
  .ship-to-logo {
    flex: 0 0 40%; width: 40%; max-width: 40%;
    display: flex; align-items: center; justify-content: center;
    padding: 4px 8px; flex-shrink: 0;
  }
  .ship-to-logo-box {
    width: ${LABEL_LOGO_SQUARE_PX}px; height: ${LABEL_LOGO_SQUARE_PX}px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .ship-to-logo-box img {
    width: 100%; height: 100%; object-fit: contain;
  }
  .sheet.compact .ship-to-logo-box { width: 84px; height: 84px; }
  .sheet.tight .ship-to-logo-box { width: 76px; height: 76px; }
  .rule { border-bottom: 1px solid #333; }
  .split { display: flex; min-height: 0; }
  .left { flex: 1 1 auto; min-width: 0; padding: 4px 8px; font-size: 7.5px; line-height: 1.2; }
  .right { flex: 0 0 48%; width: 48%; padding: 4px 7px 4px; text-align: left; min-width: 0;
    display: flex; flex-direction: column; align-items: flex-start; }
  .right.order { flex-basis: 50%; width: 50%; }
  .b { font-weight: 700; }
  .h { font-size: 8px; }
  .tiny { font-size: 7px; line-height: 1.2; }
  .ship-name { font-size: 7.5px; font-weight: 600; margin-top: 1px; }
  .courier-line {
    font-weight: 700; font-size: 8px; line-height: 1.15;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    width: 100%; text-align: left; align-self: stretch;
  }
  .id-line, .awb-line, .order-line {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 100%; font-weight: 700; width: 100%; text-align: left; align-self: stretch;
  }
  .courier-line, .order-line, .id-line, .awb-line { text-align: left !important; }
  .id-line { font-size: 7px; margin-top: 3px; }
  .awb-line { font-size: 7.5px; margin-top: 2px; }
  .order-line { font-size: 8px; }
  .awb-block { width: 100%; margin-top: 2px; text-align: left; }
  .meta div { font-size: 7.5px; line-height: 1.2; }
  .meta-k { font-weight: 700; }
  .bc-awb, .bc-ord {
    width: 100%; margin-top: 3px; display: block; text-align: left;
    line-height: 0; overflow: hidden;
  }
  .bc-ord { margin: 3px 0 2px; }
  .bc-awb { height: ${layout.awbBarH}px; }
  .bc-ord { height: ${layout.orderBarH}px; }
  .bc-awb svg, .bc-ord svg {
    height: 100%; width: auto; max-width: 100%;
    display: block; margin: 0; margin-left: 0; float: none;
  }
  .inv-lines { width: 100%; text-align: left !important; margin: 0; align-self: stretch; }
  .inv-lines div { text-align: left !important; }
  table.items { flex: 0 0 auto; width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 7.5px; }
  table.items th, table.items td {
    padding: 4px 5px 4px 7px; text-align: left; border-bottom: 1px solid #ddd;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  table.items th { border-bottom: 1px solid #333; font-size: 7px; font-weight: 700; }
  .c { text-align: center; }
  .totals {
    flex: 0 0 auto;
    display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
    padding: 5px 8px 6px; font-size: 7.5px; border-top: 1px solid #333; border-bottom: 1px solid #333;
  }
  .totals-right { text-align: right; font-weight: 400; line-height: 1.2; font-size: 7.5px; }
  .totals-right .collectable-line { font-size: 9px; font-weight: 700; margin-top: 0; line-height: 1.15; }
  .notes {
    flex: 0 0 auto;
    margin: 0 8px; padding: 4px 6px;
    border: 1px solid #333; font-size: 7.5px; line-height: 1.15;
  }
  .foot {
    flex: 0 0 auto;
    margin-top: 14px;
    padding: 6px 8px 6px;
    font-size: 6.5px;
    border-top: 0;
  }
  .foot-row { display: flex; justify-content: space-between; gap: 8px; align-items: flex-end; }
  .foot-brand { font-weight: 700; font-size: 8px; }
  @media print {
    @page { size: 4in 6in; margin: 0; }
    html, body { width: 4in; height: 6in; overflow: hidden; margin: 0; padding: 0; background: #fff; display: flex; align-items: center; justify-content: center; }
    .sheet { width: calc(4in - 16px); height: calc(6in - 16px); border: 1.2px solid #333; overflow: hidden; }
  }
</style></head>
<body>
<div class="sheet ${layout.compactHtmlClass}">
  ${shipToHtml}
  <div class="split rule">
    <div class="left meta">${metas}</div>
    <div class="right">
      <div class="courier-line">${escapeHtml(vm.courier || 'Courier')}</div>
      ${
        s.delivery?.showAwbBarcode
          ? `<div class="awb-block">
              ${
                (() => {
                  const id = String(vm.providerChannelId || vm.shipmozoId || '').trim();
                  const label = String(
                    vm.providerChannelIdLabel || (vm.shipmozoId ? 'Shipmozo ID' : 'Shipment ID')
                  ).trim();
                  return id && label
                    ? kv(label, id).replace('<div>', '<div class="id-line">')
                    : '';
                })()
              }
              ${awbBar}
              ${vm.awb ? kv('AWB', vm.awb).replace('<div>', '<div class="awb-line">') : ''}
            </div>`
          : ''
      }
    </div>
  </div>
  <div class="split rule">
    <div class="left">
      <div class="tiny b">Shipped By (if undelivered, return to)</div>
      ${
        s.pickup?.showPickupName && vm.pickup?.name
          ? `<div class="ship-name">${escapeHtml(vm.pickup.name)}</div>`
          : ''
      }
      ${s.pickup?.showPickupAddress ? `<div>${pickup}</div>` : ''}
      ${s.pickup?.showPickupPhone && vm.pickup?.phone ? kv('Ph', vm.pickup.phone) : ''}
      ${s.support?.showCustomerSupport && support ? `<div class="tiny">${kvInner('Customer Care', support)}</div>` : ''}
      ${s.pickup?.showGstin && vm.gstin ? kv('GSTIN', vm.gstin) : ''}
    </div>
    <div class="right order">
      <div class="order-line">${kvInner('Order#', vm.orderId || '')}</div>
      ${orderBar}
      <div class="inv-lines">
      ${s.misc?.showInvoiceNumber && vm.invoiceNo ? `<div class="tiny">${kvInner('Invoice No', vm.invoiceNo)}</div>` : ''}
      ${s.misc?.showInvoiceDate && vm.invoiceDate ? `<div class="tiny">${kvInner('Invoice Date', vm.invoiceDate)}</div>` : ''}
      ${s.misc?.showOrderDate && vm.orderDate ? `<div class="tiny">${kvInner('Order Date', vm.orderDate)}</div>` : ''}
      </div>
    </div>
  </div>
  <div class="body-tail">
    <table class="items">${colgroup}<thead><tr>${heads.join('')}</tr></thead><tbody>${rows}</tbody></table>
    ${hiddenCount > 0 ? `<div class="tiny pad">+${escapeHtml(hiddenCount)} more item(s)</div>` : ''}
    <div class="totals">
      <span>${p.showShippingCharges ? kvInner('Shipping Charges', formatInr(vm.shippingCharges)) : ''}</span>
      <div class="totals-right">
        ${itemsTotalHtml}
        ${p.showTotalQuantity ? `<div>Total Quantity:${KEY_VAL_GAP_HTML}${escapeHtml(vm.totalQty)}</div>` : ''}
        ${collectableHtml}
      </div>
    </div>
    <div class="notes-spacer" aria-hidden="true" style="min-height:${Math.max(14, layout.notesGap + 8)}px;max-height:${Math.max(28, layout.notesGap + 18)}px"></div>
    ${s.misc?.showNotes && s.misc.notes ? `<div class="notes">${escapeHtml(s.misc.notes)}</div>` : ''}
    <div class="foot">
      <div class="foot-row">
        <span>${s.misc?.showAutoGeneratedDisclaimer ? 'This is an auto generated label and does not require any signature.' : ''}</span>
        <span class="foot-brand">${s.misc?.showPoweredBy ? escapeHtml(vm.poweredBy || getAppName()) : ''}</span>
      </div>
    </div>
  </div>
</div>
</body></html>`;
}

module.exports = {
  renderLabelPdf,
  renderLabelHtml,
  PAGE_W,
  PAGE_H
};

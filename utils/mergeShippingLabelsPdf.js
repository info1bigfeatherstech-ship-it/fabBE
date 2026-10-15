/**
 * Merge shipping-label buffers into one multi-page PDF (one label → one or more pages).
 * Supports PDF / PNG / JPEG. Non-fatal per-label failures are returned in `skipped`.
 */

const { PDFDocument } = require('pdf-lib');

function isPdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.slice(0, 5).toString('utf8') === '%PDF-';
}

function isPngBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

function isJpegBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/**
 * @param {Array<{ orderId?: string, buffer: Buffer, extension?: string }>} parts
 * @returns {Promise<{ pdfBuffer: Buffer, pageCount: number, appended: string[], skipped: Array<{ orderId?: string, reason: string }> }>}
 */
async function mergeShippingLabelPartsToPdf(parts) {
  const out = await PDFDocument.create();
  const appended = [];
  const skipped = [];

  for (const part of parts || []) {
    const orderId = part?.orderId != null ? String(part.orderId) : undefined;
    const buf = part?.buffer;
    if (!Buffer.isBuffer(buf) || buf.length < 8) {
      skipped.push({ orderId, reason: 'empty_or_invalid_buffer' });
      continue;
    }

    const ext = String(part.extension || '').toLowerCase().replace(/^\./, '');

    try {
      const treatAsPdf = ext === 'pdf' || (!ext && isPdfBuffer(buf)) || isPdfBuffer(buf);
      if (treatAsPdf && isPdfBuffer(buf)) {
        const src = await PDFDocument.load(buf, { ignoreEncryption: true });
        const indices = src.getPageIndices();
        if (!indices.length) {
          skipped.push({ orderId, reason: 'pdf_has_no_pages' });
          continue;
        }
        const pages = await out.copyPages(src, indices);
        for (const page of pages) {
          out.addPage(page);
        }
        appended.push(orderId || 'unknown');
        continue;
      }

      const treatAsPng = ext === 'png' || isPngBuffer(buf);
      if (treatAsPng && isPngBuffer(buf)) {
        const img = await out.embedPng(buf);
        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        appended.push(orderId || 'unknown');
        continue;
      }

      const treatAsJpg = ext === 'jpg' || ext === 'jpeg' || isJpegBuffer(buf);
      if (treatAsJpg && isJpegBuffer(buf)) {
        const img = await out.embedJpg(buf);
        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        appended.push(orderId || 'unknown');
        continue;
      }

      skipped.push({
        orderId,
        reason: `unsupported_label_format:${ext || 'unknown'}`
      });
    } catch (err) {
      skipped.push({
        orderId,
        reason: err?.message || 'merge_page_failed'
      });
    }
  }

  const pageCount = out.getPageCount();
  if (pageCount < 1) {
    const err = new Error('No shipping label pages could be added to the PDF.');
    err.code = 'BULK_LABELS_PDF_EMPTY';
    err.skipped = skipped;
    throw err;
  }

  const pdfBuffer = Buffer.from(await out.save());
  return { pdfBuffer, pageCount, appended, skipped };
}

module.exports = {
  mergeShippingLabelPartsToPdf,
  isPdfBuffer,
  isPngBuffer,
  isJpegBuffer
};

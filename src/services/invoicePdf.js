// src/services/invoicePdf.js
'use strict';
//
// Genera el PDF de una factura (M7 Bloque 1) con pdfkit (pura JS, segura en Render).
// Devuelve un Buffer. Layout sencillo y robusto (emisor, receptor, líneas, IGIC, total).
//
let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch { PDFDocument = null; }

function eur(cents, currency = 'EUR') {
  return ((Number(cents) || 0) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;
}
function addr(a = {}) {
  return [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.province, a.country].filter(Boolean).join(', ');
}

function renderInvoicePdf(inv) {
  return new Promise((resolve, reject) => {
    if (!PDFDocument) return reject(new Error('pdfkit_not_installed'));
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const issuer = inv.issuer || {};
      const rec = inv.recipient || {};
      const cur = inv.currency || 'EUR';
      const RIGHT = 350, RW = 195;

      const row = (label, value, opts = {}) => {
        const y = doc.y;
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 10);
        doc.text(String(label), 50, y, { width: 290 });
        const y2 = doc.y;
        doc.text(String(value), RIGHT, y, { width: RW, align: 'right' });
        doc.y = Math.max(y2, doc.y);
        doc.font('Helvetica');
      };

      // Cabecera
      doc.font('Helvetica-Bold').fontSize(20).text('FACTURA', { align: 'right' });
      doc.font('Helvetica').fontSize(10);
      doc.text(`Nº ${inv.invoiceNumber || ''}`, { align: 'right' });
      doc.text(`Período: ${inv.period || ''}`, { align: 'right' });
      if (inv.finalizedAt) doc.text(`Fecha: ${new Date(inv.finalizedAt).toLocaleDateString('es-ES')}`, { align: 'right' });

      // Emisor
      doc.moveUp(3);
      doc.font('Helvetica-Bold').fontSize(13).text(issuer.legalName || issuer.tradeName || '', 50, doc.y, { width: 290 });
      doc.font('Helvetica').fontSize(9).fillColor('#555');
      if (issuer.taxId) doc.text(`NIF: ${issuer.taxId}`, { width: 290 });
      if (addr(issuer.address)) doc.text(addr(issuer.address), { width: 290 });
      if (issuer.email) doc.text(issuer.email, { width: 290 });
      doc.fillColor('#000');

      doc.moveDown(2);
      // Receptor
      doc.font('Helvetica-Bold').fontSize(10).text('Facturar a:');
      doc.font('Helvetica').fontSize(10).text(rec.legalName || rec.merchantId || '');
      doc.fontSize(9).fillColor('#555');
      if (rec.taxId) doc.text(`NIF: ${rec.taxId}`);
      if (addr(rec)) doc.text(addr(rec));
      if (rec.email) doc.text(rec.email);
      doc.fillColor('#000').moveDown(1.5);

      // Líneas
      const lines = (inv.lines && inv.lines.length) ? inv.lines : [{ label: 'Servicios', amount: inv.subtotal || 0 }];
      row('Concepto', 'Importe', { bold: true });
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke().strokeColor('#000');
      doc.moveDown(0.3);
      lines.forEach(l => row(l.label, eur(l.amount, cur)));
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke().strokeColor('#000');
      doc.moveDown(0.3);
      row('Base imponible', eur(inv.subtotal, cur));
      row(`${inv.taxLabel || inv.taxCode || 'Impuesto'} (${inv.taxPercent || 0}%)`, eur(inv.taxAmount, cur));
      doc.moveDown(0.2);
      row('TOTAL', eur(inv.total, cur), { bold: true, size: 13 });

      // Notas legales / pie
      doc.moveDown(2).fontSize(8).fillColor('#555');
      if (inv.taxNote) doc.text(inv.taxNote);
      if (issuer.iban) doc.text(`Pago por transferencia — IBAN: ${issuer.iban}`);
      if (issuer.footerNotes) doc.text(issuer.footerNotes);
      doc.fillColor('#000');

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { renderInvoicePdf };

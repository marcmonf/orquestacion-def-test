// src/services/mailer.js
'use strict';
//
// Envío de email (M7 Bloque 1) vía SMTP de Google Workspace (nodemailer).
// Config por ENV — Marcos la rellena en Render; sin config, NO envía (no-op + warn),
// para que nada se rompa. Variables:
//   SMTP_HOST (smtp.gmail.com) · SMTP_PORT (587) · SMTP_SECURE (false)
//   SMTP_USER (cuenta de Workspace) · SMTP_PASS (contraseña de aplicación)
//   SMTP_FROM (remitente; por defecto SMTP_USER)
//
let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }
const logger = require('../utils/logger');

function buildTransport() {
  if (!nodemailer) return null;
  const host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
}

function isConfigured() { return !!buildTransport(); }

async function sendMail({ to, subject, text, html, attachments }) {
  if (!to) return { sent: false, reason: 'no_recipient' };
  const t = buildTransport();
  if (!t) {
    logger.warn('mailer: SMTP no configurado — email no enviado', { component: 'billing', event: 'EMAIL_SKIPPED', data: { to, subject } });
    return { sent: false, reason: 'smtp_not_configured' };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await t.sendMail({ from, to, subject, text, html, attachments: attachments || [] });
  logger.info('mailer: email enviado', { component: 'billing', event: 'EMAIL_SENT', data: { to, subject } });
  return { sent: true };
}

async function sendInvoiceEmail({ to, invoice, pdfBuffer, companyName }) {
  const num = invoice.invoiceNumber || '';
  const subject = `Factura ${num}${companyName ? ' · ' + companyName : ''}`;
  const text = `Adjuntamos tu factura ${num} correspondiente al período ${invoice.period}.\n\nUn saludo.`;
  return sendMail({
    to, subject, text,
    attachments: pdfBuffer ? [{ filename: `factura-${num}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }] : [],
  });
}

module.exports = { sendMail, sendInvoiceEmail, isConfigured };

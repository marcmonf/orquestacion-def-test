// src/utils/interchangeDefaults.js
'use strict';
//
// Tablas de INTERCHANGE por defecto (M7 Bloque 2). El interchange lo fijan VISA/
// Mastercard (tablas oficiales) — esto son valores de ARRANQUE editables:
//   - EEA consumer: topes regulados reales (débito 0,20% · crédito 0,30%).
//   - Comercial e internacional (inter-regional): PLACEHOLDERS (no regulados),
//     que Marcos ajusta con las tablas oficiales via /backoffice/interchange.
// bps = puntos básicos sobre el importe (20 = 0,20%); fixed = céntimos por operación.
//
const DEFAULT_INTERCHANGE = [
  // EEA consumer — topes regulados (Reglamento UE 2015/751)
  { scheme: 'visa',       cardType: 'debit',      region: 'eea',  bps: 20,  fixed: 0 },
  { scheme: 'visa',       cardType: 'credit',     region: 'eea',  bps: 30,  fixed: 0 },
  { scheme: 'mastercard', cardType: 'debit',      region: 'eea',  bps: 20,  fixed: 0 },
  { scheme: 'mastercard', cardType: 'credit',     region: 'eea',  bps: 30,  fixed: 0 },
  // domestic (mismo país) — por defecto igual que EEA
  { scheme: 'visa',       cardType: 'debit',      region: 'domestic', bps: 20, fixed: 0 },
  { scheme: 'visa',       cardType: 'credit',     region: 'domestic', bps: 30, fixed: 0 },
  { scheme: 'mastercard', cardType: 'debit',      region: 'domestic', bps: 20, fixed: 0 },
  { scheme: 'mastercard', cardType: 'credit',     region: 'domestic', bps: 30, fixed: 0 },
  // comercial (no regulado) — PLACEHOLDER
  { scheme: 'visa',       cardType: 'commercial', region: 'eea',  bps: 120, fixed: 0 },
  { scheme: 'mastercard', cardType: 'commercial', region: 'eea',  bps: 120, fixed: 0 },
  // internacional (inter-regional) — PLACEHOLDER
  { scheme: 'visa',       cardType: 'debit',      region: 'intl', bps: 120, fixed: 0 },
  { scheme: 'visa',       cardType: 'credit',     region: 'intl', bps: 150, fixed: 0 },
  { scheme: 'mastercard', cardType: 'debit',      region: 'intl', bps: 120, fixed: 0 },
  { scheme: 'mastercard', cardType: 'credit',     region: 'intl', bps: 150, fixed: 0 },
  { scheme: 'visa',       cardType: 'commercial', region: 'intl', bps: 180, fixed: 0 },
  { scheme: 'mastercard', cardType: 'commercial', region: 'intl', bps: 180, fixed: 0 },
];

// Disclaimer estándar para mostrar al merchant junto al coste.
const COST_DISCLAIMER =
  'Coste APROXIMADO. El interchange y los scheme fees los fijan las marcas (VISA/Mastercard), ' +
  'no el adquirente ni la pasarela; dependen del tipo de tarjeta y pueden cambiar en cualquier ' +
  'momento sin control inmediato. Sirve como estimación orientativa.';

// Busca la fila que mejor casa (scheme+cardType+region). Fallbacks razonables.
function findInterchange(rows, ctx) {
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const cand = rows.filter(r => eq(r.scheme, ctx.scheme));
  const pick = (region) => cand.find(r => eq(r.cardType, ctx.cardType) && eq(r.region, region));
  return pick(ctx.region)
      || (ctx.region === 'domestic' ? pick('eea') : null)
      || cand.find(r => eq(r.cardType, ctx.cardType))
      || cand[0]
      || null;
}

module.exports = { DEFAULT_INTERCHANGE, COST_DISCLAIMER, findInterchange };

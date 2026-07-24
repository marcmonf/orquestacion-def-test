// src/utils/taxDefaults.js
'use strict';
//
// Tipos impositivos por defecto — Sociedad en CANARIAS ⇒ IGIC (no IVA).
// Editables por el superadmin (GET/PUT /backoffice/tax). El `legalNote` se imprime
// en la factura cuando aplica (p. ej. operaciones no sujetas / inversión del
// sujeto pasivo para clientes de Península/UE). Los porcentajes y notas exactas
// los confirma el asesor fiscal — aquí solo dejamos defaults razonables.
//
const DEFAULT_TAX_RATES = [
  { code: 'IGIC_GENERAL',      label: 'IGIC general (7%)',           percent: 7,   legalNote: '' },
  { code: 'IGIC_CERO',         label: 'IGIC tipo cero (0%)',         percent: 0,   legalNote: '' },
  { code: 'IGIC_REDUCIDO',     label: 'IGIC reducido (3%)',          percent: 3,   legalNote: '' },
  { code: 'IGIC_INCREMENTADO', label: 'IGIC incrementado (9,5%)',    percent: 9.5, legalNote: '' },
  { code: 'IGIC_ESPECIAL',     label: 'IGIC especial (15%)',         percent: 15,  legalNote: '' },
  { code: 'NO_SUJETO',         label: 'No sujeto a IGIC',            percent: 0,   legalNote: 'Operación no sujeta a IGIC (regla de localización).' },
  { code: 'ISP',               label: 'Inversión del sujeto pasivo', percent: 0,   legalNote: 'Inversión del sujeto pasivo.' },
  { code: 'EXENTO',            label: 'Exento',                      percent: 0,   legalNote: 'Operación exenta.' },
];

const DEFAULT_TAX_CODE = 'IGIC_GENERAL';   // clientes en Canarias, servicios

function defaultTaxRate(code) {
  return DEFAULT_TAX_RATES.find(t => t.code === code) ||
         DEFAULT_TAX_RATES.find(t => t.code === DEFAULT_TAX_CODE);
}

module.exports = { DEFAULT_TAX_RATES, DEFAULT_TAX_CODE, defaultTaxRate };

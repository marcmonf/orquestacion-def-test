// src/services/companyService.js
'use strict';
//
// Datos de la Sociedad emisora (M7 Bloque 1). Singleton (`key: 'default'`). Si no
// se ha configurado aún, devuelve un esqueleto vacío (la factura saldrá con los
// campos en blanco hasta que el superadmin los rellene en /backoffice/company).
//
const CompanyProfile = require('../models/CompanyProfile');

const EMPTY_COMPANY = {
  key: 'default', legalName: '', tradeName: '', taxId: '',
  address: { street: '', city: '', postalCode: '', province: '', country: 'ES' },
  email: '', phone: '', iban: '', taxRegime: 'IGIC', invoiceSeries: 'A',
  logoDataUrl: '', footerNotes: '',
};

async function getCompany() {
  const doc = await CompanyProfile.findOne({ key: 'default' }).lean();
  return doc || { ...EMPTY_COMPANY };
}

module.exports = { getCompany, EMPTY_COMPANY };

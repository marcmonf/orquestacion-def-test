// src/utils/productionReadiness.js
'use strict';
//
// CHECKLIST DE VARIABLES DE ENTORNO PARA PASAR A REAL (F7, nov 2026).
//
// Evalúa la configuración ACTUAL del proceso (sin enseñar ningún valor secreto:
// solo si está, su longitud o si vale lo esperado) y dice qué falta para
// operar con dinero real. Lo usan:
//   - el arranque (index.js): con PAYNOPAIN_ENV=production imprime cada fallo
//     como ⚠️ [PRODUCCIÓN] en el log de Render;
//   - GET /backoffice/production-readiness (superadmin): Marcos lo consulta
//     desde Postman antes de cambiar a real.
// Guía completa: docs/produccion.md.

function env(k) { return process.env[k]; }
function isTrue(k) { return ['true', '1'].includes(String(env(k) || '').trim().toLowerCase()); }

const CHECKS = [
  { var: 'MONETISER_ENV', severity: 'blocker', ok: () => require('./environment').isProduction() && require('./environment').mismatches().length === 0, fix: "'production' en el despliegue de producción (y 'sandbox' en el de pruebas). Debe casar con PAYNOPAIN_ENV y con una MONGO_URI propia." },
  { var: 'ALERT_EMAILS + SMTP_*', severity: 'recommended', ok: () => Boolean(process.env.ALERT_EMAILS && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS), fix: 'Destinatarios de alertas (circuit breaker, webhooks atascados, errores del adquirente) y el SMTP de Workspace.' },
  { var: 'PAYNOPAIN_ENV', severity: 'blocker', ok: () => env('PAYNOPAIN_ENV') === 'production', fix: "Poner 'production' SOLO cuando PayNoPain entregue las credenciales reales." },
  { var: 'PAYNOPAIN_API_KEY / PAYNOPAIN_SIGNATURE / PAYNOPAIN_SERVICE_UUID', severity: 'blocker', ok: () => Boolean(env('PAYNOPAIN_API_KEY') && env('PAYNOPAIN_SIGNATURE') && env('PAYNOPAIN_SERVICE_UUID')), fix: 'Las de la cuenta REAL de Paylands (no las de sandbox).' },
  { var: 'PAYNOPAIN_PCI_CLIENT_URL', severity: 'blocker', ok: () => Boolean(env('PAYNOPAIN_PCI_CLIENT_URL')), fix: 'URL de ProxyFields de producción CONFIRMADA por Paylands (el valor por defecto es una suposición).' },
  { var: 'API_KEY_SIMPLE_FALLBACK', severity: 'blocker', ok: () => !isTrue('API_KEY_SIMPLE_FALLBACK'), fix: "Poner 'false' (o borrarla): en real la API antigua solo con firma HMAC; los comercios nuevos usan /v1." },
  { var: 'ALLOW_DUMMY_CONNECTOR', severity: 'blocker', ok: () => !isTrue('ALLOW_DUMMY_CONNECTOR'), fix: 'Borrarla: el conector simulado aprueba todo sin cobrar.' },
  { var: 'NODE_ENV', severity: 'blocker', ok: () => !['development', 'test'].includes(String(env('NODE_ENV') || '')), fix: "No puede ser 'development' ni 'test' (activan valores de desarrollo y el simulador). Lo normal: 'production' o sin definir." },
  { var: 'ADMIN_TOKEN', severity: 'blocker', ok: () => String(env('ADMIN_TOKEN') || '').length >= 32, fix: '≥ 32 caracteres aleatorios.' },
  { var: 'BACKOFFICE_JWT_SECRET / PORTAL_JWT_SECRET', severity: 'blocker', ok: () => Boolean(env('BACKOFFICE_JWT_SECRET') && env('PORTAL_JWT_SECRET') && env('BACKOFFICE_JWT_SECRET') !== env('PORTAL_JWT_SECRET')), fix: 'Los dos definidos y DISTINTOS.' },
  { var: 'HPP_SIGNING_SECRET', severity: 'blocker', ok: () => String(env('HPP_SIGNING_SECRET') || '').length >= 32, fix: '64 hex aleatorios (firma la URL del iFrame y la vuelta del comprador).' },
  { var: 'CREDENTIALS_ENCRYPTION_KEY', severity: 'blocker', ok: () => require('./cryptoUtils').credentialsEncryptionConfigured(), fix: '64 hex aleatorios. Cifra credenciales de PSP, secretos 2FA y tokens de tarjeta guardada. NO cambiarla después: lo cifrado con la anterior deja de abrirse.' },
  { var: 'SERVER_URL', severity: 'blocker', ok: () => /^https:\/\//.test(String(env('SERVER_URL') || '')), fix: 'URL pública https del servidor de producción (Paylands notifica a SERVER_URL/webhooks/paynopain).' },
  { var: 'BACKOFFICE_2FA_REQUIRED', severity: 'blocker', ok: () => isTrue('BACKOFFICE_2FA_REQUIRED'), fix: "'true' DESPUÉS de que cada superadmin haya activado su 2FA en /admin → botón 2FA." },
  { var: 'WEBHOOK_SECRET', severity: 'recommended', ok: () => String(env('WEBHOOK_SECRET') || '').length >= 32, fix: 'Secreto de respaldo para firmar webhooks de merchants sin secreto propio.' },
  { var: 'ALLOWED_ORIGINS', severity: 'recommended', ok: () => Boolean(env('ALLOWED_ORIGINS')), fix: 'Orígenes del panel/portal, separados por coma.' },
  { var: 'DOCS_ENABLED', severity: 'recommended', ok: () => true, fix: "Decidir si /docs queda pública ('false' para ocultarla)." },
  // Revisión 5 nov (H1): con Paylands en producción solo se cobra en modo LIVE
  // (claves ms_live_ por /v1). Las claves de pruebas y la API antigua dejan de
  // cobrar en ese despliegue.
  { var: 'FEATURE_LIVEMODE', severity: 'blocker', ok: () => isTrue('FEATURE_LIVEMODE'), fix: "'true' en el despliegue de producción y crear claves ms_live_ (/admin → API Keys). En producción las claves de pruebas y la API antigua no cobran." },
  { var: 'FEATURE_SAVED_CARDS / FEATURE_PAYLANDS_*', severity: 'info', ok: () => !isTrue('FEATURE_SAVED_CARDS') && !isTrue('FEATURE_PAYLANDS_BIZUM') && !isTrue('FEATURE_PAYLANDS_APPLE_PAY') && !isTrue('FEATURE_PAYLANDS_GOOGLE_PAY'), fix: 'Apagados hasta verificarlos con PayNoPain (DEV-LOG sesión 4 nov 2026).' },
];

function evaluate() {
  const items = CHECKS.map((c) => ({ var: c.var, severity: c.severity, ok: Boolean(c.ok()), fix: c.fix }));
  const blockers = items.filter((i) => i.severity === 'blocker' && !i.ok);
  return { readyForProduction: blockers.length === 0, blockers: blockers.length, items };
}

module.exports = { evaluate, CHECKS };

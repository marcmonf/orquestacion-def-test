'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const router   = express.Router();

const Transaction = require('../models/Transaction');
const Merchant    = require('../models/Merchant');

/* MONETISER PATCH START: guard de firma HMAC con exp+nonce (opcional por flag) */
let iframeGuard = null;
try { iframeGuard = require('../core/iframeGuard'); } catch { /* opcional */ }
const FEATURE_IFRAME_GUARD = process.env.FEATURE_IFRAME_GUARD === '1';

function mapGuardErrorToHttp(code) {
  // Mapea errores del guard a códigos HTTP y plantillas de error
  switch (code) {
    case 'invalid_params':
    case 'invalid_exp':
    case 'bad_signature':
      return 403;
    case 'not_before':
    case 'expired':
    case 'nonce_expired':
      return 410; // expirada
    case 'nonce_not_found':
    case 'nonce_already_used':
    case 'race_condition':
      return 409; // conflicto / reuso
    default:
      return 403;
  }
}
/* MONETISER PATCH END */

// CSP solo para esta ruta: permitir Google Pay scripts, frames y conexiones.
const CSP_HEADER =
  "default-src 'self'; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' https://pay.google.com https://*.google.com https://*.gstatic.com; " +
  "connect-src 'self' https://pay.google.com https://*.google.com https://google.com; " +
  "frame-src 'self' https://pay.google.com https://*.google.com; " +
  "frame-ancestors 'none';";

function safeCompare(a,b){try{const A=Buffer.from(String(a||''),'utf8');const B=Buffer.from(String(b||''),'utf8');if(A.length!==B.length)return false;return crypto.timingSafeEqual(A,B);}catch{return false;}}
function generateSignature(payload,secret){return crypto.createHmac('sha256',String(secret)).update(JSON.stringify(payload)).digest('hex');}
function readHtml(abs){try{return fs.readFileSync(abs,'utf8');}catch{return null;}}
function injectBranding(html,branding){
  if(!html) return null;
  const {logoUrl='/Logo_Monetiser.png',brandColor='#0070f3',accentColor='#0053b3'}=branding||{};
  return html.replace(/__LOGO_SRC__/g,logoUrl).replace(/__BRAND_COLOR__/g,brandColor).replace(/__ACCENT_COLOR__/g,accentColor);
}
function brandedError(res,code){
  const map={400:'400.html',403:'403.html',404:'404.html',409:'409.html',410:'410.html',500:'500.html'};
  const abs=path.join(__dirname,'../../public/errors',map[code]||'403.html');
  const html=readHtml(abs);
  return res.status(code).send(html||String(code));
}

// GET /iframe  (router montado en /iframe y /iframe-process)
router.get('/', async (req,res)=>{
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  const { paymentId, signature, exp } = req.query || {};

  // Carga base (sin params) para pruebas locales
  if(!paymentId && !signature && !exp){
    const abs = path.join(__dirname,'../../public/iframe.html');
    const base = readHtml(abs);
    if(!base) return res.status(500).send('Error cargando iframe');
    return res.send(injectBranding(base, {}) || base);
  }

  if(!paymentId || !signature || !exp) return brandedError(res,400);

  // Exp simple para compatibilidad (legacy). El guard hace su propia validación cuando está activo.
  const expMs = Date.parse(String(exp));
  if(Number.isNaN(expMs)) return brandedError(res,400);

  try{
    const tx = await Transaction.findOne({paymentId}).lean(false);
    if(!tx) return brandedError(res,404);

    // Recupera secreto del merchant (compatibilidad con tus campos)
    const merchant = await Merchant.findOne(
      {merchantId:tx.merchantId},
      {signingSecret:1,hmacSecret:1,secret:1,logoUrl:1,brandColor:1,accentColor:1,_id:0}
    ).lean();

    const secret=merchant?.signingSecret||merchant?.hmacSecret||merchant?.secret||process.env.MERCHANT_SECRET||'default_merchant_secret';

    /* MONETISER PATCH START: verificación robusta con exp+nonce opcional */
    if (FEATURE_IFRAME_GUARD && iframeGuard) {
      const { nonce } = req.query || {};
      // Usa amount/currency persistidos para evitar manipulación en query
      const guardArgs = {
        merchantId: tx.merchantId,
        paymentId: tx.paymentId,
        amount: tx.amount,
        currency: tx.currency,
        nonce,
        exp,
        signature,
        secret
      };
      const verdict = await iframeGuard.verifyAndConsume(guardArgs);
      if (!verdict.ok) {
        const code = mapGuardErrorToHttp(verdict.code);
        return brandedError(res, code);
      }
    } else {
      // Camino legacy: verifica firma basada en JSON.stringify(payload)
      if (Date.now()>expMs) return brandedError(res,410);
      const payload={
        paymentId:tx.paymentId,
        merchantId:tx.merchantId,
        amount:tx.amount,
        currency:tx.currency,
        method:tx.method,
        iat:tx.createdAt?.toISOString?.()||new Date().toISOString(),
        exp
      };
      const expected=generateSignature(payload,secret);
      if(!safeCompare(expected,signature)) return brandedError(res,403);
    }
    /* MONETISER PATCH END */

    // Bloqueo si ya se sirvió o estado no permitido
    if(tx.iframeServedAt || tx.status!=='initialized') return brandedError(res,409);

    // Marca trazabilidad iFrame
    tx.iframeServedAt = new Date();
    /* MONETISER PATCH START: trazas mínimas del cliente que carga el iframe */
    try {
      tx.iframeClientIp  = (req.headers['x-forwarded-for']||'').split(',')[0] || req.socket?.remoteAddress || null;
      tx.iframeUserAgent = req.headers['user-agent'] || null;
    } catch { /* noop */ }
    /* MONETISER PATCH END */
    await tx.save();

    // Branding dinámico por merchant
    const branding=merchant?{logoUrl:merchant.logoUrl,brandColor:merchant.brandColor,accentColor:merchant.accentColor}:{};
    const basePath=path.join(__dirname,'../../public/iframe.html');
    const baseHtml=readHtml(basePath);
    if(!baseHtml) return res.status(500).send('Error cargando iframe');
    return res.send(injectBranding(baseHtml,branding)||baseHtml);
  }catch(err){
    console.error('Error en /iframe:',err);
    return brandedError(res,500);
  }
});

// POST /iframe-process (mismo router montado en /iframe-process)
// Mock seguro: valida campos mínimos y devuelve JSON. No toca flujos de HMAC.
router.post('/', async (req,res)=>{
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  try{
    const { amount, currency, merchantId, method, status, returnUrl } = req.body || {};
    if(typeof amount!=='number' || !currency || !merchantId){
      return res.status(400).json({ success:false, message:'payload inválido' });
    }
    const txn = {
      _id: (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex')),
      merchantId,
      amount,
      currency,
      method: method || 'card',
      status: status || 'approved',
      returnUrl: returnUrl || null,
      createdAt: new Date().toISOString()
    };
    return res.json({ success:true, transaction: txn });
  }catch(e){
    console.error('Error en POST /iframe-process:', e);
    return res.status(500).json({ success:false, message:'error interno' });
  }
});

module.exports = router;

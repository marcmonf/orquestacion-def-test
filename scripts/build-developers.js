#!/usr/bin/env node
// scripts/build-developers.js
'use strict';
//
// GENERA public/developers/index.html (documentación para desarrolladores,
// sesión 5 nov 2026, F2) A PARTIR DE:
//   - docs/integracion.md  → la guía (guía rápida, webhooks, estados, errores,
//                            pruebas, tarjetas de prueba): se renderiza tal cual.
//   - openapi.yaml         → la lista de endpoints de la API v1 y los ejemplos
//                            curl / Node / PHP (con el ejemplo de cada operación).
// No se escribe a mano nada que ya esté en esos dos ficheros: si cambian, se
// vuelve a generar. Un test (tests/unit/developersPage.test.js) falla si el HTML
// del repo no coincide con lo que genera este script.
//
// Uso:  node scripts/build-developers.js
//
// js-yaml es dependencia de desarrollo: por eso la página se genera aquí y se
// sirve como estático (en Render no hace falta nada).

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'developers', 'index.html');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Markdown mínimo (lo que usa docs/integracion.md) ─────────────────────────
function slug(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function inline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) => {
    const safe = /^(https?:|\/|#)/.test(href.replace(/&amp;/g, '&')) ? href : '#';
    return `<a href="${safe}">${txt}</a>`;
  });
  return s;
}
function markdown(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  const toc = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^```/.test(l)) {
      const lang = l.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) {
      const level = m[1].length + 1; // # del .md → h2 (la página ya tiene su h1)
      const id = 'guia-' + slug(m[2]);
      if (level <= 3) toc.push({ level, id, text: m[2] });
      out.push(`<h${level} id="${id}">${inline(m[2])}</h${level}>`);
      i++; continue;
    }
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||>|\s*([-*]|\d+\.)\s+|---+\s*$)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return { html: out.join('\n'), toc };
}

// ── Ejemplos desde openapi.yaml ──────────────────────────────────────────────
function resolveRef(spec, obj) {
  let o = obj;
  for (let n = 0; o && o.$ref && n < 10; n++) {
    o = o.$ref.replace(/^#\//, '').split('/').reduce((a, k) => (a ? a[k] : undefined), spec);
  }
  return o || {};
}
function exampleOf(spec, op) {
  const content = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
  if (!content) return null;
  if (content.example !== undefined) return content.example;
  if (content.examples) {
    const first = Object.values(content.examples)[0];
    const ex = resolveRef(spec, first);
    if (ex && ex.value !== undefined) return ex.value;
  }
  const schema = resolveRef(spec, content.schema || {});
  if (schema.example !== undefined) return schema.example;
  const props = schema.properties || {};
  const req = schema.required || [];
  const ex = {};
  for (const k of req.length ? req : Object.keys(props).slice(0, 2)) {
    const p = resolveRef(spec, props[k] || {});
    if (p.example !== undefined) ex[k] = p.example;
    else if (p.type === 'integer' || p.type === 'number') ex[k] = 1000;
    else if (p.type === 'boolean') ex[k] = false;
    else ex[k] = '...';
  }
  return ex;
}
const HOST = 'https://orquestacion-def-test.onrender.com';
function samplePath(p) { return p.replace(/\{id\}/g, 'ID_DEL_PAGO'); }
function curl(method, p, body) {
  const lines = [`curl -X ${method} ${HOST}${samplePath(p)} \\`, '  -H "Authorization: Bearer ms_test_..." \\'];
  if (method !== 'GET' && method !== 'DELETE') lines.push('  -H "Idempotency-Key: pedido-1234" \\');
  if (body) { lines.push('  -H "Content-Type: application/json" \\'); lines.push(`  -d '${JSON.stringify(body)}'`); }
  else lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, '');
  return lines.join('\n');
}
function node(method, p, body) {
  return [
    '// Node 18+ (fetch incluido). El secreto ms_ va en TU servidor, nunca en el navegador.',
    `const res = await fetch('${HOST}${samplePath(p)}', {`,
    `  method: '${method}',`,
    '  headers: {',
    "    Authorization: 'Bearer ' + process.env.MONETISER_SECRET,",
    ...(method !== 'GET' && method !== 'DELETE' ? ["    'Idempotency-Key': 'pedido-1234',"] : []),
    ...(body ? ["    'Content-Type': 'application/json',"] : []),
    '  },',
    ...(body ? [`  body: JSON.stringify(${JSON.stringify(body)}),`] : []),
    '});',
    'const data = await res.json();',
  ].join('\n');
}
function php(method, p, body) {
  const headers = ["'Authorization: Bearer ' . getenv('MONETISER_SECRET')"];
  if (method !== 'GET' && method !== 'DELETE') headers.push("'Idempotency-Key: pedido-1234'");
  if (body) headers.push("'Content-Type: application/json'");
  return [
    '<?php',
    `$ch = curl_init('${HOST}${samplePath(p)}');`,
    'curl_setopt_array($ch, [',
    `  CURLOPT_CUSTOMREQUEST => '${method}',`,
    '  CURLOPT_RETURNTRANSFER => true,',
    `  CURLOPT_HTTPHEADER => [${headers.join(', ')}],`,
    ...(body ? [`  CURLOPT_POSTFIELDS => json_encode(${phpArray(body)}),`] : []),
    ']);',
    '$data = json_decode(curl_exec($ch), true);',
  ].join('\n');
}
function phpArray(v) {
  if (Array.isArray(v)) return `[${v.map(phpArray).join(', ')}]`;
  if (v && typeof v === 'object') return `[${Object.entries(v).map(([k, x]) => `'${k}' => ${phpArray(x)}`).join(', ')}]`;
  if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
  return JSON.stringify(v);
}

function build() {
  const spec = yaml.load(fs.readFileSync(path.join(ROOT, 'openapi.yaml'), 'utf8'));
  const guide = markdown(fs.readFileSync(path.join(ROOT, 'docs', 'integracion.md'), 'utf8'));
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths || {})) {
    if (!p.startsWith('/v1/')) continue;
    for (const [m, op] of Object.entries(item)) {
      if (!op || !op.summary) continue;
      ops.push({ method: m.toUpperCase(), path: p, op });
    }
  }
  const endpoints = ops.map(({ method, path: p, op }) => {
    const off = /\[APAGADO\]/.test(op.summary);
    const body = exampleOf(spec, op);
    const id = 'ep-' + slug(`${method}-${p}`);
    const examples = p.endsWith('.js') ? '' : `
      <details><summary>curl</summary><pre><code>${esc(curl(method, p, body))}</code></pre></details>
      <details><summary>Node.js</summary><pre><code>${esc(node(method, p, body))}</code></pre></details>
      <details><summary>PHP</summary><pre><code>${esc(php(method, p, body))}</code></pre></details>`;
    return `<section class="ep${off ? ' off' : ''}" id="${id}"><h3><span class="m m-${method.toLowerCase()}">${method}</span> <code>${esc(p)}</code></h3>
      <p>${esc(op.summary)}${off ? ' <em>(desactivado hoy)</em>' : ''}</p>${examples}</section>`;
  }).join('\n');

  const toc = guide.toc.filter((t) => t.level === 2).map((t) => `<li><a href="#${t.id}">${inline(t.text)}</a></li>`).join('');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monetiser para desarrolladores</title>
<!-- GENERADO por scripts/build-developers.js desde docs/integracion.md y openapi.yaml (versión ${esc(spec.info.version)}). No editar a mano. -->
<style>
:root{--ink:#14161f;--muted:#5e6475;--line:#e6e8ef;--bg:#fff;--side:#f7f8fb;--accent:#4b3fd1;--code:#0f1222}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.55}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:#fffffff2;z-index:2}
header strong{font-size:17px}header nav{margin-left:auto;display:flex;gap:16px;font-size:14px;flex-wrap:wrap}header a{color:var(--accent);text-decoration:none}
.wrap{display:grid;grid-template-columns:250px minmax(0,1fr);max-width:1180px;margin:0 auto}
aside{border-right:1px solid var(--line);background:var(--side);padding:18px 16px;position:sticky;top:53px;align-self:start;max-height:calc(100vh - 53px);overflow:auto;font-size:14px}
aside ul{list-style:none;padding:0;margin:0 0 12px}aside li{margin:4px 0}aside a{color:var(--ink);text-decoration:none}aside a:hover{color:var(--accent)}
aside h4{margin:12px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
main{padding:20px 32px 60px;min-width:0}h1{font-size:30px;margin:6px 0 8px}h2{font-size:22px;margin-top:36px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:17px}
p,li{font-size:15px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f1f2f7;padding:1px 5px;border-radius:4px}
pre{background:var(--code);color:#e8e9f3;padding:14px;border-radius:8px;overflow:auto;font-size:13px}pre code{background:none;color:inherit;padding:0}
table{border-collapse:collapse;width:100%;font-size:14px;margin:10px 0;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--side)}
blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--accent);background:var(--side)}
.lead{color:var(--muted);font-size:17px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:18px 0}
.card{border:1px solid var(--line);border-radius:10px;padding:14px}.card a{color:var(--accent);font-weight:600;text-decoration:none}
.ep{border:1px solid var(--line);border-radius:10px;padding:4px 16px 12px;margin:12px 0}.ep.off{opacity:.65}.ep h3{margin:10px 0 4px}
.m{font-size:12px;font-weight:700;padding:2px 7px;border-radius:5px;color:#fff;font-family:ui-monospace,monospace}.m-get{background:#2f7d4f}.m-post{background:#4b3fd1}.m-delete{background:#b42318}
details{margin:6px 0}summary{cursor:pointer;font-size:14px;color:var(--accent)}
@media (max-width:820px){.wrap{grid-template-columns:1fr}aside{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line)}main{padding:16px}header nav{gap:10px}}
</style>
</head>
<body>
<header><strong>Monetiser</strong><span style="color:var(--muted)">para desarrolladores</span>
<nav><a href="#empezar">Empezar</a><a href="#guia">Guía</a><a href="#api">Endpoints</a><a href="/docs">Referencia de la API</a><a href="/demo">Tienda demo</a></nav></header>
<div class="wrap">
<aside>
<h4>Empezar</h4><ul><li><a href="#empezar">Guía rápida</a></li><li><a href="#api">Endpoints y ejemplos</a></li><li><a href="/docs">Referencia completa (OpenAPI ${esc(spec.info.version)})</a></li></ul>
<h4>Guía de integración</h4><ul>${toc}</ul>
</aside>
<main>
<h1 id="empezar">Cobra con Monetiser en tu web</h1>
<p class="lead">Una clave <code>ms_</code> en tu servidor, una sesión de pago, el checkout embebido con <code>monetiser.js</code> y un webhook firmado. La tarjeta nunca pasa por tu servidor ni por el nuestro.</p>
<div class="cards">
<div class="card"><a href="#ep-post-v1-checkout-sessions">1 · Crea la sesión</a><p>Desde tu servidor, con tu clave de pruebas.</p></div>
<div class="card"><a href="#guia-2-mostrar-el-checkout-en-tu-web">2 · Muestra el checkout</a><p>Embebido con monetiser.js o a pantalla completa.</p></div>
<div class="card"><a href="#guia-3-confirmar-el-pago-en-tu-servidor">3 · Confirma por webhook</a><p>Firmado con <code>Monetiser-Signature</code>.</p></div>
<div class="card"><a href="#guia-4-cobrar-devolver-y-anular">4 · Captura y devuelve</a><p>Total o parcial, con idempotencia.</p></div>
</div>
<section id="guia">${guide.html}</section>
<h2 id="api">Endpoints de la API v1 y ejemplos</h2>
<p>Generado desde <code>openapi.yaml</code> (versión ${esc(spec.info.version)}). Detalle de cada campo y respuesta en la <a href="/docs">referencia de la API</a>.</p>
${endpoints}
</main>
</div>
</body>
</html>
`;
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, build());
  console.log(`Generado ${path.relative(ROOT, OUT)}`);
}

module.exports = { build, markdown, OUT };

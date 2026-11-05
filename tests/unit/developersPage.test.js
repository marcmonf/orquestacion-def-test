// tests/unit/developersPage.test.js
'use strict';
// /developers (5 nov 2026, F2) es HTML GENERADO desde docs/integracion.md y
// openapi.yaml. Si alguien cambia esos ficheros y no regenera, esto falla:
//   node scripts/build-developers.js
const fs = require('fs');
const { build, markdown, OUT } = require('../../scripts/build-developers');

test('public/developers/index.html está al día con openapi.yaml y docs/integracion.md', () => {
  expect(fs.readFileSync(OUT, 'utf8')).toBe(build());
});

test('incluye la guía, todos los endpoints v1 de la spec y ejemplos curl / Node / PHP', () => {
  const html = build();
  const yaml = require('js-yaml');
  const spec = yaml.load(fs.readFileSync(require('path').join(__dirname, '../../openapi.yaml'), 'utf8'));
  const v1 = Object.keys(spec.paths).filter((p) => p.startsWith('/v1/'));
  for (const p of v1) expect(html).toContain(`<code>${p}</code>`);
  expect(html).toContain('curl -X POST https://orquestacion-def-test.onrender.com/v1/checkout-sessions');
  expect(html).toContain('<summary>Node.js</summary>');
  expect(html).toContain('<summary>PHP</summary>');
  expect(html).toContain('id="guia-estados"');
  expect(html).toContain('href="/docs"');
  // Nada ejecutable: la página se sirve con script-src 'none'.
  expect(html).not.toMatch(/<script/i);
});

test('markdown mínimo: escapa HTML y no deja pasar enlaces javascript:', () => {
  const { html } = markdown('Texto <b>x</b> y [mal](javascript:alert(1)) y [bien](/docs)');
  expect(html).toContain('&lt;b&gt;');
  expect(html).not.toContain('javascript:');
  expect(html).toContain('<a href="/docs">bien</a>');
});

// tests/unit/openapiSpec.test.js
'use strict';

/**
 * BLINDAJE DE openapi.yaml.
 *
 * Motivo (4 ago 2026): la spec llevaba SIN PARSEAR desde M6 Fase 4 — clave
 * `'403'` duplicada en `/portal/hierarchy`, que en YAML es error de parseo, no
 * un aviso. El DEV-LOG la daba por "validada con js-yaml, 0 refs rotas" desde
 * M4: cierto en v1.0.0 y falso durante cinco versiones (v2.4.0 → v2.8.0),
 * porque nadie la volvió a cargar. Swagger UI (/docs) no habría podido
 * mostrarla nunca.
 *
 * La lección era: un artefacto que se declara "validado" y no tiene un test que
 * lo valide, deja de estarlo en silencio. Esto es ese test.
 *
 * Requiere `js-yaml`, que desde esta misma fecha es devDependency declarada
 * (antes solo existía de rebote en algún node_modules local).
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SPEC_PATH = path.join(__dirname, '../../openapi.yaml');
const raw = fs.readFileSync(SPEC_PATH, 'utf8');

/** Recorre el documento recogiendo todos los $ref internos. */
function collectRefs(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach(n => collectRefs(n, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/')) out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

/** Resuelve un puntero JSON interno; devuelve undefined si está roto. */
function resolveRef(doc, ref) {
  return ref.slice(2).split('/').reduce(
    (acc, seg) => (acc == null ? undefined : acc[seg.replace(/~1/g, '/').replace(/~0/g, '~')]),
    doc
  );
}

describe('openapi.yaml — integridad de la spec', () => {
  let doc;

  test('parsea sin errores (incluye claves duplicadas)', () => {
    // js-yaml lanza `duplicated mapping key` por defecto: es justo el fallo
    // que estuvo cinco versiones sin detectarse.
    expect(() => { doc = yaml.load(raw); }).not.toThrow();
    expect(doc).toBeTruthy();
  });

  test('es OpenAPI 3.x con info.version', () => {
    doc = doc || yaml.load(raw);
    expect(String(doc.openapi)).toMatch(/^3\./);
    expect(doc.info?.version).toBeTruthy();
  });

  test('no hay ningún $ref interno roto', () => {
    doc = doc || yaml.load(raw);
    const refs = [...new Set(collectRefs(doc))];
    expect(refs.length).toBeGreaterThan(0);
    const rotos = refs.filter(r => resolveRef(doc, r) === undefined);
    expect(rotos).toEqual([]);
  });

  test('tiene rutas y schemas, y toda ruta declara al menos una operación', () => {
    doc = doc || yaml.load(raw);
    const paths = Object.keys(doc.paths || {});
    expect(paths.length).toBeGreaterThan(0);
    expect(Object.keys(doc.components?.schemas || {}).length).toBeGreaterThan(0);

    const METODOS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
    const vacias = paths.filter(p => !METODOS.some(m => doc.paths[p]?.[m]));
    expect(vacias).toEqual([]);
  });

  test('toda operación declara respuestas', () => {
    doc = doc || yaml.load(raw);
    const METODOS = ['get', 'post', 'put', 'patch', 'delete'];
    const sinResponses = [];
    for (const [p, item] of Object.entries(doc.paths || {})) {
      for (const m of METODOS) {
        const op = item?.[m];
        if (op && !op.responses) sinResponses.push(`${m.toUpperCase()} ${p}`);
      }
    }
    expect(sinResponses).toEqual([]);
  });
});

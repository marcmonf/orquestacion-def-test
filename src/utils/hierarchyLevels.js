// src/utils/hierarchyLevels.js
'use strict';
//
// Niveles de la jerarquía de tiendas (M6 Fase 2), de MÁS ARRIBA a MÁS ABAJO.
// El rango (RANK) sirve para validar el árbol: el padre de un nodo debe ser de un
// nivel estrictamente superior (rango menor). Se permite saltar niveles (una
// tienda puede colgar directamente de un grupo), pero nunca colgar de un nivel
// igual o inferior. Esa regla, además, hace IMPOSIBLE un ciclo: siguiendo los
// padres siempre se sube de nivel, nunca se vuelve.
//
const NODE_TYPES = ['globalGroup', 'group', 'branch', 'region', 'store'];
const RANK = NODE_TYPES.reduce((m, t, i) => { m[t] = i + 1; return m; }, {});

module.exports = { NODE_TYPES, RANK };

# CLAUDE.md

Eres el arquitecto tecnico de Monetiser, una Payment Orchestration Platform SaaS B2B.
El founder (Marcos) no tiene perfil tecnico. Tu haces los commits directamente al repo via GitHub API.

## Lo primero que debes hacer en cada chat

1. Leer DEV-LOG.md del repo para entender el estado actual y los proximos pasos
2. Nunca pedir a Marcos que pegue contenido de archivos — los lees tu directamente

## Repo

- marcmonf/orquestacion-def-test (publico, GitHub, rama main)
- Stack: Node.js + Express + MongoDB Atlas
- Despliegue: Render — https://orquestacion-def-test.onrender.com

## Credenciales

Este repo es PUBLICO. Nunca se escribe un token, clave o secreto en ningun archivo
del repo — ni troceado. El acceso a GitHub va por el llavero del sistema
(git credential helper); si hace falta un PAT nuevo, se guarda ahi.

## Reglas de trabajo

- Instrucciones extremadamente explicitas, valores exactos, sin contexto asumido
- Archivos completos siempre, nunca fragmentos
- Nunca decirle a Marcos que un comportamiento incorrecto es correcto
- Tolera el error; no tolera el vacile

## Verificacion — node --check NO BASTA

Aprendido a base de romper main (16 jul 2026). Antes de commitear cualquier
borrado o cambio de imports, hay que ARRANCAR la aplicacion:

```
node -e "process.env.MONGO_URI='mongodb://127.0.0.1:27017/fake'; require('./index.js')"
```

Por que no basta lo de siempre:
- `node --check` valida la SINTAXIS de un archivo suelto. No resuelve requires.
  Un require a un archivo borrado pasa el check y revienta al arrancar.
- `npx jest` mockea dependencias y no carga el grafo real de index.js.
  Linea base: 119/128 (los 9 fallos de webhooks.test.js son PREEXISTENTES).

Y ojo con esto, que es lo que hizo el fallo dificil de ver: `index.js` monta
varias rutas dentro de `try/catch`. Un MODULE_NOT_FOUND ahi se traga y sale como
`⚠️ [WARN] /transactions no montado (archivo faltante)` — mensaje enganoso: el
archivo esta; falta lo que EL requiere. Si ves ese warning, no lo ignores.

Antes de borrar un archivo, comprobar quien lo requiere DE VERDAD, uno por uno:

```
grep -rn "require(.*/nombreDelArchivo')" --include="*.js" src/ index.js tests/
```

No basta con mirar quien usa el "hub" o el modulo padre: puede haber requires
directos. Asi se rompio main — transactionController requeria los conectores APM
sin pasar por apmHub.

## Despliegue — el auto-deploy de Render NO es fiable

El 16 jul 2026 se subieron 9 commits a main y Render no desplego ninguno; hubo
que lanzar un Manual Deploy desde el panel. Un commit en main NO significa que
este en produccion.

Tras cada push, confirmar que el deploy entro antes de dar nada por bueno ni
pedirle a Marcos que pruebe. Si un cambio "no funciona", lo primero que hay que
descartar es que siga corriendo el codigo viejo: es la causa recurrente de falsos
negativos en este proyecto.

## Contrato con Paylands

Ante cualquier duda de nomenclatura, manda la documentacion de Paylands. Ejemplo
real: los estados de anulacion se escriben `cancelled` con dos L porque Paylands
usa `POST /payment/cancellation` y manda `CANCELLED` en el webhook.

Lo verificado end-to-end contra Paylands real (NO tocar sin motivo): hosted
checkout, y el ciclo de vida refund/capture/cancel con `operative: DEFERRED`
(`/payment/confirmation` y `/payment/cancellation`).

## Lectura del DEV-LOG

El DEV-LOG.md del repo contiene:
- Arquitectura completa del sistema
- Fases completadas con detalle tecnico
- Bugs resueltos y decisiones tomadas
- Gaps actuales y deuda tecnica
- Hoja de ruta con los proximos hitos (M2, M3, M4...)
- Variables de entorno y referencia de endpoints

Leelo siempre antes de proponer o implementar cualquier cosa.

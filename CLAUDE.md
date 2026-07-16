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
- Verificar sintaxis con node --check antes de commitear
- Nunca decirle a Marcos que un comportamiento incorrecto es correcto
- Tolera el error; no tolera el vacile

## Lectura del DEV-LOG

El DEV-LOG.md del repo contiene:
- Arquitectura completa del sistema
- Fases completadas con detalle tecnico
- Bugs resueltos y decisiones tomadas
- Gaps actuales y deuda tecnica
- Hoja de ruta con los proximos hitos (M2, M3, M4...)
- Variables de entorno y referencia de endpoints

Leelo siempre antes de proponer o implementar cualquier cosa.

# Auditoría de publicación 0.3.0

Fecha: 2026-10-23
Proyecto: `opencode-fallback`
Destino previsto: `facishola/relevo-opencode`

## Alcance

Se revisó el historial Git disponible, el árbol de trabajo y el contenido que
entra en el paquete npm. La auditoría se hizo antes de crear o publicar el
repositorio público. No se inspeccionaron ni modificaron la configuración
global de OpenCode, el plugin global, proyectos protegidos, credenciales ni
respaldos externos.

## Controles ejecutados

- Historial completo de las referencias locales con `git rev-list --all` y
  búsqueda de patrones de claves `sk-*`, tokens GitHub, claves AWS, cabeceras
  Bearer y llaves privadas.
- Árbol de trabajo con la misma búsqueda, excluyendo logs, backups y
  `node_modules`.
- `node scripts/validate-package.mjs`.
- `npm pack --dry-run --ignore-scripts --offline`.
- `npm audit --omit=dev --audit-level=high`.
- Revisión de la allowlist `files` de `package.json`.

## Resultado

| Superficie | Resultado |
|---|---:|
| Commits auditados | 1 |
| Coincidencias históricas de secretos | 0 |
| Coincidencias en el árbol de trabajo | 0 |
| Vulnerabilidades altas/críticas de producción | 0 |
| Dependencias runtime | 0 |
| Archivos en el tarball | 27 |

El paquete no incluye tests, logs, caches, bases de datos, respaldos ni
credenciales. Los valores `apiKey: "test"` que existen en fixtures no se
incluyen en el tarball y son endpoints loopback de prueba, no credenciales.

## Decisión

**APTO para crear el repositorio público**, sujeto a verificar después de la
publicación un clone limpio, la instalación portable y la suite de pruebas.

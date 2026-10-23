# Auditoría de seguridad local — Fase 1

Fecha de ejecución: 2026-10-22/23, hora local.

## Alcance y autorización

Se auditó únicamente `C:\Users\Norbe\opencode-fallback-lab\plugins\opencode-fallback`. No se modificaron la configuración global de OpenCode, el plugin global, proyectos protegidos, respaldos ni logs históricos. Las pruebas operacionales usaron solo OpenCode y mocks en `127.0.0.1`; no se usaron proveedores reales ni servicios externos.

## Modelo de amenaza

- Entradas: opciones del plugin, eventos `retry`, referencias de modelo, IDs de sesión, errores del proveedor, metadatos de modelos y valores recuperados de `ctx.storage`.
- Activos: credenciales, prompts y contenido privado; integridad del callback `retry`; límites de memoria/estado; selección correcta del modelo.
- Riesgos revisados: inyección en logs, filtración de secretos, entradas sobredimensionadas, estado persistido malformado, iteradores de modelos sin límite y sinks de red/proceso no autorizados.

## Cambios de endurecimiento

- `lib/runtime.js`: límites y rechazo de caracteres de control para referencias de modelo e identificadores; intentos acotados; redacción de credenciales en texto; protección contra referencias circulares al redactar opciones.
- `index.js`: líneas de log acotadas a 4096 caracteres, cola existente limitada a 100 elementos, estado de sesión y arrays limitados a 64 elementos, claves de intentos validadas y mensajes de error del proveedor no incluidos en el diagnóstico.
- `lib/policy.js`: límites numéricos finitos para metadatos, inventario asíncrono limitado a 512 elementos y caché de metadatos limitada a 128 modelos.
- Tests: casos negativos para credenciales en errores, caracteres de control, referencias sobredimensionadas, intentos inválidos, estado persistido malformado y límites de inventario.

## Evidencia

| Control | Resultado |
|---|---|
| `npm test` | PASS: 23 tests, más carga del módulo de política |
| `node --check` | PASS en código y fixtures `.mjs` |
| `npm pack --dry-run --ignore-scripts --offline` | PASS: 5 archivos distribuibles, sin tarball persistente |
| Sinks de red/proceso | PASS: no se encontraron `fetch`, clientes HTTP, `child_process`, `exec`, `spawn` ni `eval` en el código ejecutable |
| Secretos literales | PASS: no se encontraron credenciales con forma de secreto en código ejecutable |
| Puertos posteriores | PASS: sin listeners en 28900, 9129, 9130 o 9131 |
| T0 | PASS: respuesta Mock A; A=2 POST, B=0, C=0 |
| T1 | PASS: respuesta Mock B; A=2 POST, B=1, C=0 |
| T2 | PASS esperado: HTTP 400 propagado; A=2 POST, B=0, C=0 |

## Limitaciones

- No existe lockfile ni dependencia declarada en el laboratorio; `npm audit` no aporta una comprobación reproducible sin introducir una consulta de red.
- `logDir` sigue siendo una ruta local configurable por el administrador; no se añadió una allowlist de rutas porque cambiaría el contrato de configuración.
- No están implementados todavía el guard de stream parcial/tool-call, el cálculo de tokens, la compactación al 80% ni el relevo de agentes.
- El chequeo de contexto sigue siendo conservador y basado en metadatos estáticos de OpenCode; no demuestra que un request real quepa en un modelo con tokenizer o capacidades diferentes.

## Clasificación

**APROBADO PARA EL ALCANCE DE SEGURIDAD LOCAL DE FASE 1, CON LIMITACIONES.** La fase global permanece **PARCIAL** hasta completar el guard de ejecución parcial, la medición de contexto y la compactación con confirmación de finalización.

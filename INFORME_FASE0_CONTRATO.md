# Informe Fase 0 — Contrato y compatibilidad del runtime

Fecha: 2026-10-23

## Alcance

Se cerró el checkpoint de compatibilidad: contrato de activación, forma del modelo del evento `retry`, versión real del runtime, normalización de referencias, compatibilidad de `ctx.storage` y redacción de opciones de diagnóstico. No se incorporaron compactación, streaming guard, `SessionLock`, invalidación de caché ni relevo de agente.

## Archivos modificados

- `index.js`: activación segura por defecto; normalización de `event.model.id` con compatibilidad para `modelID`; lectura compatible con valores JSON y cadenas heredadas; persistencia de intentos como valor JSON.
- `lib/runtime.js`: adaptador puro para referencias de modelos, storage, versión del runtime y redacción diagnóstica.
- `package.json`: scripts `test:contract`, `test:runtime` y `test`.
- `tests/phase0-contract.test.mjs`: pruebas de contrato y de tolerancia a fallos de AsyncLogger.
- `tests/phase0-runtime.test.mjs`: pruebas del adaptador y validación de referencias.
- `tests/fixtures/mock-400-server.mjs`: fixture local válido para comprobar HTTP 400 sin el header `undefined` del mock anterior.
- `tasks/todo.md`: estado de las tareas verificadas.

Durante la validación de Fase 0 no se modificó `lib/policy.js`; posteriormente recibió los cambios aislados de Fase 1 documentados en `INFORME_FASE1_ESTADO.md`.

## Validación

| Prueba | Resultado | Evidencia |
|---|---|---|
| RED inicial | PASS como prueba RED | 3 fallos esperados: activación implícita, `event.model.id` y storage serializado |
| GREEN / contrato | PASS | 5 pruebas Node; 5/5 pasan |
| Adaptador runtime | PASS | 5 pruebas Node; 5/5 pasan |
| `npm test` | PASS | contrato 5/5, runtime 5/5 y carga de `FallbackPolicy` |
| Versión runtime | PASS | T0 registra `runtimeVersion=2.1.3` |
| T0 tras el adaptador | PASS | `phase0b_t0_20261022_213848`: respuesta de Mock A; Mock A=2 POST; Mock B/C=0; registro de hook |
| Hook en nueva solicitud | PASS | `phase0b_t1_20261022_213858` produjo `RETRY ... eventModel=mocka/m-a` y decisión de cambio |
| Logger | PASS | escritura normal; `EEXIST` simulado; el hook mantuvo `retry=false` y no lanzó excepción |
| T1: 429 → fallback | PASS | `phase0b_t1_20261022_213858`: Mock A=2 POST; Mock B=1; Mock C=0; respuesta Mock B; `SWITCHMODEL -> mockb/m-b` |
| T2: 400 sin fallback | PASS | `phase0b_t2_20261022_213909`: Mock A=2 POST; Mock B/C=0; el hook recibió `status=400 type=provider.invalid-request` y decidió `retry=false`. El exit code 1 es la propagación esperada del error. |

## Observaciones y límites

El mock flexible original tenía un defecto de Node 24: enviaba `Retry-After: undefined` para respuestas distintas de 429 y abortaba con `ERR_HTTP_INVALID_HEADER_VALUE`. No se modificó ese artefacto; se añadió un fixture válido dentro del plugin para probar la integración real conservando el status 400.

No se realizaron solicitudes a proveedores reales ni servicios externos. Los logs y artefactos previos se conservaron.

## Clasificación

**APROBADO para el checkpoint de compatibilidad.** T0, hook, AsyncLogger, T1 y T2 pasan con mocks locales; la versión real queda registrada como OpenCode 2.1.3. El adaptador cubre datos y storage, mientras que las llamadas de sesión permanecen directas hasta una fase posterior. La medición de contexto, ciclos, concurrencia, streaming y compaction siguen pendientes. No se inicia la siguiente fase automáticamente.

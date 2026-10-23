# Informe Fase 1 — Estado, ciclos y transición por sesión

Fecha: 2026-10-23

## Alcance ejecutado

Se implementó el subpaso de motor puro y estado mínimo del fallback. El cambio incluye clasificación conservadora, registro de intentos, estado persistente versionado por sesión, presupuesto de transiciones, prevención de ciclos y serialización de transiciones por sesión.

Quedan fuera de este subpaso: streaming parcial, tool-calls, validación exhaustiva de capacidades, T3–T11 completos, medición de contexto y compaction.

## Cambios

- `lib/policy.js`
  - `selectNext` acepta modelos visitados y no vuelve a destinos excluidos.
  - Errores permanentes tienen precedencia incluso si traen `isRetryable: true`.
- `index.js`
  - `recordAttempt` se ejecuta una sola vez por intento lógico.
  - Estado `fallback:session_state:<sessionID>` con versión, modelo activo, visitados, transiciones e intentos atendidos.
  - Presupuesto configurable mediante `max_transitions`, con valor seguro derivado de la cadena.
  - Transiciones serializadas por sesión; el registro del hook permanece fuera de la cola.
  - Estado y listas acotados a 64 entradas.
- `lib/runtime.js`
  - Valida referencias de modelo e identificadores contra controles y longitudes excesivas.
  - Normaliza intentos y redacta texto diagnóstico antes de escribirlo en logs.
  - Protege la redacción de opciones contra referencias circulares.
- `tests/phase1-policy.test.mjs`: 4 pruebas del motor puro.
- `tests/phase1-integration.test.mjs`: 3 pruebas de integración, incluidos ciclo, duplicado y concurrencia.
- `package.json`: scripts reproducibles de Fase 1 incluidos en `npm test`.

## Validación

| Prueba | Resultado | Evidencia |
|---|---|---|
| Política pura | PASS | 3/3: clasificación, cooldown/límites y destinos visitados |
| Integración aislada | PASS | 3/3: A→B→C sin A, duplicado y callbacks concurrentes |
| Suite completa | PASS | 7 contractuales + 9 runtime + 4 política + 3 integración + carga de política |
| Endurecimiento local | PASS | Secretos en diagnósticos, entradas malformadas, estado persistido y límites de inventario cubiertos |
| T0 tras endurecimiento | PASS | `security_t0_post_20261022_214736`: Mock A=2, B/C=0, respuesta normal |
| T1 tras endurecimiento | PASS | `security_t1_20261022_214827`: Mock A=2, B=1, C=0, respuesta Mock B |
| T2 tras endurecimiento | PASS | `security_t2_20261022_214848`: HTTP 400, Mock A=2, B/C=0, `retry=false` |
| Sintaxis y sinks | PASS | `node --check`; sin fetch, clientes HTTP, ejecución de procesos ni listeners residuales |
| Empaquetado | PASS | `npm pack --dry-run --ignore-scripts --offline`: 5 archivos distribuibles, sin tarball persistente |

No se usaron proveedores reales ni servicios externos.

## Estado

**PARCIAL — subpaso aprobado.** El fallback básico tiene límites de transición, estado acotado, coordinación por sesión y redacción defensiva en el alcance probado. No se inicia todavía Fase 2: primero deben completarse las pruebas T3–T11 y la protección contra stream parcial/tool-call. El empaquetado offline pasó; no hay lockfile ni dependencias declaradas, por lo que no se ejecutó una auditoría de dependencias que requiriera red.

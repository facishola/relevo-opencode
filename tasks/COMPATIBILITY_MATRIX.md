# Matriz de compatibilidad y puertas de activación

## Resultado actual

| Runtime | Alcance | Resultado | Evidencia |
| --- | --- | --- | --- |
| OpenCode V2 2.1.3 | Mocks loopback, XDG aislado | APROBADO para laboratorio | T0–T12 end-to-end, suite local, paquete local |
| OpenCode V2 2.1.3 | Paquete público 0.3.0, instalación local aislada | APROBADO como MVP público | metadata, instalador, descubrimiento automático estricto, paquete limpio, CI preparada |
| OpenCode V2 no probado | Cualquier proveedor | DESCONOCIDO | Repetir contrato y matriz antes de activar |
| Proveedores reales | Canaries aislados, solo modelos gratuitos | PARCIAL | OpenRouter, Nvidia y OpenCode tuvieron candidatos PASS; cuotas y endpoints no son uniformes |

## Capacidades requeridas

El plugin inspecciona la forma del runtime antes de registrar hooks. Son
imprescindibles:

| Capacidad | Uso | Si falta |
| --- | --- | --- |
| `ctx.session.hook` | Registrar `context` y `retry` | Plugin incompatible, cero hooks |
| `ctx.session.switchModel` | Cambiar el destino | Plugin incompatible, cero hooks |
| `ctx.storage.get/set` | Estado durable y control por sesión | Plugin incompatible, cero hooks |
| `ctx.model.list` | Medir límites/contexto cuando se exige la comprobación | Plugin incompatible, cero hooks |

Son capacidades opcionales para funciones adicionales:

| Capacidad | Uso | Si falta |
| --- | --- | --- |
| `ctx.tool.transform` | `model_fallback_control` interactivo | Continúa el modo por configuración; no se afirma control interactivo |
| `ctx.event.subscribe` | Guardar señales de salida parcial/herramientas y verificar compaction | Se bloquean decisiones ambiguas; no se inventa compatibilidad |
| `ctx.session.compact` + `ctx.session.context` | Compaction opt-in y comprobación durable | La compaction solicitada por el plugin queda bloqueada |

La versión declarada del runtime no sustituye esta comprobación de forma. Una
versión puede exponer el nombre de una API y entregar una forma incompatible.

## Gates de activación

1. **Local:** T0–T12 pasan con mocks loopback; no hay listeners remanentes ni
   tráfico externo.
2. **Paquete:** `npm test`, `node --check`, `npm pack --dry-run --ignore-scripts
   --offline` e instalación desde ruta local pasan.
3. **Seguridad:** logs redactados, sin dependencias runtime innecesarias,
   auditoría offline sin vulnerabilidades y hash de `lib/policy.js` preservado.
4. **Canary:** requiere proveedor/modelo exactos, autorización de red,
   presupuesto, proyecto aislado y evidencia de respuesta normal antes de
   probar una transición.
5. **Producción/publicación:** requiere resolver el canary, fijar una versión
   no prototipo, revisar dependencias contra el registro y documentar soporte
   por versión de OpenCode.

## Decisiones explícitas

- `enabled` permanece `false` por defecto.
- `compaction_enabled` del plugin es independiente de `compaction.auto` de
  OpenCode.
- La compaction del plugin solo acepta la operación cuyo `inputID` coincide con
  el ID idempotente solicitado y cuyo mensaje durable conserva ese ID con
  estado `completed`; eventos de otra operación quedan bloqueados.
- No se usa `session.interrupt()` automáticamente para cancelar una espera
  auxiliar: esa operación puede interrumpir la sesión completa. El runtime
  actual usa timeouts acotados y `AbortSignal` donde la API lo admite,
  fail-closed y cancelación best-effort; el runtime puede ignorar la señal.
- No se relevarán agentes automáticamente en este MVP.
- `model.list()` demuestra inventario/configuración, no salud real, credenciales
  válidas ni compatibilidad efectiva del endpoint.

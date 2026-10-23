# Estado de cierre — fallback automático V2

## Completado

- [x] Contrato V2 `{ id, setup }`, activación explícita y configuración del laboratorio apuntando a `plugins/opencode-fallback` con `enabled: false`.
- [x] T0–T12 end-to-end con OpenCode 2.1.3 y mocks loopback: respuesta normal, 429, errores permanentes, cadena agotada, desactivación, límites de contexto, streaming, modelo activo, ciclos, regresión y transporte sin respuesta.
- [x] Transporte sin respuesta HTTP probado con A→B; transporte posterior a HTTP 2xx tratado como stream ambiguo y bloqueado.
- [x] Estado de intentos/cooldown acotado por sesión y modelo; transiciones serializadas por sesión; concurrencia y duplicados cubiertos.
- [x] Medición de `system`, `messages`, `tools` y reserva de salida con margen 80%; desconocidos, overflow y destino insuficiente bloquean.
- [x] Compactación opt-in con umbral, ID acotado, evento terminal, estado durable `completed` y medición fresca; fallos/stale/destino insuficiente bloquean.
- [x] Control V2 por sesión (`enable`, `disable`, `status`, `reset`) con detección segura de `ctx.tool.transform`.
- [x] Puerta de compatibilidad por capacidades: el plugin queda fail-closed antes de registrar hooks si faltan APIs esenciales del runtime.
- [x] AsyncLogger asíncrono, cola acotada, límite de archivo, redacción y fallo de escritura sin romper el hook.
- [x] Suite `npm test`, `node --check`, `npm pack --dry-run --ignore-scripts --offline` e instalación desde ruta local en proyecto aislado.
- [x] Skill compañero de configuración/diagnóstico separado del plugin runtime.
- [x] Revisión de sinks, logs, listeners del harness y tráfico exclusivamente loopback en las pruebas ejecutadas.
- [x] Hash histórico de `lib/policy.js` preservado en la documentación; el hash
  vigente tras la ampliación autorizada es
  `A35119E74F87B9927A024F2110F09B3C3873464D5A132341F4AEF45C8DCDBA8E`.

## Pendiente por diseño o autorización separada

- [x] Canary real histórico documentado: Google y Mistral respondieron; Groq
  mostró límite de organización; DeepSeek quedó descartado por saldo
  insuficiente; OpenRouter free quedó inconcluso. Evidencia en
  `../../REAL_PROVIDER_CANARY_2026-10-23.md`. No se repite ni se amplía con
  modelos pagos; el cierre actual usa mocks y loopback.
- [x] Relevo automático de agentes: cerrado fuera del MVP mediante
  `docs/decisions/ADR-002-agent-handoff-boundary.md`; requiere un contrato y
  pruebas independientes para prompt, herramientas, permisos y contexto.
- [x] Cancelación auxiliar acotada: `session.compact()`, `session.context()`,
  inventario de modelos, storage y `switchModel` tienen timeout; se propaga
  `AbortSignal` cuando la API lo admite y se abortan controladores pendientes en
  cleanup. La cancelación física del runtime no se afirma como garantizada y
  `session.interrupt()` no se usa automáticamente.
- [x] Auditoría local/offline de dependencias: se añadió `package-lock.json` mínimo, no hay dependencias runtime y `npm audit --offline --omit=dev` informa 0 vulnerabilidades. La auditoría contra registro queda condicionada a introducir dependencias o preparar una publicación.
- [x] Runbook de canary controlado y matriz de compatibilidad: preparados sin habilitar tráfico externo.
- [x] Decisión de cancelación: no usar `session.interrupt()` automáticamente porque puede interrumpir toda la sesión; el runtime actual queda acotado por timeout y fail-closed.
- [x] Entorno OpenCode activo local: plugin habilitado en proyecto aislado, skill registrado, catálogo standalone validado y transición mock 429 → Ollama local confirmada.

## Free-only y cuotas por proveedor

- [x] Implementar `free_only` + `free_models` con rechazo fail-closed de destinos pagos o de precio desconocido.
- [x] Clasificar saldo insuficiente y bloquear el proveedor sin reintentar el mismo destino.
- [x] Detectar evidencia explícita de cuota compartida y aplicar cooldown por proveedor.
- [x] Mantener cuotas model-scoped como bloqueo solo del modelo.
- [x] Añadir pruebas unitarias/integración y actualizar README, changelog, ADR e informe.

## Puerta de cierre

Resultado actual: **APROBADO para laboratorio/mock-only**. Esto no equivale a
infalibilidad ni a aprobación de producción. Si cambia la versión de OpenCode,
se debe repetir la matriz local antes de activar el plugin.

## Distribución portable por proyecto

- [x] Verificar instalación del kit en un proyecto temporal sin configuración.
- [x] Verificar que un `opencode.jsonc` existente no se sobrescribe.
- [x] Revisar comandos slash, skill y README.txt con la validación del paquete.
- [x] Crear snapshot Git inicial en `master` después de la revisión staged.

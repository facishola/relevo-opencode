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

## Descubrimiento automático estricto — release 0.3.0

- [x] Descubrir candidatos desde `ctx.model.list()` sin lista manual.
- [x] Normalizar costes como objeto y como colección de niveles.
- [x] Rechazar precio desconocido, modelos pagos, disabled/deprecated y
  capacidades o límites incompatibles.
- [x] Mantener `free_models` como excepción explícita para modelos locales sin
  precio publicado, sin sobrepasar límites desconocidos.
- [x] Permitir destinos con una ventana menor cuando la solicitud medida cabe
  dentro del margen de seguridad del 80%.
- [x] Añadir caché acotada del inventario y diagnóstico de candidatos excluidos.
- [x] Generar configuración portable con descubrimiento activado y plugin
  desactivado.

## Puerta de cierre

Resultado actual: **APROBADO para laboratorio/mock-only y descubrimiento automático**. Esto no equivale a
infalibilidad ni a aprobación de producción. Si cambia la versión de OpenCode,
se debe repetir la matriz local antes de activar el plugin.

## Distribución portable por proyecto

- [x] Verificar instalación del kit en un proyecto temporal sin configuración.
- [x] Verificar que un `opencode.jsonc` existente no se sobrescribe.
- [x] Revisar comandos slash, skill y README.txt con la validación del paquete.
- [x] Crear snapshot Git inicial en `master` después de la revisión staged.

## Fase 8 — MVP público reproducible

- [x] Auditar y fijar metadata pública del paquete, licencia, versión y URL del repositorio.
- [x] Agregar pruebas de paquete limpio, exclusión de artefactos y consistencia de release.
- [x] Verificar instalación desde una copia limpia/paquete en un proyecto aislado.
- [x] Endurecer y probar el instalador contra destinos inválidos, reinstalación y configuración existente.
- [x] Agregar CI para Node soportado, suite, sintaxis, paquete y auditoría de dependencias.
- [x] Actualizar README/README.txt, changelog, matriz de compatibilidad, seguridad y guía de publicación.
- [x] Ejecutar auditoría de secretos, dependencias, listeners y tráfico externo.
- [x] Realizar code review de cinco ejes y resolver hallazgos críticos/requeridos.
- [x] Preparar snapshot Git y release; publicar solo después de confirmar la visibilidad del repositorio.

## Release 0.3.0 — publicado y verificado

- [x] Implementar descubrimiento automático estricto y probarlo sin lista manual.
- [x] Actualizar instalador, documentación y metadata a `relevo-opencode`.
- [x] Verificar T0–T12 después del cambio y ejecutar validación de paquete.
- [x] Auditar historial completo en busca de secretos antes de publicar.
- [x] Crear repositorio público `facishola/relevo-opencode` sin tocar el privado.
- [x] Crear snapshot Git reproducible y subirlo sin `--force`.
- [x] Clonar el repositorio público en un directorio temporal y repetir la
  instalación y pruebas de release.

## Puerta de aceptación del MVP público

- [x] Todas las pruebas unitarias, contractuales, distribución y E2E loopback pasan.
- [x] El tarball contiene solo archivos distribuibles y el instalador deja `enabled: false`.
- [x] La documentación permite instalar y revertir sin modificar configuración global.
- [x] No hay secretos ni artefactos de laboratorio en el snapshot ni en el paquete.
- [x] El resultado queda clasificado como MVP público compatible con OpenCode 2.1.3.

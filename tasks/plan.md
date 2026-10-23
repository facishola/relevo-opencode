# Plan de implementación: relevo seguro de modelos y agentes en OpenCode V2

## Objetivo

Convertir el laboratorio en un producto portable para OpenCode V2: un plugin de runtime que pueda relevar modelos/proveedores ante fallos recuperables y, en una fase separada, permitir el relevo explícito de agentes sin perder seguridad de contexto, límites de intentos, permisos ni trazabilidad.

El producto se complementará, cuando el runtime esté estable, con un skill de instalación y diagnóstico. El skill no reemplaza al plugin: los skills aportan instrucciones reutilizables, mientras que los hooks y las operaciones de sesión necesarias para detectar fallos, medir contexto y cambiar de modelo pertenecen al plugin.

El primer producto aceptable es **fallback de modelo**. El relevo de agente no se considera equivalente: cambia prompt, herramientas, permisos y posiblemente el modelo asociado.

## Estado actual

- El laboratorio ya tiene una línea base funcional y el Paso 1 de la Fase 14C.3.2 quedó aprobado: incorporación aislada de `AsyncLogger`, con T0, hook, logger, T1 y T2 ejecutados con mocks locales.
- El plugin sigue siendo un prototipo (`0.1.0-prototype`) y no está listo para producción. El MVP de laboratorio está APROBADO: la suite local y la matriz T0–T12 end-to-end pasan con mocks loopback.
- El informe de Paso 1 histórico se conserva en `../../INFORME_FASE14C3_2_PASO1.md` si existe; el informe de cierre vigente es `INFORME_FASE14C3_2_FINAL.md`.
- Solo se autorizan canaries reales de modelos gratuitos ya identificados; no se usarán modelos pagos ni se agotarán cuotas. El relevo automático de agentes sigue fuera del MVP. El informe de cierre es `INFORME_FASE14C3_2_FINAL.md`.
- La revisión adversarial confirmó que el relevo automático de agentes no debe ejecutarse dentro de `retry`: `switchAgent` altera prompt, herramientas, permisos y posiblemente el modelo. La decisión queda formalizada en `docs/decisions/ADR-002-agent-handoff-boundary.md`.

## Ejecución autorizada actual

La solicitud actual autoriza completar las tareas pendientes dentro del laboratorio, sin activar configuración global ni usar proveedores externos. El orden operativo será:

1. Añadir una barrera de side effects basada únicamente en eventos locales observables (`session.text.*` y `session.tool.*`). Si la suscripción no existe, el fallback queda bloqueado de forma conservadora.
2. Añadir el ciclo de compaction nativa solo como solicitud explícita y observable. El plugin no esperará una promesa de admisión como si fuera un resumen terminado; si el runtime no puede confirmar `completed`, se conserva el error y no se cambia de modelo.
3. Revalidar el contexto después de cualquier compaction confirmada (evento terminal y estado durable cuando existe) y antes de `switchModel`.
4. Completar la configuración `enabled`, límites de espera, reentrada y documentación; el valor seguro seguirá siendo desactivado.
5. Ejecutar T0–T12 con fixtures loopback y canaries únicamente gratuitos; revisar el diff. El relevo automático de agente permanece fuera del MVP porque cambia prompt, herramientas y permisos; se documentará como fase posterior, no se simulará como fallback de modelo.

### Fase 5B — alcance free-only y cuotas por proveedor

**T5B.1 — Allowlist gratuita fail-closed**

- Añadir `free_only` y `free_models` a las opciones del plugin.
- Cuando `free_only: true`, exigir una allowlist explícita y no seleccionar destinos fuera de ella.
- Tratar precio desconocido como no elegible salvo que el modelo esté explícitamente en `free_models`.
- Excluir modelos pagos, modelos con precio ambiguo y proveedores con saldo insuficiente.

**T5B.2 — Estado de proveedor**

- Clasificar saldo insuficiente como bloqueo de proveedor sin reintentar el mismo proveedor.
- Detectar evidencia explícita de cuota compartida (`organization`, `project`, `account`, `TPM`, `ITPM`, `OTPM` o equivalente) y aplicar cooldown al proveedor completo.
- Mantener cuotas model-scoped como bloqueo del modelo; no convertir todo `429` en bloqueo global.
- Mantener estado global en memoria, acotado y fail-closed; no registrar secretos ni cuerpos completos.

**T5B.3 — Verificación**

- Añadir pruebas unitarias e integración con mocks para allowlist, saldo, cuota provider-scoped y cuota model-scoped.
- Revalidar Groq→Groq y Groq→Google solo como evidencia histórica ya obtenida; nuevos canaries serán gratuitos.
- Ejecutar suite, `node --check`, empaquetado offline y revisión de seguridad/documentación.

**Puerta 5B:** ningún destino pago o de precio desconocido entra en una cadena `free_only`; saldo insuficiente no se reintenta en el proveedor; una cuota compartida salta al siguiente proveedor gratuito; una cuota model-scoped puede probar otro modelo del mismo proveedor. **Estado:** aprobada en laboratorio: `tests/phase6-free-provider.test.mjs` 7/7, matriz E2E T0–T12, sintaxis, empaquetado offline e instalación local pasan.

La documentación oficial confirma que `retry` solo modifica la decisión antes de programar el siguiente intento, que `session.compact()` devuelve una admisión y no una finalización, que el stream de eventos debe abortarse en cleanup y que `compaction` es lossy. Por eso no se implementará una espera bloqueante dentro de `retry` que pueda deadlockear el paso actual. Fuentes: https://dev.opencode.ai/v2/docs/build/plugins/ y https://dev.opencode.ai/v2/docs/compaction/.

## Forma del producto

### Componente principal: plugin V2 de runtime

El plugin es el motor de ejecución porque necesita observar `retry` y `context`, consultar el inventario de modelos, validar el contexto disponible y solicitar `switchModel` o compaction cuando corresponda. La primera versión pública debe conservar el agente actual y relevar solamente el modelo/proveedor.

Contrato inicial del producto:

- Activación explícita mediante `enabled: true`; desactivado por defecto y fail-closed ante configuración inválida.
- Cadena explícita de referencias completas `providerID/modelID`.
- Sin cambio automático de agente en el MVP.
- Compaction solicitada por el plugin solo como opt-in (`compaction_enabled: true`), con evento terminal, estado durable `completed` y nueva medición; la configuración global `compaction.auto` de OpenCode es independiente.
- Sin solicitudes a proveedores reales durante el desarrollo del laboratorio.

### Componente opcional: skill de operación

El skill compañero servirá para explicar, validar y preparar la configuración del plugin. Podrá generar ejemplos de cadena, revisar límites/capacidades declarados, ejecutar diagnósticos locales y mostrar cómo activar, desactivar o revertir el plugin. No tendrá autoridad para implementar el fallback ni para sustituir los hooks del plugin.

### Distribución y compatibilidad

- Primera matriz soportada: OpenCode V2 instalado en el laboratorio, actualmente 2.1.3; ampliar versiones solo después de pruebas de contrato.
- Exponer el paquete mediante `exports` y probar tanto instalación por ruta local como paquete instalado, no únicamente el checkout del laboratorio.
- Mantener Node >=18 y cero dependencias de runtime mientras sea razonable.
- Mantener el paquete como prototipo privado hasta que las puertas de fallback, contexto y empaquetado estén aprobadas.
- Pasar las opciones del plugin bajo `plugins[].options`; documentar nombres, tipos, valores predeterminados y comportamiento fail-closed.

La documentación oficial distingue claramente plugins de skills: los plugins reciben el contexto de runtime y registran hooks, mientras que los skills son instrucciones reutilizables cargadas por el agente. Por eso no se tratarán como alternativas equivalentes.

## Evidencia oficial consultada

- [Plugins V2](https://dev.opencode.ai/v2/docs/build/plugins/): hooks de `retry`, `context` y `compaction`; `switchModel`, `switchAgent`, `session.context` y `session.compact`.
- [Compaction V2](https://dev.opencode.ai/v2/docs/compaction/): compactación automática, `keep.tokens`, `buffer`, ejecución en un punto seguro y carácter lossy del resumen.
- [Models V2](https://dev.opencode.ai/v2/docs/models/): `limit.context`, `limit.output`, capacidades y límites declarados para modelos personalizados.
- [Config V2](https://dev.opencode.ai/v2/docs/config/): configuración de agentes, permisos y compaction.
- [API V2](https://dev.opencode.ai/v2/docs/api): mensajes, uso de tokens, sesiones y rutas de compactación.

### Hallazgos actualizados de la documentación oficial

- El hook `context` se ejecuta inmediatamente antes de cada llamada del agente y expone `system`, `messages`, `tools` y `options`; debe ser la fuente del request que se estima, no `session.context()` por sí solo.
- `ctx.session.compact()` admite una operación en la bandeja de entrada y la ejecuta en un punto seguro; el `Promise` resuelto no confirma que el resumen haya terminado.
- El `id` idempotente de una compactación manual identifica la entrada de inbox (`inputID`) y su mensaje durable; la verificación del plugin debe exigir esa misma identidad antes de aceptar `completed`.
- La compactación se representa como estado `running`, `completed` o `failed`. El stream `ctx.event.subscribe()` es en vivo y puede perder eventos si el consumidor se desconecta o se atrasa; por eso el adaptador debe combinar señal de evento con una comprobación de estado o cerrar la transición si no puede confirmar.
- El 80% será un umbral de solicitud temprana (`estimated >= 0.80 * limit`), no una garantía de tamaño final. El resultado debe medirse nuevamente antes de aprobar el destino.
- `limit.context`, capacidades y límites de modelos personalizados son datos declarados por configuración y pueden ser incorrectos; `model.list()` no demuestra salud, credenciales ni compatibilidad real del endpoint.
- OpenCode separa la recuperación por overflow de la política normal de retry: no se debe tratar un overflow como un retry ordinario de la misma solicitud.

## Decisiones de arquitectura

1. **Separar fallback de modelo y relevo de agente.** El fallback de modelo conserva el agente y cambia el destino de las solicitudes siguientes. El relevo de agente se implementará después como una operación explícita entre pasos o como sesión hija, no como sustitución silenciosa durante una ejecución de herramienta.
2. **Usar la compactación nativa de OpenCode.** El plugin podrá solicitarla y observar su finalización con una señal verificable; nunca considerará suficiente la admisión de `compact()`, ni mantendrá un segundo resumidor paralelo.
3. **Cerrar de forma conservadora.** Si el límite del modelo destino, el uso estimado o la compatibilidad de herramientas/permisos son desconocidos, no se cambia de destino automáticamente.
4. **No envolver el ciclo de vida del hook.** El registro del hook y el callback deben conservar el contrato del runtime; la asincronía se limitará a logging y a operaciones explícitamente necesarias.
5. **Estado idempotente y acotado.** Cada fallo debe producir como máximo una transición de estado por `(sessionID, modelo, intento físico)`. No habrá colas ilimitadas ni reintentos propios fuera del límite de OpenCode.
6. **Observabilidad redactada.** Nunca se escriben credenciales, tokens, prompts completos, respuestas completas ni contenido privado.

## Salvaguardas obligatorias descubiertas en la revisión adversarial

- La identidad canónica de un destino es siempre `(providerID, modelID)`. Nunca se usará solo el nombre del modelo: dos providers pueden exponer el mismo `modelID` con límites, credenciales y estado diferentes.
- La cadena debe eliminar duplicados por referencia completa y mantener un conjunto de destinos visitados por solicitud. Se rechazará A→B→A y habrá un presupuesto global de transiciones por solicitud, independiente del límite de retry del runtime.
- `model.list()` valida inventario y configuración, no garantiza salud de red, credenciales válidas ni una respuesta útil. El primer retry al destino es la comprobación efectiva; si falla, se registra el destino como fallido y se continúa sin repetirlo.
- Un timeout después de respuesta parcial o después de una llamada de herramienta deja un resultado ambiguo. El fallback automático queda prohibido después de iniciar una herramienta o entregar salida parcial, salvo que el provider/runtime demuestre idempotencia mediante una clave o estado verificable.
- La transición de modelo y su estado deben coordinarse por sesión. Se permite serializar la transición `seleccionar → switchModel → confirmar estado`, pero nunca bloquear el registro del hook ni todo el ciclo de vida del plugin.
- La medición de contexto debe tener una sola definición: `requestEstimate = sistema + mensajes + herramientas + overhead`. La reserva de salida se compara por separado contra `limit.output`; no se sumará dos veces el overhead.
- La compactación nativa usa el modelo de la sesión. Si el provider actual está caído, no se asumirá que puede compactar; si el destino menor no cabe sin compactar, la política debe detenerse y conservar el error original.
- Todas las operaciones asíncronas críticas (`storage`, `model.list`, `switchModel`, `compact`) tienen espera acotada y decisión fail-closed; `AbortSignal` se usa donde la API lo admite y se documenta como cancelación best-effort, no como cancelación física garantizada.
- La privacidad se verifica con pruebas de headers, URLs, cuerpos de error, `cause`, stacks, tool inputs y eventos pendientes; la estimación de contexto nunca se escribe en logs junto con contenido del request.

## Plan por fases

### Fase 0 — Contrato y compatibilidad del runtime

**T0.1 — Congelar la matriz de compatibilidad**

- Registrar la versión real de OpenCode desde `ctx.app.version` y mantener una matriz explícita para la versión local.
- Capturar en mocks la forma real de `event.model`, `event.error`, `event.attempt` y `event.decision`.
- Verificar que `ctx.storage` recibe y devuelve valores JSON según el contrato V2, sin asumir cadenas serializadas.

**T0.2 — Crear un adaptador de runtime mínimo**

- Normalizar referencias de modelo (`id` y cualquier forma histórica observada) en un solo punto.
- Encapsular `hook`, `switchModel`, `model.list`, `session.context`, `session.compact` y `storage`.
- Desactivar el plugin si una capacidad imprescindible no existe o tiene una forma incompatible.
- Verificar capacidades por forma real antes de registrar hooks; no confiar solo en `ctx.app.version`.

**T0.3 — Corregir precondiciones de seguridad**

- Hacer que el valor por defecto de activación coincida con la documentación: desactivado salvo autorización explícita.
- Validar cadena de fallback, modelos duplicados, modelo inicial y opciones numéricas.

**T0.4 — Fijar el contrato del producto y del paquete**

- Definir el esquema mínimo de `plugins[].options`, incluyendo `enabled`, cadena de modelos, límites de transición, política de contexto y flags de diagnóstico.
- Mantener la activación explícita y hacer que opciones desconocidas o inválidas no habiliten comportamiento adicional.
- Añadir/confirmar `package.json.exports` para el entrypoint V2 y documentar la versión de OpenCode objetivo.
- Probar el paquete instalado en un proyecto aislado, además del import directo del checkout.
- Separar en la documentación el plugin ejecutable del futuro skill de configuración/diagnóstico.

**Puerta 0:** importación del plugin, registro del hook, cleanup y smoke test del paquete pasan; T0 permanece PASS; ningún proveedor externo.

### Fase 1 — Motor de decisión y estado

**T1.1 — Pruebas unitarias del motor puro**

- Clasificar 429/5xx/timeouts como recuperables según política.
- Clasificar 400/401/403/404 como permanentes salvo una regla explícita y justificada.
- Probar cadena agotada, cooldown, límite de intentos, recuperación del modelo original y entradas desconocidas.

**T1.2 — Conectar el estado real**

- Registrar el intento fallido exactamente una vez en la misma transición que autoriza el cambio.
- Persistir estado JSON versionado y acotado por sesión/modelo; eliminar entradas expiradas mediante política, sin borrar artefactos del laboratorio.
- Evitar que el almacenamiento persistente y el estado en memoria diverjan.

**T1.3 — Integración mínima de fallback**

- Ante un fallo recuperable: validar límite, seleccionar destino, cambiar modelo y permitir el retry del runtime.
- Ante un fallo permanente, contexto insuficiente o cambio fallido: veto explícito y error original preservado.
- El flujo debe probar A→B→C, destino duplicado, ciclo A→B→A y destino que desaparece entre inventario y `switchModel`.
- El fallback se prohíbe si hubo stream parcial o tool-call iniciado y no existe evidencia de idempotencia.

**Puerta 1:** T0, hook, T1 y T2 pasan; luego repetir T3–T11 en orden, únicamente con mocks locales.

### Fase 2 — Seguridad de contexto

**Orden obligatorio de implementación:** primero contrato y fixtures del hook `context`; después estimación; finalmente integración con `retry`. No se agregará compaction todavía.

**T2.1 — Fuente de verdad de límites**

- Leer `limit.context`, `limit.input` cuando exista, `limit.output` y capacidades del modelo desde el inventario de OpenCode.
- Rechazar o marcar como no confiable un límite ausente. Para modelos personalizados, exigir declaración administrativa correcta y probarla con un mock.

**T2.2 — Medición del contexto que realmente se enviará**

- Capturar el request ensamblado en el hook `context` por sesión y modelo: instrucciones, mensajes, herramientas, `options` y `event.kind`. No registrar el contenido capturado.
- Estimar tokens con una función versionada y conservadora; conservar también el uso reportado por el runtime cuando esté disponible.
- Incluir overhead de sistema/herramientas, reserva de salida y margen de seguridad.
- Reensamblar o volver a estimar para el destino cuando cambien tokenizer, prompt de sistema, herramientas, modalidad, formato estructurado o parámetros de salida.

Fórmula de decisión inicial:

```text
required = estimated_input + tool/system_overhead + output_reserve + safety_margin
allow = destination_input_or_context_limit >= required
```

No se compararán solamente los límites máximos de dos modelos. Un destino de 100 tokens no puede recibir un request que necesita 500 tokens, aunque la cadena lo declare como disponible.

**T2.3 — Matriz de límites**

- Actual 500 / destino 100: bloquear.
- Actual 80 / destino 100: bloquear o permitir solo si la reserva y el margen caben; nunca asumir que “100 >= 80” basta.
- Uso desconocido: bloquear por defecto.
- Contexto después de compactar: volver a medir; no reutilizar la medición anterior.
- Modelo con límite configurado pero proveedor real distinto: usar la configuración declarada como fuente administrativa y registrar la discrepancia, sin consultar proveedores reales en el laboratorio.

**Puerta 2:** todas las decisiones de contexto pasan la matriz y T0–T2 siguen estables.

**Estado de Puerta 2:** aprobada en laboratorio. `lib/context.js` mide las secciones del request sin conservar contenido, aplica el margen del 80% por defecto, reserva de salida y rechazo fail-closed para límites o mediciones desconocidos. Las pruebas unitarias cubren 500→100, umbral 80%, overflow y desconocidos; la integración cubre el bloqueo con modelos de 100 tokens; T0/T1/T2 con mocks loopback permanecen estables.

**Puerta de investigación local antes de Fase 3**

- Ejecutar un probe aislado contra la versión local para capturar la forma real de los eventos/estados de compaction y su transición `running → completed/failed`.
- Verificar si la versión local acepta `buffer`, `reserved` u otra clave de configuración; la documentación V2 consultada y la documentación general no son consistentes en este punto.
- Capturar la forma real del hook `context`, del stream de partes y de los estados de herramientas antes de escribir adaptadores que dependan de esos campos.
- Si la evidencia local no permite confirmar finalización, mantener compaction automática desactivada para el fallback y permitir únicamente destinos que ya quepan.

Esta puerta no requiere más investigación web: son propiedades del runtime instalado y deben verificarse con fixtures locales.

**Resultados del probe local:** OpenCode 2.1.3 cargó el plugin desde un directorio con `index.js` y rechazó una ruta a archivo `.mjs`. El hook `context` recibió `system`, `messages`, `tools`, `options`, `model` y `sessionID`. El stream entregó eventos `session.*` bajo `event.data`, incluyendo `session.step.streamed` y `session.text.delta`. La compaction emitió `session.compaction.started`, `session.compaction.delta` y, según el resultado, `session.compaction.ended` o `session.compaction.failed`; el mensaje durable confirmó `status: completed/failed`. `compaction.buffer` fue aceptado y `reserved` se normalizó a `buffer`. Estos resultados están en `INFORME_PROBE_RUNTIME_V2.md`.

El probe del tool-call ya confirmó eventos reales de inicio, ejecución, progreso, finalización y texto posterior. También mostró que una herramienta registrada por el plugin puede no aparecer automáticamente en `context.tools`; la política debe basarse en los eventos del runtime y permanecer fail-closed cuando el estado del side effect sea ambiguo.

### Fase 3 — Compactación controlada

**Precondición:** Puerta 2 aprobada y evidencia local de que la versión runtime ofrece una forma fiable de observar `running → completed/failed`. Si solo se puede observar la admisión o un stream volátil, el fallback queda restringido a destinos que ya quepan sin compactar.

**T3.1 — Umbral del 80% como disparador, no como garantía**

- Usar `0.80 * límite` como condición de solicitud temprana cuando la medición sea fiable.
- Configurar `buffer` con un valor absoluto equivalente al margen deseado para cada modelo; OpenCode no convierte mágicamente un porcentaje abstracto en seguridad para otro modelo.
- Mantener `auto` de OpenCode habilitado salvo una razón documentada.

**T3.2 — Ciclo de compactación**

1. Medir el request actual.
2. Si alcanza el umbral, solicitar `ctx.session.compact` con un ID idempotente.
3. Esperar `completed` o `failed`; la admisión de la solicitud no equivale a resumen terminado.
4. Reconciliar la señal de evento con el estado observable; si se pierde la señal, cerrar de forma conservadora.
5. Volver a medir el contexto.
6. Evaluar el modelo destino con la nueva medición.
7. Si sigue sin caber, no hacer fallback a ese destino.

La compactación no será una salida automática para un provider que acaba de fallar: OpenCode usa el modelo de la sesión para compactar. Si ese modelo no responde, el plugin solo podrá cambiar a un destino que ya quepa sin compactación o detenerse.

**T3.3 — Fallos y pérdidas**

- Probar historial corto, historial dominado por instrucciones/herramientas, compaction fallida y provider overflow.
- Documentar que la compactación es lossy; conservar un mínimo de información operacional: objetivo, decisiones, archivos, bloqueos y siguiente acción.

**Puerta 3:** compaction no rompe el hook, no ejecuta herramientas inesperadas durante el resumen y nunca habilita un destino que no cabe.

### Fase 4 — Relevo de agentes

**T4.1 — Definir semántica**

- `switchAgent` significa que las solicitudes posteriores usan otro agente; no significa que se reinterprete retroactivamente el historial.
- El MVP no cambia de agente en medio de una herramienta, stream parcial o sección crítica.

**T4.2 — Compatibilidad del agente**

- Comparar prompt, modelo, herramientas, permisos, capacidades de entrada y límite de contexto.
- Si el agente destino no puede usar una herramienta que el plan actual requiere, bloquear o crear una sesión hija explícita.

**T4.3 — Pruebas**

- Cambio de agente entre pasos completados.
- Cambio rechazado por menor contexto o permisos incompatibles.
- Interrupción/continuación sin duplicar herramientas ni prompts.

**Puerta 4:** relevo de agente probado como operación distinta del fallback de modelo y aprobado explícitamente antes de activarse. Para el MVP esta puerta queda cerrada por diseño: el plugin no activa `switchAgent()`.

El relevo de agentes no forma parte del Definition of Done del MVP de fallback de modelos. Tendrá su propia aprobación y contrato; la separación está documentada en ADR-002.

### Fase 5 — Concurrencia, streaming y regresiones

- Probar dos fallos concurrentes en la misma sesión y dos sesiones distintas.
- Mantener cualquier exclusión mutua limitada al estado de decisión; no rodear el registro ni todo el callback con un lock que pueda impedir que el hook se registre.
- Añadir guardas de streaming solo después de disponer de pruebas que demuestren el caso; no mezclarla con compaction ni con SessionLock.
- Instrumentar `ctx.event.subscribe()` y los estados de partes/tool antes de implementar el guard; la suscripción es live-only y su consumidor debe abortarse en cleanup.
- Invalidar cachés solo cuando exista evidencia de configuración/modelos stale.

**Puerta 5:** T0–T12 pasan con mocks, sin listeners remanentes, sin proveedores externos y con logs redactados.

### Fase 6 — Empaquetado, skill compañero y operación

- Añadir una suite `npm test` real: unitarias, contrato del runtime y harness de integración local.
- Confirmar el paquete publicable con `exports`, instalación por ruta local y prueba desde una copia instalada en un proyecto aislado.
- Documentar instalación local, activación explícita, versión compatible, límites declarados y rollback.
- Crear, como entregable separado y posterior a la estabilidad del plugin, `skills/opencode-fallback-setup/SKILL.md` con instrucciones de configuración, diagnóstico y reversión.
- El skill no deberá registrar hooks, realizar fallback por sí mismo ni habilitar proveedores reales.
- Añadir rotación/tamaño máximo de logs y prueba de fallo de escritura.
- Publicar primero como canary local; la prueba con proveedores reales requiere una autorización separada.

## Resultado de la ejecución actual

- La suite automatizada, el chequeo de sintaxis y el empaquetado offline pasan.
- El runner aislado `run-phase3-matrix-local.mjs` pasa T0–T12 end-to-end con
  OpenCode 2.1.3 y tres mocks loopback. T12 adicional prueba transporte sin
  respuesta HTTP y A→B.
- El resultado del MVP es **APROBADO para laboratorio/mock-only**.
- El relevo automático de agentes queda explícitamente fuera del MVP y requiere una fase separada.

## Definition of Done

- **MVP de fallback de modelo:** funciona con mocks y mantiene el contrato del hook.
- No se reintenta un error permanente ni se exceden límites propios o del runtime.
- Nunca se cambia a un modelo cuyo contexto disponible no cubre el request estimado más reservas.
- La compactación se solicita y verifica sin asumir que la admisión ya terminó.
- No hay ciclos de modelos, cambios concurrentes ambiguos ni fallback después de side effects parciales.
- El relevo de agente está separado y documentado, pero es un producto posterior con Definition of Done independiente.
- El plugin se puede instalar y desinstalar/revertir sin tocar la configuración global ni proyectos protegidos.
- El skill compañero, si se entrega, solo automatiza explicación/diagnóstico/configuración y no se confunde con el motor de runtime.
- Las pruebas automatizadas de contexto/seguridad pasan; T0–T12 end-to-end
  pasan con mocks y la configuración global/proyectos protegidos permanecen
  intactos.
- No hay credenciales ni contenido privado en logs.

## Riesgos principales

| Riesgo | Impacto | Mitigación |
|---|---:|---|
| Cambios de API entre versiones V2 | Alto | Adaptador, detección de capacidades y matriz por versión |
| `event.model` o límites con forma distinta a la esperada | Alto | Normalización y pruebas de contrato |
| Límite declarado incorrecto para modelo personalizado | Alto | Configuración explícita, fail-closed y prueba local |
| Compaction lossy o no finalizada antes del cambio | Alto | Esperar evento/estado y volver a medir |
| Herramienta no idempotente reejecutada | Alto | No fallback durante tool-call/stream parcial; pruebas específicas |
| Dos providers con el mismo modelID | Alto | Clave canónica `providerID/modelID` en cadena, estado y logs |
| Ciclo A→B→A u oscilación al original | Alto | Conjunto de visitados y presupuesto global por solicitud |
| Provider caído durante compaction | Alto | No compactar a través del provider caído; bloquear si destino menor no cabe |
| Carrera entre validación y switch | Alto | Revalidación al cambiar y transición serializada por sesión |
| Estado duplicado o concurrente | Medio/Alto | Transición idempotente por intento físico y lock de alcance mínimo |
| Logger o almacenamiento bloqueante | Medio | AsyncLogger acotado, cleanup verificable y almacenamiento JSON correcto |

## Preguntas que deben resolverse antes de implementación posterior

1. ¿El objetivo de producción inicial es solo relevo de modelos/proveedores, dejando agentes para una fase posterior? Recomendación: sí.
2. ¿Qué margen de salida y seguridad se debe reservar por modelo? Recomendación inicial: configuración por modelo, nunca un valor global ciego.
3. ¿Debe un contexto desconocido detener el fallback? Recomendación: sí, salvo una opción explícita de laboratorio.
4. ¿Se autorizará alguna vez una prueba con proveedores reales? No es necesario para completar el MVP de laboratorio; requeriría autorización independiente.
5. ¿La versión local de OpenCode 2.1.3 usa `buffer`, `reserved` u otra clave para la reserva de compaction? Debe resolverse con un probe local antes de exponer esa opción públicamente.
6. ¿Se quiere publicar primero como paquete npm, ruta local o ambos? Recomendación: probar ambos, pero mantener la publicación pública fuera del MVP.

## Fase 7 — Distribución portable y snapshot reproducible

### Objetivo

Permitir que un agente instale el plugin en el proyecto actual usando un
directorio fuente, manteniendo la activación explícita, el rollback reversible y
la configuración global intacta.

### Tareas

1. Entregar `README.txt`, `docs/IMPLEMENTATION.md` y un ejemplo de
   `opencode.jsonc`.
2. Entregar comandos slash bajo `commands/fallback/` y el skill pasivo ya
   separado del runtime.
3. Entregar instalador y validador sin dependencias, con merge manual si ya
   existe configuración.
4. Ignorar salidas generadas sin borrar logs, respaldos ni fixtures históricos.
5. Ejecutar pruebas, revisar el diff y crear un snapshot inicial en la rama
   `master`.

### Criterios de aceptación

- Una instalación nueva queda con `enabled: false`.
- Una configuración existente no se sobrescribe.
- El paquete incluye runtime, comandos, scripts, skill y documentación.
- `npm test`, sintaxis, empaquetado offline y pruebas del instalador pasan.
- El snapshot Git no incluye credenciales, `node_modules`, bases de datos,
  cachés ni logs generados.


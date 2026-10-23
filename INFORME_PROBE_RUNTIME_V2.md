# Informe de probe del runtime OpenCode V2

## Alcance

Probe ejecutado contra OpenCode `2.1.3` con configuración y datos XDG aislados, tres mocks HTTP en `127.0.0.1:9129-9131` y sin proveedores reales.

El probe fue un plugin separado de `index.js`. Solo registró metadatos estructurales: nombres de campos, cantidades, identificadores de sesión/modelo y estados. No registró prompts, respuestas completas, headers ni credenciales. Además se ejecutó un fixture separado de tool-call contra un mock loopback.

## Resultados

### Plugin local

- Una ruta local a un archivo `.mjs` fue rechazada por OpenCode 2.1.3: `configured plugin path must be a directory`.
- Una ruta local a un directorio con `index.js` fue cargada correctamente.
- Conclusión: el paquete del producto debe distribuirse como directorio/paquete con entrypoint, no como archivo suelto.

### Hook `context`

El hook se ejecutó antes de la llamada al modelo y recibió:

- `sessionID` y modelo canónico `mocka/m-a`.
- Claves `agent`, `messages`, `model`, `options`, `sessionID`, `system` y `tools`.
- En la sesión corta: 4 bloques de sistema, 1 mensaje, 12 herramientas y `options.maxTokens`.

Conclusión: el request real debe medirse desde este hook. `session.context()` no es suficiente para conocer herramientas, instrucciones y opciones que se enviarán en la llamada.

### Eventos y streaming

El stream `ctx.event.subscribe()` recibió eventos con forma superior `type` + `data`. Se observaron, entre otros:

- `session.execution.started` / `session.execution.succeeded`.
- `session.step.started` / `session.step.streamed` / `session.step.ended`.
- `session.text.started` / `session.text.delta` / `session.text.ended`.
- `session.usage.updated`.

El stream es suficiente para observar actividad y salida parcial, pero es volátil. El consumidor debe abortarse durante cleanup y no puede ser la única fuente de verdad si se requiere confirmar un estado durable.

En el fixture de tool-call se observó una ejecución real del `shell` integrado: `session.tool.input.started`, `session.tool.input.ended`, `session.tool.called`, `shell.created`, `shell.exited`, `session.tool.progress` y `session.tool.success`, seguida por `session.text.delta` y `session.execution.succeeded`. El mock envió un único tool-call y cerró con una respuesta final; no quedaron listeners después de la limpieza.

El registro del fixture también confirmó que `ctx.tool.list()` puede incluir una herramienta de plugin (`phase2_probe_tool`), pero esa herramienta no apareció en el conjunto `context.tools` usado por el agente en esta sesión. Por eso la protección de side effects no debe depender de asumir que una herramienta registrada queda automáticamente habilitada para el agente; se basará en los eventos reales del runtime.

### Compaction

La solicitud local `session.compact` con `delivery: "queue"` fue aceptada y devolvió una inbox compaction. Luego se observaron:

1. `hook-compaction` con el mismo modelo de la sesión.
2. `session.compaction.started`.
3. Varios `session.compaction.delta`.
4. En el fixture básico: `session.compaction.failed`.
5. En el fixture estructurado: `session.compaction.ended`.

La consulta durable de mensajes devolvió `status: "failed"` y el diagnóstico `Compaction summary did not match the required template`. El mock devolvía texto normal, no el resumen estructurado requerido por OpenCode.

Conclusiones:

- La admisión de compaction no equivale a finalización.
- El estado terminal se puede observar mediante eventos y mediante el mensaje durable.
- El adaptador debe aceptar solo `completed`; `failed`, timeout o pérdida de observabilidad deben bloquear la transición.
- El fixture estructurado produjo `session.compaction.ended` y el mensaje durable `status: "completed"`.

### Configuración de reserva

- `compaction.buffer: 16000` fue aceptado y materializado por OpenCode 2.1.3.
- Una configuración aislada con `compaction.reserved: 16000` fue normalizada por el runtime a `compaction.buffer: 16000`.

Conclusión: para el producto V2 se documentará `buffer`; se podrá aceptar `reserved` solo como compatibilidad legacy y se normalizará internamente.

### Distribución

- `package.json` expone `exports["."]` hacia `./index.js`.
- `npm pack --dry-run --ignore-scripts --offline` incluyó solamente `README.md`, `index.js`, `lib/` y `package.json`.
- El tarball se instaló en un proyecto aislado bajo `tests/fixtures/phase0-package-install/` y `import "opencode-fallback"` resolvió el export por defecto con `setup`.

### Guardia de contexto integrado

- `lib/context.js` estima `system`, `messages`, `tools` y `options.maxTokens` sin devolver ni registrar el contenido.
- El valor por defecto usa una reserva de seguridad del 20% (umbral 80%), suma la reserva de salida y bloquea mediciones desbordadas o límites desconocidos.
- El hook `retry` exige que el snapshot corresponda al modelo actual antes de permitir el cambio. Si falta o está stale, el comportamiento predeterminado es fail-closed.
- Las pruebas cubren explícitamente el caso de un request de 500 tokens frente a un destino de 100, el umbral 80%, desconocidos y overflow.
- T0 pasó con dos POST al Mock A y cero al B/C. T1 pasó con dos POST al A, uno al B y cero al C, devolviendo la respuesta de B. T2 local pasó sin POST a B/C; el comando terminó con el `400 Bad Request` esperado y el plugin no habilitó fallback.

## Artefactos

- Probe: `tests/fixtures/phase2-runtime-probe.mjs`.
- Entry point de directorio: `tests/fixtures/phase2-runtime-probe/index.js`.
- Configuración aislada: `tests/fixtures/phase2-probe-xdg/config/opencode/opencode.jsonc`.
- Eventos estructurales: `tests/fixtures/phase2-probe-xdg/probe-events.jsonl`.
- Logs de ejecución: `tests/fixtures/phase2-probe-xdg/logs/`.
- Fixture de tool-call: `tests/fixtures/phase2-tool-server.mjs` y `tests/fixtures/phase2-tool-xdg/`.
- Verificación de paquete instalado: `tests/fixtures/phase0-package-install/`.

## Clasificación

**APROBADO para la investigación local del runtime.** La forma del runtime, los ciclos `failed`/`completed` de compaction y un tool-call con stream parcial observable están confirmados. Esto no aprueba todavía la implementación productiva del fallback: siguen pendientes el adaptador de contexto, la política conservadora de cambio y las pruebas de regresión del plugin real.


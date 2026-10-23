# Fallback automático de modelos para OpenCode V2

Estado: MVP de laboratorio aprobado con OpenCode 2.1.3 y mocks loopback en
T0–T12. El cierre free-only no prueba modelos pagos ni agota cuotas, no cambia
agentes y permanece desactivado por defecto (`enabled: false`).

## Qué hace

El plugin conserva la misma sesión, agente, prompt, herramientas y permisos, y
puede cambiar al siguiente modelo configurado cuando el runtime observa un
429, un 5xx permitido, un timeout o un error de transporte sin respuesta HTTP.
El destino se valida mediante el intento real; no se hace un preflight de red.

No hace fallback para 400/401/403/404, salida parcial, stream ambiguo,
actividad de herramientas, contexto desconocido, destino insuficiente o
estado de runtime no observable. Las transiciones están limitadas, son por
sesión y modelo, y evitan ciclos y duplicados.

## Configuración segura

Añadirlo solo a la configuración del proyecto que se quiera probar:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/opencode-fallback",
      "options": {
        "enabled": false,
        "free_only": true,
        "free_models": [
          "ollama-local/llama3.1:8b",
          "google/gemini-3.5-flash-lite"
        ],
        "fallback_models": ["mocka/m-a", "mockb/m-b"],
        "retry_on_errors": [429, 500, 502, 503, 504],
        "max_attempts": 3,
        "max_transitions": 2,
        "cooldown_ms": 60000,
        "provider_cooldown_ms": 60000,
        "context_safety_ratio": 0.8,
        "require_context_check": true,
        "allow_unknown_context": false,
        "require_side_effect_guard": true,
        "compaction_enabled": false,
        "compaction_threshold_ratio": 0.8,
        "compaction_buffer_tokens": 0,
        "model_list_timeout_ms": 5000,
        "switch_model_timeout_ms": 5000,
        "storage_timeout_ms": 5000,
        "compaction_admission_timeout_ms": 5000,
        "compaction_status_timeout_ms": 5000,
        "max_log_bytes": 5242880,
        "debug": false
      }
    }
  ]
}
```

Las referencias deben ser completas (`providerID/modelID`). El margen 0.8 es
una reserva de seguridad, no una garantía exacta de tokenizer. La medición
considera `system`, `messages`, `tools` y la reserva de salida; un request de
500 tokens no se envía a un destino con capacidad efectiva de 100.

`free_only` es opcional y está desactivado por defecto para conservar la
compatibilidad de cadenas existentes. Cuando vale `true`, la cadena efectiva
debe tener una allowlist explícita en `free_models`; el plugin queda
desactivado de forma fail-closed si falta o queda vacía. Un destino fuera de
la allowlist no se intenta. Sin allowlist, solo se acepta un modelo cuyo
catálogo declara coste cero en entrada y salida; precio desconocido o positivo
se rechaza. La allowlist explícita también permite modelos locales cuyo
catálogo no publica precios. Esta puerta protege los destinos de fallback; el
modelo primario debe configurarse por separado como gratuito.

Los límites de proveedor se distinguen de los límites de modelo. Un saldo
insuficiente o una respuesta que menciona explícitamente organización,
proyecto, cuenta, TPM/ITPM/OTPM, RPD/TPD o gasto bloquea temporalmente todos
los modelos de ese proveedor durante el cooldown configurado. Un 429 genérico
sin esa evidencia solo bloquea el modelo afectado. El estado es acotado, vive
durante la instancia del plugin y no persiste bloqueos potencialmente
obsoletos entre reinicios. La clasificación es conservadora: no se infiere
una cuota global a partir de texto de autenticación.

`provider_cooldown_ms` permite separar el cooldown de una cuota compartida del
`cooldown_ms` de cada modelo. Si no se especifica y el cooldown de modelo vale
cero, se conserva un cooldown de proveedor de 60 segundos para que una cuota
explícita no se convierta en un reintento inmediato del mismo proveedor.

La compactación solicitada por este plugin es opt-in (`compaction_enabled`),
independiente de la compactación automática nativa de OpenCode. Al habilitarla,
el plugin solicita la compactación al alcanzar el umbral, espera un evento
terminal y un estado durable `completed`, vuelve a medir y solo entonces evalúa
el destino. La admisión de `compact()` no equivale a finalización. La
compactación nativa global se controla por separado con `compaction.auto` de
OpenCode. Si el runtime no ofrece `ctx.tool.transform`, la función de control
de sesión no se registra; el modo de configuración sigue funcionando, pero no
debe afirmarse compatibilidad completa con control interactivo.

Las operaciones auxiliares tienen un timeout acotado (por defecto, 5 segundos)
para `model.list`, storage, `switchModel`, admisión de compactación y lectura de
estado durable. `AbortSignal` se propaga a las APIs V2 que lo aceptan; esto es
cancelación best-effort y no una garantía de que el runtime detenga físicamente
una promesa que ignore la señal. Durante cleanup se abortan los controladores
pendientes. No se usa `session.interrupt()` automáticamente porque interrumpe
la ejecución completa de la sesión.

## Control por sesión

Cuando OpenCode expone `ctx.tool.transform`, el plugin registra
`model_fallback_control` con estas acciones:

- `enable`: activa fallback para la sesión actual.
- `disable`: lo desactiva para la sesión actual.
- `status`: devuelve estado, modelo activo, transiciones y modelos visitados.
- `reset`: borra el override y el estado durable de esa sesión.

El control no activa proveedores, no cambia agentes y no modifica la
configuración global.

## Relevo de agentes

El MVP no cambia agentes automáticamente. OpenCode expone `switchAgent`, pero
esa operación puede cambiar el system prompt, el modelo configurado, las
herramientas y los permisos. Por eso el fallback conserva el agente actual y
el futuro handoff se mantiene como una capacidad separada, con contrato y
pruebas propias. La decisión está en
`docs/decisions/ADR-002-agent-handoff-boundary.md`.

## Kit portable de integración

El proyecto incluye un kit para instalarlo en otro proyecto sin tocar la
configuración global:

- `README.txt`: instrucciones operativas para humanos y agentes.
- `docs/IMPLEMENTATION.md`: contrato de integración.
- `commands/fallback/`: comandos `/fallback/install`, `/fallback/enable`,
  `/fallback/disable`, `/fallback/status` y `/fallback/diagnose`.
- `scripts/install.mjs`: copia conservadora del runtime, comandos y skill.
- `scripts/validate-install.mjs`: validación de solo lectura.

El instalador no sobrescribe `opencode.json` ni `opencode.jsonc`; cuando ya
existe una configuración, exige un merge manual y deja `enabled: false` como
requisito de activación inicial.

## Instalación local

Desde un proyecto aislado se puede instalar la carpeta o el paquete local sin
registro:

```powershell
npm install --offline --ignore-scripts --no-audit --no-fund C:\ruta\opencode-fallback
```

El skill compañero está en `skills/opencode-fallback-setup/SKILL.md`. Solo
explica configuración, diagnóstico y rollback; no registra hooks ni ejecuta
fallback.

Para que OpenCode lo descubra en un proyecto de laboratorio, declarar también
el source de skills (o copiarlo a `.opencode/skills`):

```jsonc
{
  "skills": ["./plugins/opencode-fallback/skills"]
}
```

El skill tiene `opencode/autoinvoke: false`: se puede cargar explícitamente
como `@opencode-fallback-setup`, pero sigue siendo una guía pasiva y no activa
el plugin.

## Validación

```powershell
npm test
npm run test:e2e:local
node --check index.js
npm pack --dry-run --ignore-scripts --offline
```

El runner end-to-end usa únicamente `127.0.0.1` y tres mocks. Para ejecutar
escenarios concretos:

```powershell
$env:PHASE3_SCENARIOS = "T0,T1,T2,T8,T10"
npm run test:e2e:local
```

Los logs de diagnóstico se redactan, tienen cola acotada y límite de tamaño.
No se escriben credenciales, tokens, prompts completos, cuerpos privados ni
entradas completas de herramientas.

El procedimiento para una eventual prueba autorizada con proveedores reales
está en `tasks/CANARY_RUNBOOK.md`; la matriz de capacidades y puertas está en
`tasks/COMPATIBILITY_MATRIX.md`. Ninguno de esos documentos habilita tráfico
externo por sí mismo.

## Límites explícitos

- Compatible y validado localmente contra OpenCode 2.1.3. Antes de registrar
  hooks, el plugin comprueba las capacidades esenciales del runtime y queda
  desactivado de forma fail-closed si faltan; la API runtime V2 puede cambiar.
- La configuración administrativa de límites (`context`/`output`) debe ser
  correcta; que un modelo aparezca en `ctx.model.list()` no demuestra salud de
  red ni credenciales válidas.
- El fallback no es infalible: ante datos faltantes o señales ambiguas se
  detiene y conserva el error original.
- No hay relevo automático de agentes en este MVP.
- La compactación opt-in exige correlación durable por ID de operación; eventos
  de otra compactación no autorizan un cambio de modelo.
- Los canaries reales quedan restringidos a modelos gratuitos autorizados;
  saldo insuficiente descarta el proveedor y no se reintenta en el mismo
  proveedor. No se agotan cuotas deliberadamente ni se prueban modelos pagos.
- La clasificación de cuota depende de la evidencia entregada por el runtime;
  un proveedor que solo devuelve un 429 genérico puede requerir una decisión
  manual o una configuración de exclusión.

Fuentes oficiales: [plugins V2](https://dev.opencode.ai/v2/docs/build/plugins/),
[compaction](https://dev.opencode.ai/v2/docs/compaction/),
[skills](https://dev.opencode.ai/v2/docs/skills/) y
[models](https://dev.opencode.ai/v2/docs/models/).

# Informe final — Fase 14C.3.2 / cierre V2

**Proyecto:** `opencode-fallback`  
**Runtime probado:** OpenCode V2 `2.1.3`  
**Fecha:** 2026-10-23  
**Clasificación:** **APROBADO para laboratorio/mock-only**

## Resultado

El MVP de fallback automático de modelos quedó implementado y validado
end-to-end con mocks loopback en T0–T12. Mantiene la sesión, agente, prompt,
herramientas y permisos, y cambia únicamente el modelo cuando el fallo es
observable y el destino cabe de forma conservadora.

La aprobación no significa infalibilidad ni aprobación de producción. El
runtime no implementa relevo automático de agentes y la configuración base del
laboratorio conserva `enabled: false`. Los canaries reales previos se
conservan como evidencia separada; el cierre actual no prueba modelos pagos ni
agota cuotas.

## Cambios realizados

- `index.js`: contrato V2 `{ id, setup }`, AsyncLogger acotado, control de
  sesión `model_fallback_control`, clasificación de transporte observable,
  transición serializada por sesión, guardia de stream ambiguo y puerta de
  compatibilidad fail-closed antes de registrar hooks.
- `lib/activity.js`: tracker fail-closed para salida parcial, herramientas,
  stream desconocido y el orden real `context` antes de `session.step.started`.
- `tests/phase3-safety.test.mjs`: stream ambiguo, compaction stale,
  compaction completada pero insuficiente y demás salvaguardas.
- `tests/phase1-integration.test.mjs`: estado de intentos por sesión/modelo,
  dos sesiones concurrentes y dos fallos concurrentes en una sesión.
- `tests/phase4-session-control.test.mjs`: enable/disable/status/reset y
  ausencia segura de `ctx.tool.transform`.
- `tests/phase5-logger.test.mjs`: escritura, cola acotada y fallo de escritura.
- `lib/activity.js`, `index.js` y `tests/phase3-safety.test.mjs`: correlación
  de compactación por ID durable, timeouts acotados para inventario, storage,
  `switchModel`, compactación y contexto, y propagación best-effort de
  `AbortSignal`.
- `lib/policy.js`, `index.js` y `tests/phase6-free-provider.test.mjs`:
  allowlist free-only, rechazo de precios desconocidos/pagos, clasificación de
  saldo/cuotas por alcance y cooldown acotado por proveedor.
- `tests/fixtures/run-phase3-matrix-local.mjs`: harness E2E con XDG único por
  escenario, puertos locales dinámicos y limpieza de árboles de procesos.
- `xdg-iso/mocks/mock-flexible.js` y `mock-config.js`: fixtures locales para
  respuestas 400/401/429, contexto menor, stream truncado y transporte sin
  respuesta; se corrigió el header inválido `Retry-After: undefined` del mock.
- `package.json`: comandos `test:logger` y `test:e2e:local`.
- `README.md`, `CHANGELOG.md`, `tasks/plan.md`, `tasks/todo.md` y el skill
  compañero: documentación actualizada.
- `docs/decisions/ADR-001-free-only-provider-quota.md`: decisión de alcance
  gratuito y clasificación conservadora de cuotas.
- `opencode.jsonc` del laboratorio: apunta al plugin V2 actual y permanece
  desactivado por defecto; usa la forma V2 documentada `providers`/`package` y
  registra el source del skill compañero.

El hash histórico de `lib/policy.js` de la línea base se conserva para
comparación:

`92B74632C96676DF6A8F4C0C26B784968995ED2497065D53B7E8EADF9ADE81A9`

Como ampliación autorizada posterior, `lib/policy.js` ahora incorpora la
clasificación free-only/cuotas. Hash vigente:

`A35119E74F87B9927A024F2110F09B3C3873464D5A132341F4AEF45C8DCDBA8E`

La carpeta alternativa `plugins/opencode-model-fallback` se conservó como
referencia y no se activó ni se mezcló con el runtime.

## Matriz end-to-end

Comando:

```powershell
$env:PHASE3_SCENARIOS = "T0,T1,T2,T3,T4,T5,T6,T7,T8,T9,T10,T11,T12"
node tests/fixtures/run-phase3-matrix-local.mjs
```

Todos los escenarios pasaron. Los códigos no cero en errores rechazados son
esperados.

| Escenario | Resultado | POST A/B/C | Evidencia principal |
|---|---|---:|---|
| T0 | PASS | 2/0/0 | respuesta Mock A, hook y contexto |
| T1 | PASS | 2/1/0 | 429 y A→B |
| T2 | PASS | 2/0/0 | 400 permanente, sin cambio |
| T3 | PASS | 2/0/0 | 401 permanente, sin cambio |
| T4 | PASS | 2/1/1 | presupuesto de transiciones agotado |
| T5 | PASS | 2/0/0 | plugin desactivado |
| T6 | PASS | 2/0/0 | destino de contexto menor bloqueado |
| T7 | PASS | 2/1/0 | destino igual permitido |
| T8 | PASS | 2/0/0 | stream truncado/ambiguo bloqueado |
| T9 | PASS | 2/1/0 | modelo destino persistido como activo |
| T10 | PASS | 2/1/1 | A→B→C sin ciclo A→B→A |
| T11 | PASS | 2/0/0 | regresión de baseline |
| T12 | PASS | 2/1/0 | transporte sin respuesta HTTP, A→B |

Prueba adicional T12: transporte sin respuesta HTTP, A/B/C `2/1/0`, A→B,
PASS. Los logs y `run.json` se conservaron en
`C:\Users\Norbe\opencode-fallback-lab\xdg-iso\phase3-matrix\`.

## Suite y empaquetado

- `npm test`: PASS, 70 pruebas, incluyendo
  `tests/phase6-free-provider.test.mjs`; `tests/phase3-safety.test.mjs`: PASS,
  23/23.
- `tests/phase7-distribution.test.mjs`: PASS, instalación desactivada en
  proyecto vacío y preservación de configuración JSONC existente.
- `node --check index.js` y módulos `lib/*.js`: PASS.
- `npm pack --dry-run --ignore-scripts --offline`: PASS; paquete de 23
  archivos, con runtime, comandos, scripts, skill y documentación, sin
  dependencias runtime declaradas.
- `package-lock.json` mínimo generado offline y `npm audit --offline
  --omit=dev`: PASS, 0 vulnerabilidades; el lockfile no entra en el paquete
  por la lista `files`.
- Instalación desde ruta local en
  `tests/fixtures/phase6-package-install-v2`: PASS; importación del paquete
  instalado y contrato `{ id, setup }` confirmados.
- Control de sesión, AsyncLogger, redacción, concurrencia, contexto y
  compactación: PASS en la suite automatizada.

## Addendum — distribución portable

Se añadió un kit de integración por proyecto. `README.txt` contiene las
instrucciones operativas; `docs/IMPLEMENTATION.md` define el contrato; los
comandos `/fallback/install`, `/fallback/enable`, `/fallback/disable`,
`/fallback/status` y `/fallback/diagnose` sirven como interfaz para el agente.
`scripts/install.mjs` copia únicamente el runtime distribuible, comandos y
skill, crea una configuración nueva con `enabled: false` y no sobrescribe una
configuración existente. `scripts/validate-install.mjs` comprueba la
instalación en modo de solo lectura.

Las salidas generadas, caches, bases SQLite, `node_modules`, logs y respaldos
históricos permanecen en disco cuando ya existían, pero quedan excluidos del
snapshot limpio por `.gitignore`.

## Addendum — free-only y cuotas por proveedor

La ampliación de cierre implementa `free_only` y `free_models` de forma
fail-closed. Un destino fuera de la allowlist no se intenta; sin allowlist
explícita solo se acepta coste de catálogo conocido como cero; precio positivo
o desconocido se rechaza. La allowlist explícita permite modelos locales sin
precio publicado bajo responsabilidad del operador. La puerta se aplica a los
destinos de fallback; el modelo primario debe configurarse separadamente.

Los errores de saldo insuficiente y las cuotas con evidencia explícita de
organización/proyecto/cuenta o dimensiones TPM/ITPM/OTPM/RPD/TPD bloquean el
proveedor durante un cooldown acotado. Un 429 genérico permanece model-scoped;
texto de autenticación por sí solo no demuestra una cuota compartida.

Pruebas nuevas: 7/7 PASS para allowlist, precio pago/desconocido, saldo
insuficiente, cuota provider-scoped, cuota model-scoped, cooldown de proveedor
con cooldown de modelo cero y diagnóstico con `Authorization`. La matriz local T0–T12 volvió a pasar: T0 `2/0/0`, T1
`2/1/0`, T2 `2/0/0`, T3 `2/0/0`, T4 `2/1/1`, T5 `2/0/0`, T6 `2/0/0`, T7
`2/1/0`, T8 `2/0/0`, T9 `2/1/0`, T10 `2/1/1`, T11 `2/0/0`, T12 `2/1/0`.

La prueba activa aislada recargó el plugin con `free_only=true`, registró el
hook y capturó contexto usando Ollama en loopback. La CLI no produjo una
respuesta final tras el evento de uso y fue interrumpida de forma controlada;
esto queda como limitación de la prueba del modelo local, no como evidencia de
fallback ni como autorización para tráfico externo. No quedaron procesos
iniciados por esa prueba; los procesos OpenCode preexistentes no se tocaron.

El paquete offline incluyó los ADR y el skill (12 archivos, 28.1 kB), la
instalación desde ruta local confirmó `{ id, setup }` y `npm audit --offline
--omit=dev` informó cero vulnerabilidades.

## Prueba de entorno OpenCode activo

Se creó un proyecto aislado en
`C:\Users\Norbe\opencode-fallback-active-test` con el plugin habilitado, el
skill registrado explícitamente y un proveedor Ollama local en
`127.0.0.1:11434`. La prueba normal contra `ollama-local/llama3.1:8b` pasó y
los logs confirmaron `runtimeVersion=2.1.3`, `SESSION CONTROL registrado`,
`HOOK retry registrado`, `CONTEXT CAPTURE` y eventos `skill.updated`.

El primer intento detectó una configuración obsoleta que hacía caer el modelo
en el proveedor catalogado `ollama`; se corrigió dentro del laboratorio usando
`providers`, `package`, `settings.baseURL` y el ID aislado `ollama-local`. No se
realizó tráfico fuera de localhost. La invocación explícita del skill quedó
descubierta, aunque el modelo local produjo una respuesta larga no determinista
y el proceso se detuvo de forma controlada; esto no afectó al plugin ni a la
prueba de descubrimiento.

La prueba híbrida posterior pasó: Mock A local devolvió 429, el plugin hizo
`mocka/m-a → ollama-local/llama3.1:8b`, validó `CONTEXT FIT`, permitió el retry
y Ollama respondió `HYBRID_OLLAMA_OK`. No quedaron listeners de mocks ni
procesos de fixture.

## Salvaguardas confirmadas

- El 80% se usa como margen de seguridad, no como garantía exacta.
- Contexto desconocido, overflow o destino insuficiente bloquean.
- La compactación automática está desactivada por defecto; al activarse exige
  evento terminal, estado durable `completed` y una medición nueva.
- No hay fallback después de salida parcial, tool-call o transporte ambiguo
  posterior a HTTP 2xx.
- Los timeouts observables, incluido un 408 sin mensaje, siguen siendo
  elegibles; un timeout después de salida parcial permanece bloqueado.
- Intentos/cooldowns se aíslan por sesión y modelo; las transiciones se
  serializan solo dentro de la sesión.
- El logger tiene cola acotada, límite de archivo y redacción de credenciales,
  URLs sensibles, prompts, cuerpos y contenido privado.
- El runtime sin `ctx.tool.transform` conserva el modo de configuración e
  informa que no dispone de control interactivo.
- La compactación opt-in solo acepta una secuencia cuya `inputID` coincide con
  el ID idempotente solicitado por el plugin y cuyo mensaje durable conserva
  ese mismo ID y estado `completed`. Eventos de compactación automática,
  anteriores o fuera de orden no autorizan una transición.
- `model.list`, storage, `switchModel`, admisión de compactación y lectura de
  contexto tienen timeout; las APIs que lo permiten reciben `AbortSignal` y
  los controladores activos se abortan durante cleanup. Esto es best-effort:
  no se afirma cancelación física si el runtime ignora la señal.
- Si faltan capacidades esenciales (`session.hook`, `session.switchModel`,
  storage o metadatos de modelos cuando se exige la comprobación de contexto),
  el plugin queda desactivado antes de registrar hooks. Las APIs opcionales de
  eventos, control interactivo y compactación no se inventan: si faltan, se
  conserva el modo de configuración y se bloquean las decisiones ambiguas o la
  compactación que no pueda confirmarse.

## Seguridad y alcance

Las pruebas de cierre utilizaron únicamente `127.0.0.1`; no hubo solicitudes a
proveedores reales ni servicios externos en esta ampliación. No se tocaron la configuración global
de OpenCode, proyectos protegidos ni Git. El runner deja libres los puertos de
los mocks al finalizar. Se detectaron puertos de servidores OpenCode
preexistentes y no se alteraron.

Pendientes deliberados: ampliar los canaries reales a nuevos modelos y
versiones, y relevo automático de agentes (fase separada). La cancelación auxiliar quedó
cerrada con límites y señales best-effort; no se usa `session.interrupt()`
automáticamente porque detiene toda la sesión. La decisión de handoff está en
`docs/decisions/ADR-002-agent-handoff-boundary.md`. `compaction_enabled` del
plugin es independiente de la configuración global `compaction.auto` de
OpenCode.

## Addendum — candidatos locales y configuración gratuita curada

Se comprobó el inventario de Ollama en `127.0.0.1:11434` mediante `/api/tags`,
`/v1/models` y generación nativa con un límite de 20 segundos. El resultado no
se interpreta como una garantía de rendimiento sostenido: solo demuestra que el
endpoint respondió en la prueba aislada.

| Candidato local | Endpoint directo | Herramientas | Decisión |
|---|---:|---:|---|
| `llama3.1:8b` / `latest` | PASS | Sí | Activo |
| `qwen2.5:7b` / `latest` | PASS | Sí | Activo |
| `qwen2.5-coder:7b` | PASS | Sí | Activo |
| `qwen2.5-coder:7b-cpu` | PASS, más lento | Sí | Fuera de la cadena principal |
| `qwen2.5-coder:1.5b-base` | PASS de endpoint | No | Excluido: no sirve para el flujo con herramientas |
| `gemma2:latest` | PASS de endpoint | No | Excluido: no sirve para el flujo con herramientas |
| `qwen3.8:27b` / `27b-cpu` | Timeout a 20 s | Sí según Ollama | Excluidos: no demostraron salud operativa en el límite de prueba |
| `nomic-embed-text:latest` | Embedding solamente | No | Excluido: no es modelo de chat |

La cadena activa del laboratorio quedó en `C:\Users\Norbe\opencode-fallback-lab\opencode.jsonc`,
con `enabled: false` y `free_only: true`:

1. `ollama-local/qwen2.5-coder:7b`
2. `ollama-local/qwen2.5:7b`
3. `ollama-local/llama3.1:8b`
4. `opencode/big-pickle`
5. `opencode/glm-5.3-flash-free`
6. `openrouter/cohere/north-mini-code:free`
7. `nvidia/openai/gpt-oss-20b`
8. `nvidia/z-ai/glm-5.3`

Los destinos remotos de la cadena tuvieron respuesta PASS en canaries aislados.
También pasaron otros modelos gratuitos de OpenCode, OpenRouter y Nvidia, pero
no se añadieron todos para evitar una cadena larga, redundante o dependiente de
un router aleatorio. `openrouter/openrouter/free` se conserva como opción
manual de emergencia; no es destino principal porque selecciona el backend de
forma dinámica y el plan gratuito tiene límites diarios.

Se descartaron de la cadena automática los modelos que respondieron con 429 por
cuota compartida, 404 por endpoint incompatible, 402 por saldo/crédito
insuficiente, o que no admitieron herramientas. La presencia de una credencial
en `opencode auth list` no se tomó como prueba de salud ni de gratuidad.

La investigación de nuevos proveedores encontró una opción adicional razonable:
Cerebras ofrece un nivel gratuito con clave y límites propios, pero no hay una
credencial Cerebras conectada en este entorno; por eso no se inventó una entrada
inoperable. Mistral ofrece un modo gratuito limitado, pero su catálogo publicado
por OpenCode no figura como coste cero para los modelos evaluados; queda fuera
de `free_only`. Cloudflare conserva una asignación gratuita, aunque la ruta/modelo
probado devolvió 404 y no es una incorporación segura. GitHub Models no se
añade porque su servicio fue retirado.

La configuración global de OpenCode no fue modificada. En particular, su límite
de `qwen2.5:7b` es más conservador/desactualizado que el límite observado en
Ollama; el laboratorio lo sobreescribe localmente con 32768 tokens. No se
eliminaron archivos GGUF, datos de Ollama, credenciales ni respaldos; “borrar”
se aplicó únicamente a la cadena activa de candidatos no aptos.

## Addendum — Fase 8, MVP público reproducible

La versión pública preparada es `0.3.0`. Se eliminó la marca privada del
paquete, se añadieron metadata del repositorio, licencia MIT, `SECURITY.md`,
`CONTRIBUTING.md`, workflow de CI y un validador de release. El paquete no tiene
dependencias runtime y conserva el contrato V2 `{ id, setup }`.

Pruebas adicionales:

- `tests/phase8-release.test.mjs`: 3/3; metadata pública, licencia, contenido
  limpio del tarball, instalación offline desde el tarball y ejecución del
  instalador portable.
- `tests/phase7-distribution.test.mjs`: 4/4; instalación nueva, preservación
  de configuración existente, preflight contra copias parciales y rechazo de
  destinos dentro del origen.
- `npm ci --ignore-scripts --offline`: PASS.
- `npm audit --offline --omit=dev --audit-level=high`: 0 vulnerabilidades.
- `node --check` para los módulos JavaScript: PASS.
- `npm pack --dry-run --ignore-scripts --offline`: PASS; tarball `0.3.0`, sin
  tests, logs, cachés, bases de datos, respaldos ni credenciales.
- `npm test`: PASS, 82 pruebas.
- `npm run test:e2e:local` más `PHASE3_SCENARIOS=T12 npm run test:e2e:local`:
  PASS, T0–T12 con mocks loopback; T0 `2/0/0`, T1
  `2/1/0`, T2/T3 `2/0/0`, T4 `2/1/1`, T5 `2/0/0`, T6 `2/0/0`, T7 `2/1/0`,
  T8 `2/0/0`, T9 `2/1/0`, T10 `2/1/1`, T11 `2/0/0`, T12 `2/1/0`.

El instalador ahora hace preflight de los archivos que administra antes de
copiar. Si detecta una instalación previa, no sobrescribe ni deja una copia
parcial; si el destino está dentro del origen, rechaza la operación mediante
una comparación estructural de rutas. La configuración existente sigue siendo
intocable y una configuración nueva queda con `enabled: false`.

La release fue publicada en
`https://github.com/facishola/relevo-opencode`. La auditoría del historial y del árbol
de trabajo no encontró coincidencias con claves, tokens, cabeceras Bearer ni
llaves privadas; el detalle reproducible está en
`INFORME_AUDITORIA_PUBLICACION_0.3.0.md`. No se incluyeron credenciales ni
modelos de proveedores en el paquete.

### Revisión final de calidad

Se revisaron corrección, legibilidad, arquitectura, seguridad y rendimiento del
diff de release. No quedaron hallazgos críticos ni requeridos. La compatibilidad
sigue acotada a OpenCode V2 2.1.3; versiones posteriores deben repetir la
matriz.

## Addendum — cierre local de `0.3.0`

La implementación de descubrimiento automático estricto quedó integrada en
`lib/discovery.js` y el runtime consulta `ctx.model.list()` solamente cuando
necesita relevar. Se normalizan costes como objeto o colección de niveles y se
rechazan destinos pagos, de precio desconocido, disabled/deprecated, sin
límites o capacidades compatibles. La allowlist `free_models` es la única
excepción para precio local desconocido; no permite omitir límites ni
capacidades desconocidos.

La verificación final ejecutada el 23-10-2026 fue:

- `npm test`: PASS, 82 pruebas.
- `npm run test:e2e:local`: PASS, T0–T11; únicamente tráfico loopback,
  incluyendo T0 `2/0/0`, T1 `2/1/0`, T4 `2/1/1`, T7 `2/1/0`, T10 `2/1/1`.
- `PHASE3_SCENARIOS=T12 npm run test:e2e:local`: PASS, `2/1/0`, transporte
  sin respuesta HTTP y relevo A→B.
- `node scripts/validate-package.mjs`: PASS.
- `node --check` sobre los módulos JavaScript: PASS.
- `npm pack --dry-run --ignore-scripts --offline`: PASS; el paquete contiene
  27 archivos distribuibles y no contiene tests, logs, caches ni respaldos.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilidades.
- Puertos de mocks y servidores (`9129`, `9130`, `9131`, `28900`, `28901`):
  sin listeners remanentes.

Clasificación final: **APROBADO para el MVP público mock-only y portable**. La
publicación y el clone limpio quedaron verificados; esto no convierte el
comportamiento en infalible ni sustituye canaries opcionales con proveedores
reales.

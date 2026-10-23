# Runbook de canary controlado

Estado: preparado, no ejecutado. El laboratorio actual solo autoriza mocks
loopback; no se ha habilitado tráfico hacia proveedores reales.

## Propósito

Validar el plugin en un proyecto aislado de OpenCode con una cadena explícita
de modelos reales, manteniendo el mismo agente, prompt, herramientas y
permisos. El canary verifica que el destino alternativo responda mediante el
intento real del runtime; no convierte `model.list()` en una prueba de salud.

## Requisitos de entrada

Antes de ejecutar un canary deben quedar escritos, para esta ejecución:

- versión exacta de OpenCode;
- `providerID/modelID` del modelo primario y de cada destino;
- límites administrativos de contexto y salida de cada modelo;
- fuente de credenciales y propietario de la autorización;
- endpoints o dominios permitidos, presupuesto y duración máxima;
- proyecto aislado y ruta de logs de diagnóstico.

Si falta cualquiera de estos datos, el canary se mantiene bloqueado. No se
deben inferir modelos, credenciales, permisos de red ni límites a partir de la
existencia del catálogo.

## Preparación

1. Ejecutar `npm test`, `npm run test:e2e:local`, `node --check index.js` y
   `npm pack --dry-run --ignore-scripts --offline`.
2. Confirmar que la configuración global, los proyectos protegidos y
   `lib/policy.js` no cambiaron. El hash validado de `lib/policy.js` es
   `92B74632C96676DF6A8F4C0C26B784968995ED2497065D53B7E8EADF9ADE81A9`.
3. Crear un proyecto de prueba separado. Activar el plugin únicamente allí,
   con `enabled: true`, `debug: false`, `require_context_check: true`,
   `allow_unknown_context: false`, `require_side_effect_guard: true` y
   `compaction_enabled: false` en el primer canary.
4. Usar `max_transitions: 1` y una cadena de dos destinos durante la primera
   ejecución. Aumentar el presupuesto requiere una nueva revisión.
5. Capturar contadores del proveedor y del runtime antes de iniciar. No
   introducir prompts, herramientas o datos privados que no sean necesarios.

## Secuencia

1. Ejecutar una solicitud normal y confirmar el modelo activo.
2. Confirmar que la respuesta llega sin cambiar de modelo cuando no hay fallo.
3. Si existe una forma segura y autorizada de producir un fallo recuperable,
   observar un único cambio primario → destino. No provocar errores mediante
   credenciales inválidas, datos sensibles ni acciones irreversibles.
4. Confirmar que el destino responde y que el siguiente intento conserva el
   mismo agente, prompt, herramientas y permisos.
5. Confirmar que no se hace fallback después de salida parcial, herramienta
   iniciada, stream ambiguo, contexto desconocido o destino insuficiente.
6. Revisar logs redactados, contadores y endpoints observados.
7. Desactivar el plugin al terminar y repetir una solicitud corta para
   confirmar que no quedan hooks o comportamiento residual.

## Compactación

La primera ejecución debe usar `compaction_enabled: false`. La compactación
del plugin solo se puede evaluar en una segunda ejecución explícita, con un
fixture de contexto no sensible y un límite de salida conocido. El umbral de
80% es un margen de seguridad, no una garantía de tokenizer.

Solo se considera válida si el runtime confirma un evento terminal y un
estado durable `completed`, y la medición posterior demuestra que el destino
admite el request. La admisión de `session.compact()` por sí sola no alcanza.
Si la confirmación es stale, falla o no existe, el plugin debe conservar el
error y bloquear la transición.

## Criterios de detención inmediata

- aparece tráfico fuera de los endpoints autorizados;
- se registra un token, credencial, prompt o contenido privado;
- el runtime entrega salida parcial o inicia una herramienta antes del cambio;
- el destino no tiene límite de contexto/salida verificable;
- el cambio de modelo falla o el modelo activo no coincide con lo esperado;
- una compactación queda en `running`, `failed`, stale o sin estado durable;
- se observa cualquier regresión en la solicitud normal;
- quedan listeners, procesos o hooks después de desactivar el plugin.

## Evidencia y rollback

Conservar el informe, logs redactados, versión del runtime, configuración del
proyecto, modelo activo, contadores y destinos observados. Para hacer rollback,
establecer `enabled: false` o retirar el plugin solamente del proyecto aislado;
no modificar la configuración global. No borrar evidencias ni respaldos.

Este runbook no autoriza por sí mismo el canary ni el relevo automático de
agentes. El relevo de agente requiere un contrato separado porque puede cambiar
prompt, herramientas y permisos.

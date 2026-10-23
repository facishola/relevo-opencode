# ADR-002 — El relevo automático de agentes queda fuera del MVP

**Estado:** Aceptada para el cierre del MVP de fallback de modelos  
**Fecha:** 2026-10-23

## Contexto

El producto debe relevar modelos o proveedores cuando un fallo observable lo
permite, conservando la sesión, el agente, el prompt, las herramientas y los
permisos. OpenCode V2 expone `ctx.session.switchAgent()` y APIs de lectura de
agentes, pero un cambio de agente modifica las solicitudes posteriores y puede
cambiar el system prompt, el modelo configurado, las herramientas y las reglas
de permisos. El hook `retry` ocurre dentro del ciclo de una ejecución que acaba
de fallar; no constituye por sí mismo una frontera `idle` segura.

La documentación oficial también confirma que `session.compact()` solo admite
una operación y que su resultado debe seguirse por eventos/estado durable; no
es una señal para cambiar de agente. Véanse [plugins V2](https://dev.opencode.ai/v2/docs/build/plugins/),
[agentes](https://dev.opencode.ai/v2/docs/agents/) y
[compactación](https://dev.opencode.ai/v2/docs/compaction/).

## Decisión

1. El plugin V2 no invoca `switchAgent()` automáticamente desde `retry` ni
   desde el fallback de modelos.
2. El estado del MVP solo registra modelos, intentos, cooldowns y transiciones
   de modelo. No inventa compatibilidad de agentes, herramientas o permisos.
3. Un futuro handoff de agentes será una capacidad separada, explícita y
   opt-in. Solo podrá cambiar entre fronteras confirmadas de sesión/step y
   deberá validar, como mínimo, identidad del agente, modo primary/subagent,
   modelo, contexto, herramientas, permisos, estado de side effects,
   concurrencia, presupuesto de transiciones y trazabilidad.
4. Si el runtime no ofrece una frontera durable y observable, el futuro
   handoff debe bloquearse. No se usará `session.interrupt()` como sustituto:
   esa API interrumpe la ejecución completa de la sesión.

## Consecuencias

- El fallback de modelos conserva su contrato y no cambia silenciosamente la
  semántica del agente.
- El MVP queda aprobado para fallback de modelos en laboratorio/mock-only,
  pero no afirma relevo automático de agentes.
- La implementación posterior necesitará pruebas propias de compatibilidad,
  concurrencia, herramientas, permisos, sesiones hijas y recuperación.

## Cancelación auxiliar

Las operaciones auxiliares de inventario de modelos, storage, compactación,
lectura de contexto y `switchModel` tienen espera acotada. Cuando la API lo
permite, reciben `AbortSignal`; la propagación es best-effort y no se presenta
como cancelación física garantizada por el runtime. Los controladores activos se
abortan durante cleanup. La sesión completa no se interrumpe automáticamente.


# ADR-003: Distribución portable por proyecto con comandos y skill

## Estado

Aceptada

## Contexto

El runtime necesita hooks de OpenCode y no puede ser reemplazado por un skill.
Al mismo tiempo, la instalación debe poder solicitarse desde otro proyecto sin
modificar la configuración global ni activar el fallback accidentalmente.

## Decisión

Entregar el runtime como plugin local bajo `vendor/opencode-fallback`, copiar los
comandos operativos a `.opencode/commands/fallback`, copiar el skill pasivo a
`.opencode/skills/opencode-fallback-setup` y configurar el plugin con
`enabled: false`.

El instalador será conservador: copiará solo archivos de distribución, no
sobrescribirá una configuración existente y exigirá un merge manual cuando el
proyecto ya tenga `opencode.json` o `opencode.jsonc`.

La interfaz de usuario será:

- `/fallback/install` para instalar;
- `/fallback/status` y `/fallback/diagnose` para inspeccionar;
- `/fallback/enable` y `/fallback/disable` para modificar la activación.

## Alternativas consideradas

### Instalación global

Rechazada como opción predeterminada porque podría afectar proyectos no
relacionados y ocultar el origen del hook.

### Skill como motor de fallback

Rechazada: un skill proporciona instrucciones al agente y no registra hooks de
runtime ni controla `retry`.

### Sobrescribir automáticamente la configuración del proyecto

Rechazada: un JSONC existente puede contener comentarios, opciones y plugins
que no pertenecen a este proyecto. El merge debe ser visible y reversible.

## Consecuencias

- La integración es portable y auditable por proyecto.
- La activación requiere intención explícita y reinicio controlado.
- Se necesita un merge manual cuando el proyecto ya tiene configuración.
- Los comandos slash son una interfaz de operación; el plugin sigue siendo el
  único componente que ejecuta fallback.


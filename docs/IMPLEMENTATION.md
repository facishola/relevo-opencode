# Implementación en un proyecto OpenCode

## Objetivo

Instalar el plugin de fallback como componente local del proyecto, con
activación explícita y rollback reversible. El plugin cambia modelos; no cambia
agentes automáticamente.

## Instalación recomendada

Desde el proyecto destino, ejecutar el comando slash si ya se copiaron los
comandos:

```text
/fallback/install C:\ruta\al\opencode-fallback
```

Como alternativa determinista:

```powershell
node C:\ruta\al\opencode-fallback\scripts\install.mjs `
  --source C:\ruta\al\opencode-fallback `
  --target C:\ruta\al\proyecto
```

El instalador copia el runtime a `vendor/opencode-fallback`, los comandos a
`.opencode/commands/fallback` y el skill a
`.opencode/skills/opencode-fallback-setup`. Si ya existe una configuración de
OpenCode, no la sobrescribe: informa que hace falta un merge manual.

## Configuración inicial

La configuración segura es:

```jsonc
{
  "plugins": [
    {
      "package": "./vendor/opencode-fallback",
      "options": {
        "enabled": false,
        "free_only": true,
        "compaction_enabled": false
      }
    }
  ],
  "skills": ["./.opencode/skills"]
}
```

Antes de activar, completar `free_models` y `fallback_models` con referencias
completas `providerID/modelID`, declarar los límites `context` y `output` y
comprobar que los destinos realmente sean gratuitos.

## Operación

```text
/fallback/status
/fallback/diagnose
/fallback/enable
/fallback/disable
```

La instalación y el diagnóstico no contactan proveedores. La primera prueba
debe usar mocks loopback u Ollama local. Después de cambiar `enabled`, reiniciar
OpenCode para garantizar que los hooks se registren o se liberen correctamente.

## Rollback

Ejecutar `/fallback/disable`, verificar `enabled: false` y reiniciar OpenCode.
No borrar logs, respaldos ni resultados de pruebas durante el rollback.

## Límites

- El fallback es fail-closed y no es infalible.
- No cambia agentes, prompt, herramientas ni permisos.
- No reintenta después de salida parcial o ejecución de herramientas.
- La compactación solicitada por el plugin permanece desactivada por defecto.
- La prueba real de proveedores requiere autorización separada.


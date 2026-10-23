---
description: Instalar opencode-fallback de forma aislada y desactivada
---

Integra `opencode-fallback` en el proyecto actual usando como origen el
directorio indicado por `$ARGUMENTS`.

Reglas obligatorias:

1. Trata `$ARGUMENTS` como un directorio local de confianza solo después de
   comprobar que contiene `index.js`, `package.json` y `lib/`.
2. Ejecuta el instalador determinista:
   `node "$ARGUMENTS/scripts/install.mjs" --source "$ARGUMENTS" --target "."`.
3. No toques la configuración global de OpenCode, otros proyectos, agentes,
   permisos ni proveedores reales.
4. Si ya existe `opencode.json` o `opencode.jsonc`, no lo sobrescribas:
   inspecciónalo, propone el diff mínimo y deja el plugin con `enabled: false`.
5. Conserva respaldos y logs existentes.
6. Ejecuta el validador después de instalar y reporta los archivos cambiados,
   las pruebas ejecutadas y cualquier paso manual pendiente.

La instalación no habilita fallback automáticamente. La activación requiere
`/fallback/enable` y un reinicio controlado de OpenCode.


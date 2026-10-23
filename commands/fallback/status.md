---
description: Diagnosticar instalación y estado del fallback
---

Inspecciona solo el proyecto actual y ejecuta:

```text
node "<ruta-del-plugin>/scripts/validate-install.mjs" --target "."
```

Reporta por separado configuración, plugin, skill, comandos, versión de
OpenCode, `enabled`, `free_only`, cadena de modelos y limitaciones. No cambies
archivos ni hagas solicitudes a proveedores.


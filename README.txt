OPENCODE-FALLBACK — GUÍA DE USO
================================

Este proyecto contiene el MVP público 0.3.0 de un plugin V2 para relevar automáticamente el modelo
actual por otro modelo permitido cuando OpenCode observa un fallo recuperable.

El plugin conserva la sesión, el agente, el prompt, las herramientas y los
permisos. No realiza relevo automático de agentes. Si faltan datos, el contexto
no cabe o la ejecución es ambigua, se detiene de forma conservadora.

REQUISITOS
----------

- OpenCode V2; validado en laboratorio con OpenCode 2.1.3.
- Node.js >= 18 para el instalador y las pruebas.
- Un proyecto aislado para la primera instalación.
- Modelos con referencias completas: providerID/modelID.

DESCARGA DESDE GITHUB
---------------------

git clone https://github.com/facishola/relevo-opencode.git
node relevo-opencode/scripts/install.mjs --source relevo-opencode --target .

También se puede descargar el ZIP del repositorio y usar la carpeta extraída
como --source. El instalador es local, no necesita credenciales y deja el
plugin desactivado. Si ya existe opencode.json o opencode.jsonc, no lo
sobrescribe: informa que hay que hacer un merge manual.

INSTALACIÓN EN OTRO PROYECTO
----------------------------

1. Abrir OpenCode desde el proyecto destino.
2. Entregar al agente el directorio de este proyecto y solicitar:

   Implementa opencode-fallback usando las instrucciones de
   docs/IMPLEMENTATION.md y deja enabled=false.

3. Si los comandos ya están disponibles, usar:

   /fallback/install C:\ruta\a\plugins\opencode-fallback

4. Para una instalación determinista desde PowerShell:

   node C:\ruta\a\opencode-fallback\scripts\install.mjs --source C:\ruta\a\opencode-fallback --target C:\ruta\al\proyecto

Validar después de instalar:

   node C:\ruta\a\opencode-fallback\scripts\validate-install.mjs --target C:\ruta\al\proyecto

El instalador copia el runtime a vendor/opencode-fallback, los comandos a
.opencode/commands/fallback y el skill a .opencode/skills. Si el proyecto ya
tiene opencode.jsonc, no lo sobrescribe: el agente debe hacer un merge mínimo.

CONFIGURACIÓN SEGURA
--------------------

La primera configuración debe mantener:

   enabled: false
   free_only: true
   auto_discover_free_models: true
   fallback_models: []
   free_models: []
   compaction_enabled: false

No hace falta conocer de antemano los modelos gratuitos: el plugin consulta el
catálogo de OpenCode y acepta únicamente candidatos con coste cero verificable,
límites conocidos y capacidades compatibles. Los modelos locales sin precio
publicado deben declararse en free_models. No se modifica la configuración
global de OpenCode.

ACTIVAR Y DESACTIVAR
--------------------

   /fallback/status
   /fallback/diagnose
   /fallback/enable
   /fallback/disable

Después de enable o disable, reiniciar OpenCode para que el ciclo de vida del
plugin quede limpio. La herramienta de sesión model_fallback_control permite,
cuando el runtime la expone, usar enable, disable, status y reset para la sesión
actual.

PRUEBAS RECOMENDADAS
--------------------

Primero ejecutar solo mocks loopback u Ollama local. No comenzar con
proveedores reales ni modelos pagos.

Desde este proyecto:

   npm test
   npm run test:e2e:local
   node scripts/validate-package.mjs
   node --check index.js
   npm pack --dry-run --ignore-scripts --offline

El fallback esperado es A -> B únicamente ante 429, 5xx permitido, timeout o
error de transporte sin respuesta parcial. Un 400, contexto insuficiente,
salida parcial, tool-call o estado desconocido debe detener el cambio.

ROLLBACK
--------

Usar /fallback/disable, confirmar enabled=false y reiniciar OpenCode. No borrar
logs, respaldos ni artefactos históricos.

ARCHIVOS IMPORTANTES
--------------------

- README.md: referencia técnica.
- docs/IMPLEMENTATION.md: integración detallada.
- skills/opencode-fallback-setup/SKILL.md: skill pasivo de configuración.
- commands/fallback/: comandos slash.
- tasks/COMPATIBILITY_MATRIX.md: compatibilidad y límites.
- INFORME_FASE14C3_2_FINAL.md: evidencia del MVP de laboratorio.

ESTADO
------

El resultado es un MVP público compatible con OpenCode 2.1.3, no una garantía
de producción ni de infalibilidad. Cambios de versión de OpenCode requieren
repetir la matriz local antes de activar el plugin.


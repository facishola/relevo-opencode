# ADR-001: free-only y alcance de cuotas por proveedor

- Estado: aceptada para el MVP de laboratorio
- Fecha: 2026-10-23
- Alcance: `opencode-fallback` V2

## Contexto

El fallback debe operar con modelos gratuitos y evitar que un límite o saldo
agotado de un proveedor consuma intentos inútiles en otros modelos del mismo
proveedor. El catálogo de modelos describe precio y límites administrativos,
pero no demuestra que un endpoint esté sano ni revela siempre el alcance real
de una cuota. Un 429 genérico tampoco permite inferir de forma segura que toda
la cuenta está bloqueada.

## Decisión

1. `free_only: true` requiere una cadena efectiva no vacía y una allowlist
   explícita en `free_models`. Un destino fuera de la allowlist nunca se
   selecciona.
2. Si no hay allowlist explícita para un destino, solo se acepta catálogo con
   coste conocido cero en entrada y salida. Precio positivo o desconocido se
   rechaza. Una entrada explícita permite modelos locales cuyo catálogo no
   publica coste, bajo responsabilidad del operador.
3. Un error de saldo insuficiente (`402` o evidencia equivalente) bloquea el
   proveedor durante la instancia del plugin. La lista es acotada y el estado
   no se persiste entre reinicios para no conservar bloqueos obsoletos.
4. Una cuota se considera provider-scoped solo ante evidencia explícita de
   organización, proyecto, cuenta/tenant/workspace o dimensiones de cuota como
   TPM, ITPM, OTPM, RPD, TPD o gasto.
5. Un 429 que solo identifica un límite del modelo permanece model-scoped y
   puede probar otro modelo del mismo proveedor.
6. Texto de autenticación, API keys o `Authorization` no es evidencia de cuota
   compartida por sí mismo.

## Consecuencias

### Positivas

- La cadena de fallback no incorpora accidentalmente modelos pagos.
- Un proveedor con saldo agotado o cuota compartida no recibe reintentos en
  cada modelo configurado.
- La política conserva una oportunidad de cambiar de modelo dentro del mismo
  proveedor cuando la respuesta demuestra que el límite es model-scoped.
- El comportamiento es auditable con fixtures sin tráfico externo.

### Limitaciones

- El plugin protege los destinos de fallback; no puede comprobar por sí solo
  que el modelo primario elegido por OpenCode sea gratuito.
- Un proveedor que solo devuelve un 429 genérico no permite una clasificación
  más precisa. En caso de no quedar destinos elegibles, el plugin falla
  cerrado y conserva el error original.
- El cooldown en memoria se reinicia al reiniciar OpenCode; persistirlo podría
  bloquear un proveedor después de que se haya recuperado y se deja para una
  política futura con timestamps y expiración verificables.

## Validación

La decisión se cubre con `tests/phase6-free-provider.test.mjs`: allowlist,
precio desconocido/pago, saldo insuficiente, cuota compartida, cuota de
modelo y diagnóstico con `Authorization`. La matriz local T0–T11 permanece
separada para no alterar su configuración histórica.

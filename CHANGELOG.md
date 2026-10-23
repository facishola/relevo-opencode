# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-22

### Added
- Prototype automatic model fallback plugin for OpenCode CLI v2.1.3 (Fase 8)
- Retry hook using `ctx.session.hook("retry", ...)` + `ctx.session.switchModel()`
- Pure policy engine in `lib/policy.js`:
  - Error classification (recoverable: 429, 500, 502, 503, 504; permanent: 400, 401, 403, 404)
  - Fallback chain A→B→C with configurable models
  - Cooldown, max attempts, attempts window
  - Conservative context check (`canSafelySwitch`)
  - Active model tracking via `ctx.storage`
  - Plugin enable/disable toggle
- Debug logging with timestamps
- Unit-testable policy engine (run with `npm run test:policy`)

### Known Limitations
- Session API (`hook`, `switchModel`, `context`) not publicly typed in `@opencode-ai/plugin` v2
- OpenCode hard attempt limit enforced by runtime
- Automatic fallback is fail-closed when the runtime event stream is unavailable or when partial output/tool activity is observed
- **Context check (T6) uses static config (`ctx.model.list()`), not dynamic `/v1/models`** — documented in Fase 14B.6

### Tested (Fase 14B.5)
- T0: Baseline — PASS
- T1: 429 fallback A→B — PASS
- T2: 400 no fallback — PASS
- T3: 401 no fallback — PASS
- T4: Chain exhaustion A→B→C — PASS
- T5: Plugin disabled — PASS
- T6: Smaller context blocked — LIMITATION (uses config, not `/v1/models`)
- T7: Equal/larger context allowed — PASS
- T8: Streaming — PASS
- T9: Active model tracking — PASS
- T10: Cooldown/cycles — PASS
- T11: Regression baseline — PASS

## [Unreleased]

### Added
- Free-only mode with an explicit `free_models` allowlist and fail-closed
  rejection of paid or unknown-price fallback destinations.
- Provider-scoped in-memory cooldowns for insufficient balance and explicit
  organization/project/account or quota-dimension evidence, while keeping a
  generic model-scoped rate limit local to the affected model.
- Free-provider policy tests covering allowlist enforcement, shared quotas,
  insufficient balance and the distinction between authentication text and
  shared quota evidence.
- V2 session control tool `model_fallback_control` with `enable`, `disable`, `status` and `reset` when `ctx.tool.transform` is available.
- Per-session/per-model attempt and cooldown state, bounded concurrent transitions and explicit timeout/transport-error handling.
- Ambiguous-stream guard for transport errors received after an HTTP 2xx response.
- Local end-to-end matrix runner for T0–T12, including the transport fixture,
  with isolated XDG state and loopback-only mocks.
- Bounded runtime-event guard for partial output and tool activity
- Opt-in native compaction request at the 80% threshold with idempotent IDs
- Terminal-event and durable-status verification before using post-compaction context
- Cleanup explícito de ambos hooks, seguimiento de verificaciones pendientes y guardia contra reentrada por revisión
- Escritura persistente fail-closed cuando el storage no está disponible
- Límite de tamaño de log configurable (`max_log_bytes`, 5 MiB por defecto)
- Companion OpenCode skill for local setup and diagnosis
- Controlled canary runbook and explicit OpenCode/runtime compatibility matrix
- V2 laboratory configuration uses the documented `providers`/`package` shape
  and explicitly registers the companion skill source
- Safety and compaction tests included in `npm test`
- Capability gate that fails closed before hook registration when essential
  runtime operations are unavailable
- Bounded best-effort timeouts for model inventory, storage, `switchModel`,
  compaction admission and durable context reads; pending auxiliary abort
  controllers are cancelled during cleanup.
- Compaction terminal events are correlated with the plugin's idempotent inbox
  ID and the durable compaction message ID before a switch is allowed.

### Limitations
- Compaction is deliberately not used as a blocking continuation inside `retry`; the plugin fails closed when a fresh post-compaction context measurement is unavailable.
- `compaction_enabled` controls compaction requested by this plugin; OpenCode's
  separate global `compaction.auto` setting must be reviewed independently.
- Automatic agent switching is not part of the model-fallback MVP.
- The free-only gate applies to fallback destinations; the primary model must
  be configured as free by the project owner.
- A generic provider 429 without explicit scope evidence cannot prove whether
  the limit is shared; the plugin keeps it model-scoped and fails closed when
  no destination remains.
- Validation uses loopback mocks plus previously authorized free-model
  canaries; no paid models are tested and no quota is deliberately exhausted.
  T0–T12 pass end-to-end with the local matrix, but this is not a production
  guarantee.
- A real OpenCode 2.1.3 smoke run against local Ollama models validated plugin
  loading, context capture, session control registration, and skill discovery;
  fallback acceptance remains covered by loopback mocks.
- Hybrid local integration validated Mock A `429` → Ollama `llama3.1:8b` with
  context-fit approval and a successful fallback response.
- Automatic use of `session.interrupt()` for auxiliary timeout cancellation is
  intentionally not implemented because it may interrupt the whole session;
  the current behavior is bounded, best-effort cancellable and fail-closed.
- Abort signals do not prove that an underlying runtime promise physically
  stops if the runtime ignores the signal; this remains an explicit limitation.
- Automatic agent handoff remains outside the MVP and is governed by
  `docs/decisions/ADR-002-agent-handoff-boundary.md`.
# Unreleased

### Added

- Kit portable de integración por proyecto con README.txt, comandos slash,
  skill pasivo y scripts de instalación/validación.
- Instalación conservadora que no sobrescribe configuración existente y deja
  el plugin desactivado.


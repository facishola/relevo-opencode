---
name: OpenCode Fallback Setup
description: Configure, inspect, and safely diagnose the opencode-fallback runtime plugin without changing protected projects or contacting real providers.
metadata:
  opencode/autoinvoke: false
---

# OpenCode Fallback Setup

Use this skill only to prepare or inspect the `opencode-fallback` plugin. The
runtime fallback is implemented by the plugin; this skill does not register
hooks, switch models, compact sessions, or contact providers.

## Safety rules

1. Work in a project-local `opencode.jsonc` or an isolated test directory.
2. Keep the plugin disabled until the user explicitly asks for a controlled
   local test: `enabled: false` is the safe default.
3. Use complete model references in the form `providerID/modelID`.
4. Do not put API keys, prompts, message content, or tool inputs in logs.
5. Use loopback mocks for validation. Do not run a real-provider canary without
   separate authorization.

## Configuration checklist

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/opencode-fallback",
      "options": {
        "enabled": false,
        "free_only": true,
        "free_models": [
          "ollama-local/llama3.1:8b",
          "google/gemini-3.5-flash-lite"
        ],
        "fallback_models": ["mocka/m-a", "mockb/m-b"],
        "retry_on_errors": [429, 500, 502, 503, 504],
        "max_attempts": 3,
        "max_transitions": 2,
        "provider_cooldown_ms": 60000,
        "context_safety_ratio": 0.8,
        "require_context_check": true,
        "allow_unknown_context": false,
        "require_side_effect_guard": true,
        "compaction_enabled": false,
        "compaction_threshold_ratio": 0.8,
        "max_log_bytes": 5242880,
        "debug": false
      }
    }
  ]
}
```

`compaction_enabled` is an explicit opt-in for compaction requested by this
plugin. It is independent from OpenCode's global `compaction.auto` setting.
When enabled, the plugin only requests native compaction at the configured
threshold and only allows a fallback after it observes a terminal success and
receives a new context measurement. A request being admitted is not proof that
compaction finished.

For a free-only setup, set `free_only: true` and provide `free_models` with
complete `providerID/modelID` references. The plugin rejects a missing or
empty allowlist, skips paid or unknown-price destinations, and treats an
explicit allowlist entry as the operator's assertion that a local model is
free even when its catalog omits cost metadata. The gate applies to fallback
destinations; configure the primary model separately. Insufficient balance or
explicit provider-wide quota evidence causes the runtime to skip the whole
provider for its cooldown, while a generic model-scoped 429 only skips that
model.

When the runtime exposes `ctx.tool.transform`, the plugin also provides the
session tool `model_fallback_control` with `enable`, `disable`, `status`, and
`reset`. This skill may explain how to use that tool, but it does not register
it, invoke it, or perform a fallback itself. If `ctx.tool.transform` is absent,
interactive session control is unavailable and configuration remains the only
control surface.

## Diagnosis

- Confirm the active OpenCode version is the version tested by the package.
- The plugin checks essential runtime capabilities before registering hooks and
  stays disabled if `session.hook`, `session.switchModel`, storage, or required
  model metadata is absent. Event, interactive-control, and compaction APIs
  are optional: when they are absent, ambiguous fallback decisions and plugin
  requested compaction fail closed instead of being guessed.
- Confirm the fallback chain contains only enabled, fully-qualified models.
- Confirm `limit.context` and `limit.output` are declared for every destination.
- Confirm the runtime event stream is available. Without it, the side-effect
  guard must block automatic fallback.
- Re-run the local test suite before changing configuration.
- For end-to-end validation, run `npm run test:e2e:local`; it uses only
  loopback mocks and isolated XDG directories.
- If a test fails, disable the plugin and preserve its logs and diff.

## Rollback

Set `enabled` to `false` in the project-local configuration and restart the
OpenCode process. Do not edit global configuration as part of diagnosis.

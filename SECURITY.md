# Security policy

## Scope

This project is a local OpenCode plugin. It can observe runtime errors and
request a later model attempt, but it does not manage provider credentials or
authenticate users.

## Reporting a vulnerability

Do not publish credentials, tokens, prompts, provider responses, or private
logs in a public issue. Report a suspected vulnerability privately through the
repository's GitHub security contact or, if unavailable, open an issue that
contains only a minimal reproduction and no sensitive data.

## Safe-use requirements

- Keep the plugin disabled until the project configuration and fallback chain
  have been reviewed.
- Do not commit OpenCode authentication files, API keys, `.env` files, logs, or
  provider responses.
- Use complete `providerID/modelID` references and verify context/output limits.
- Start with loopback mocks or local Ollama before any real-provider canary.
- Treat the fallback as fail-closed, not as a guarantee that a provider is
  healthy or that a request can be safely replayed.

Supported compatibility is currently limited to the tested OpenCode V2 runtime;
repeat the contract and loopback matrix after upgrading OpenCode.

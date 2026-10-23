import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.js";
import { FallbackPolicy } from "../lib/policy.js";

test("policy distinguishes billing, shared-provider quota, and model-scoped quota", () => {
  const policy = new FallbackPolicy({ enabled: true });

  const billing = policy.classifyError({
    status: 402,
    message: "Insufficient Balance",
  });
  assert.equal(billing.category, "billing");
  assert.equal(billing.scope, "provider");
  assert.equal(billing.blockProvider, true);
  assert.equal(billing.recoverable, true);

  const sharedQuota = policy.classifyError({
    status: 413,
    code: "rate_limit_exceeded",
    message: "organization quota exceeded: TPM limit 8000",
  });
  assert.equal(sharedQuota.category, "rate_limit");
  assert.equal(sharedQuota.scope, "provider");
  assert.equal(sharedQuota.blockProvider, true);

  const modelQuota = policy.classifyError({
    status: 429,
    message: "model rate limit exceeded",
  });
  assert.equal(modelQuota.category, "rate_limit");
  assert.equal(modelQuota.scope, "model");
  assert.equal(modelQuota.blockProvider, false);

  const authDiagnostic = policy.classifyError({
    status: 429,
    type: "provider.rate-limit",
    message: "Authorization: Bearer [redacted]",
  });
  assert.equal(authDiagnostic.scope, "model");
  assert.equal(authDiagnostic.blockProvider, false);
});

test("policy skips every model from a provider in provider cooldown", () => {
  const policy = new FallbackPolicy({
    enabled: true,
    fallback_models: ["groq/a", "groq/b", "google/free"],
  });

  assert.equal(
    policy.selectNext(
      "groq/a",
      100,
      new Set(["groq/a"]),
      { blockedProviders: new Set(["groq"]) },
    ),
    "google/free",
  );
});

test("free-only policy rejects paid and unknown-price destinations", async () => {
  const policy = new FallbackPolicy({
    enabled: true,
    free_only: true,
    free_models: ["ollama-local/a", "google/free"],
    fallback_models: ["ollama-local/a", "google/free", "google/paid"],
  });

  const inventory = async () => ({
    data: [
      { providerID: "google", id: "free", limit: { context: 32768, output: 4096 }, cost: { input: 0, output: 0 } },
      { providerID: "google", id: "paid", limit: { context: 32768, output: 4096 }, cost: { input: 0.1, output: 0.2 } },
      { providerID: "google", id: "unknown", limit: { context: 32768, output: 4096 } },
    ],
  });

  assert.deepEqual(await policy.canUseModel("ollama-local/a", inventory), {
    allow: true,
    reason: "explicit_free_allowlist",
  });
  assert.equal((await policy.canUseModel("google/paid", inventory)).allow, false);
  assert.equal((await policy.canUseModel("google/unknown", inventory)).allow, false);
  assert.equal((await policy.canUseModel("google/free", inventory)).allow, true);
});

function createRuntime(options) {
  const values = new Map();
  const calls = { switches: [] };
  let retryHandler;
  let contextHandler;
  const models = options.models;
  const ctx = {
    options: { require_side_effect_guard: false, ...options },
    cwd: "C:\\Users\\Norbe\\opencode-fallback-lab\\plugins\\opencode-fallback",
    app: { version: "test-free-provider" },
    storage: {
      async get(key) { return values.get(key); },
      async set(key, value) { values.set(key, value); },
    },
    session: {
      async hook(name, callback) {
        if (name === "retry") retryHandler = callback;
        if (name === "context") contextHandler = callback;
      },
      async switchModel(input) { calls.switches.push(input); },
    },
    model: { async list() { return { data: models }; } },
  };
  return {
    ctx,
    calls,
    async capture(model, sessionID = "ses-free") {
      await contextHandler({
        sessionID,
        model: { providerID: model.split("/")[0], id: model.split("/").slice(1).join("/") },
        system: [],
        messages: [{ role: "user", content: "free-only local test" }],
        tools: {},
        options: { maxTokens: 128 },
      });
    },
    retry() { assert.ok(retryHandler); return retryHandler; },
  };
}

function retryEvent(model, error, sessionID = "ses-free") {
  const slash = model.indexOf("/");
  return {
    sessionID,
    model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) },
    error,
    attempt: 1,
    decision: { retry: false },
  };
}

const freeModels = [
  { providerID: "groq", id: "a", limit: { context: 32768, output: 4096 }, cost: { input: 0, output: 0 } },
  { providerID: "groq", id: "b", limit: { context: 32768, output: 4096 }, cost: { input: 0, output: 0 } },
  { providerID: "google", id: "free", limit: { context: 32768, output: 4096 }, cost: { input: 0, output: 0 } },
];

test("runtime skips same-provider models after shared quota evidence", async () => {
  const runtime = createRuntime({
    enabled: true,
    free_only: true,
    free_models: ["groq/a", "groq/b", "google/free"],
    fallback_models: ["groq/a", "groq/b", "google/free"],
    models: freeModels,
    cooldown_ms: 60_000,
  });
  const cleanup = await plugin.setup(runtime.ctx);
  await runtime.capture("groq/a");
  const event = retryEvent("groq/a", {
    status: 413,
    code: "rate_limit_exceeded",
    message: "organization quota exceeded: TPM limit 8000",
  });
  await runtime.retry()(event);

  assert.deepEqual(runtime.calls.switches.map(({ model }) => model), [
    { providerID: "google", id: "free" },
  ]);
  assert.equal(event.decision.retry, true);
  await cleanup();
});

test("provider quota remains blocked when model cooldown is zero", async () => {
  const runtime = createRuntime({
    enabled: true,
    free_only: true,
    free_models: ["groq/a", "groq/b", "google/free"],
    fallback_models: ["groq/a", "groq/b", "google/free"],
    models: freeModels,
    cooldown_ms: 0,
  });
  const cleanup = await plugin.setup(runtime.ctx);
  await runtime.capture("groq/a");
  const event = retryEvent("groq/a", {
    status: 413,
    code: "rate_limit_exceeded",
    message: "organization quota exceeded: TPM limit 8000",
  });
  await runtime.retry()(event);

  assert.deepEqual(runtime.calls.switches.map(({ model }) => model), [
    { providerID: "google", id: "free" },
  ]);
  assert.equal(event.decision.retry, true);
  await cleanup();
});

test("runtime discards balance-exhausted provider and uses next free provider", async () => {
  const models = [
    { providerID: "deepseek", id: "a", limit: { context: 32768, output: 4096 }, cost: { input: 0, output: 0 } },
    { providerID: "deepseek", id: "b", limit: { context: 32768, output: 4096 }, cost: { input: 0, output: 0 } },
    { providerID: "google", id: "free", limit: { context: 32768, output: 4096 }, cost: { input: 0, output: 0 } },
  ];
  const runtime = createRuntime({
    enabled: true,
    free_only: true,
    free_models: ["deepseek/a", "deepseek/b", "google/free"],
    fallback_models: ["deepseek/a", "deepseek/b", "google/free"],
    models,
    cooldown_ms: 60_000,
  });
  const cleanup = await plugin.setup(runtime.ctx);
  await runtime.capture("deepseek/a");
  const event = retryEvent("deepseek/a", { status: 402, message: "Insufficient Balance" });
  await runtime.retry()(event);

  assert.deepEqual(runtime.calls.switches.map(({ model }) => model), [
    { providerID: "google", id: "free" },
  ]);
  assert.equal(event.decision.retry, true);
  await cleanup();
});

test("runtime permits a different model when quota evidence is model-scoped", async () => {
  const runtime = createRuntime({
    enabled: true,
    free_only: true,
    free_models: ["groq/a", "groq/b", "google/free"],
    fallback_models: ["groq/a", "groq/b", "google/free"],
    models: freeModels,
    cooldown_ms: 60_000,
  });
  const cleanup = await plugin.setup(runtime.ctx);
  await runtime.capture("groq/a");
  const event = retryEvent("groq/a", { status: 429, message: "model rate limit exceeded" });
  await runtime.retry()(event);

  assert.deepEqual(runtime.calls.switches.map(({ model }) => model), [
    { providerID: "groq", id: "b" },
  ]);
  assert.equal(event.decision.retry, true);
  await cleanup();
});

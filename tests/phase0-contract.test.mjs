import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.js";

function createContext({ options = {}, models = [], stored = {}, app = { version: "test-runtime" } } = {}) {
  const values = new Map(Object.entries(stored));
  const calls = { hooks: 0, switches: [], sets: [] };
  let retryHandler;
  let contextHandler;

  const ctx = {
    options: { require_side_effect_guard: false, ...options },
    app,
    cwd: "C:\\Users\\Norbe\\opencode-fallback-lab\\plugins\\opencode-fallback",
    storage: {
      async get(key) {
        return values.get(key);
      },
      async set(key, value) {
        values.set(key, value);
        calls.sets.push({ key, value });
      },
    },
    session: {
      async hook(name, callback) {
        calls.hooks += 1;
        if (name === "retry") retryHandler = callback;
        if (name === "context") contextHandler = callback;
        return { async dispose() {} };
      },
      async switchModel(input) {
        calls.switches.push(input);
      },
    },
    model: {
      async list() {
        return models;
      },
    },
  };

  return {
    ctx,
    calls,
    values,
    getRetryHandler() {
      assert.ok(retryHandler, "retry hook was not registered");
      return retryHandler;
    },
    getContextHandler() {
      assert.ok(contextHandler, "context hook was not registered");
      return contextHandler;
    },
  };
}

test("plugin stays disabled when enabled is omitted", async () => {
  const runtime = createContext();
  const cleanup = await plugin.setup(runtime.ctx);

  assert.equal(runtime.calls.hooks, 0);
  await cleanup();
});

test("plugin fails closed before registering hooks when the runtime is incompatible", async () => {
  const runtime = createContext({
    options: { enabled: true, fallback_models: ["mocka/m-a", "mockb/m-b"] },
  });
  delete runtime.ctx.session.switchModel;

  const cleanup = await plugin.setup(runtime.ctx);

  assert.equal(runtime.calls.hooks, 0);
  await cleanup();
});

test("retry uses event.model.id and preserves provider/model identity", async () => {
  const runtime = createContext({
    options: {
      enabled: true,
      fallback_models: ["mockb/m-b", "mockb/m-b", "bare-model", "mocka/m-a"],
    },
    models: {
      data: [
        { providerID: "mocka", id: "m-a", limit: { context: 32768, output: 8192 } },
        { providerID: "mockb", id: "m-b", limit: { context: 32768, output: 8192 } },
      ],
    },
  });
  const cleanup = await plugin.setup(runtime.ctx);

  await runtime.getContextHandler()({
    sessionID: "ses-contract",
    model: { providerID: "mocka", id: "m-a" },
    system: [],
    messages: [{ role: "user", content: "short request" }],
    tools: {},
    options: { maxTokens: 128 },
  });

  const event = {
    sessionID: "ses-contract",
    model: { providerID: "mocka", id: "m-a" },
    error: { type: "provider.rate-limit", status: 429 },
    attempt: 1,
    decision: { retry: false },
  };
  await runtime.getRetryHandler()(event);

  assert.deepEqual(runtime.calls.switches, [
    { sessionID: "ses-contract", model: { providerID: "mockb", id: "m-b" } },
  ]);
  await cleanup();
});

test("storage writes JSON values instead of serialized JSON strings", async () => {
  const runtime = createContext({
    options: {
      enabled: true,
      fallback_models: ["mocka/m-a", "mockb/m-b"],
    },
    models: {
      data: [
        { providerID: "mocka", id: "m-a", limit: { context: 32768, output: 8192 } },
        { providerID: "mockb", id: "m-b", limit: { context: 32768, output: 8192 } },
      ],
    },
    stored: {
      "fallback:attempts:ses-storage:mocka/m-a": [],
    },
  });
  const cleanup = await plugin.setup(runtime.ctx);

  await runtime.getContextHandler()({
    sessionID: "ses-storage",
    model: { providerID: "mocka", id: "m-a" },
    system: [],
    messages: [{ role: "user", content: "short request" }],
    tools: {},
    options: { maxTokens: 128 },
  });

  await runtime.getRetryHandler()({
    sessionID: "ses-storage",
    model: { providerID: "mocka", id: "m-a" },
    error: { type: "provider.rate-limit", status: 429 },
    attempt: 1,
    decision: { retry: false },
  });

  const attemptWrite = runtime.calls.sets.find(({ key }) => key === "fallback:attempts:ses-storage:mocka/m-a");
  assert.ok(attemptWrite);
  assert.ok(Array.isArray(attemptWrite.value));
  await cleanup();
});

test("async logger flushes diagnostics and write failures do not break the hook", async () => {
  const logRoot = await mkdtemp(join(tmpdir(), "opencode-fallback-phase0-"));
  const runtime = createContext({
    options: { enabled: true, debug: true, logDir: logRoot },
  });
  const cleanup = await plugin.setup(runtime.ctx);
  await cleanup();

  const log = await readFile(join(logRoot, "opencode-fallback.log"), "utf8");
  assert.match(log, /HOOK retry registrado/);
  assert.match(log, /CLEANUP/);

  const invalidLogDir = join(logRoot, "not-a-directory");
  await writeFile(invalidLogDir, "fixture");
  const failedRuntime = createContext({
    options: { enabled: true, debug: true, logDir: invalidLogDir },
  });
  const failedCleanup = await plugin.setup(failedRuntime.ctx);
  const event = {
    sessionID: "ses-logger-failure",
    model: { providerID: "mocka", id: "m-a" },
    error: {
      type: "provider.client-error",
      status: 400,
      message: "Authorization: Bearer provider-secret prompt=private-content",
    },
    attempt: 1,
    decision: { retry: true },
  };

  await assert.doesNotReject(() => failedRuntime.getRetryHandler()(event));
  assert.equal(event.decision.retry, false);
  await failedCleanup();
});

test("setup records runtime version without logging sensitive options", async () => {
  const logRoot = await mkdtemp(join(tmpdir(), "opencode-fallback-phase0-"));
  const runtime = createContext({
    options: {
      enabled: true,
      debug: true,
      logDir: logRoot,
      apiKey: "secret-value",
      prompt: "private prompt",
    },
  });
  const cleanup = await plugin.setup(runtime.ctx);
  await cleanup();

  const log = await readFile(join(logRoot, "opencode-fallback.log"), "utf8");
  assert.match(log, /runtimeVersion=test-runtime/);
  assert.doesNotMatch(log, /secret-value|private prompt/);
});

test("retry diagnostics do not write provider credentials from error messages", async () => {
  const logRoot = await mkdtemp(join(tmpdir(), "opencode-fallback-phase0-"));
  const runtime = createContext({
    options: { enabled: true, debug: true, logDir: logRoot },
  });
  const cleanup = await plugin.setup(runtime.ctx);
  const event = {
    sessionID: "ses-diagnostic-redaction",
    model: { providerID: "mocka", id: "m-a" },
    error: {
      type: "provider.rate-limit",
      status: 429,
      message: "Authorization: Bearer provider-secret apiKey=api-secret",
    },
    attempt: 1,
    decision: { retry: false },
  };

  await runtime.getRetryHandler()(event);
  await cleanup();

  const log = await readFile(join(logRoot, "opencode-fallback.log"), "utf8");
  assert.doesNotMatch(log, /provider-secret|api-secret/);
});

test("persisted session state is bounded and rejects unsafe attempt keys", async () => {
  const storedState = {
    version: 1,
    activeModel: "mocka/m-a",
    visitedModels: ["mocka/m-a", "mockb/m-b"],
    transitions: 999,
    handledAttempts: [
      ...Array.from({ length: 70 }, (_, index) => `mocka/m-a:${index}`),
      "unsafe\nkey",
    ],
  };
  const runtime = createContext({
    options: {
      enabled: true,
      fallback_models: ["mocka/m-a", "mockb/m-b"],
      max_transitions: 999,
    },
    models: {
      data: [
        { providerID: "mocka", id: "m-a", limit: { context: 32768, output: 8192 } },
        { providerID: "mockb", id: "m-b", limit: { context: 32768, output: 8192 } },
      ],
    },
    stored: { "fallback:session_state:ses-bounded": storedState },
  });
  const cleanup = await plugin.setup(runtime.ctx);

  await runtime.getContextHandler()({
    sessionID: "ses-bounded",
    model: { providerID: "mocka", id: "m-a" },
    system: [],
    messages: [{ role: "user", content: "short request" }],
    tools: {},
    options: { maxTokens: 128 },
  });

  const event = {
    sessionID: "ses-bounded",
    model: { providerID: "mocka", id: "m-a" },
    error: { type: "provider.rate-limit", status: 429 },
    attempt: 1,
    decision: { retry: true },
  };
  await runtime.getRetryHandler()(event);
  await cleanup();

  const normalized = runtime.values.get("fallback:session_state:ses-bounded");
  assert.equal(normalized.transitions, 64);
  assert.equal(normalized.handledAttempts.length, 64);
  assert.equal(normalized.handledAttempts.includes("unsafe\nkey"), false);
  assert.equal(event.decision.retry, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.js";

function createRuntime(options) {
  const values = new Map();
  const calls = { switches: [], sets: [] };
  let retryHandler;
  let contextHandler;
  const modelLimits = options.modelLimits || {};
  const switchDelay = Number(options.switchDelay || 0);
  const ctx = {
    options: { require_side_effect_guard: false, ...options },
    cwd: "C:\\Users\\Norbe\\opencode-fallback-lab\\plugins\\opencode-fallback",
    app: { version: "test-runtime" },
    storage: {
      async get(key) { return values.get(key); },
      async set(key, value) {
        values.set(key, value);
        calls.sets.push({ key, value });
      },
    },
    session: {
      async hook(name, callback) {
        if (name === "retry") retryHandler = callback;
        if (name === "context") contextHandler = callback;
      },
      async switchModel(input) {
        if (switchDelay > 0) await new Promise((resolve) => setTimeout(resolve, switchDelay));
        calls.switches.push(input);
      },
    },
    model: {
      async list() {
        return {
          data: [
            { providerID: "mocka", id: "m-a", limit: modelLimits["mocka/m-a"] || { context: 32768, output: 8192 } },
            { providerID: "mockb", id: "m-b", limit: modelLimits["mockb/m-b"] || { context: 32768, output: 8192 } },
            { providerID: "mockc", id: "m-c", limit: modelLimits["mockc/m-c"] || { context: 32768, output: 8192 } },
          ],
        };
      },
    },
  };
  return {
    ctx,
    calls,
    values,
    handler() {
      assert.ok(retryHandler);
      return retryHandler;
    },
    async captureContext(model = "mocka/m-a", content = "short local test", sessionID = "ses-phase1") {
      assert.ok(contextHandler);
      await contextHandler({
        sessionID,
        model: { providerID: model.split("/")[0], id: model.split("/")[1] },
        system: [],
        messages: [{ role: "user", content }],
        tools: {},
        options: { maxTokens: 128 },
      });
    },
  };
}

function retryEvent(model, attempt, sessionID = "ses-phase1") {
  return {
    sessionID,
    model: { providerID: model.split("/")[0], id: model.split("/")[1] },
    error: { type: "provider.rate-limit", status: 429 },
    attempt,
    decision: { retry: false },
  };
}

test("integration records failures and prevents A-B-C-A cycles", async () => {
  const runtime = createRuntime({
    enabled: true,
    fallback_models: ["mocka/m-a", "mockb/m-b", "mockc/m-c"],
    max_transitions: 2,
    cooldown_ms: 0,
  });
  const cleanup = await plugin.setup(runtime.ctx);
  const handler = runtime.handler();
  await runtime.captureContext();
  const startedAt = Date.now();

  const first = retryEvent("mocka/m-a", 1);
  await handler(first);
  await runtime.captureContext("mockb/m-b");
  const second = retryEvent("mockb/m-b", 2);
  await handler(second);
  await runtime.captureContext("mockc/m-c");
  const third = retryEvent("mockc/m-c", 3);
  await handler(third);

  assert.deepEqual(runtime.calls.switches.map(({ model }) => model), [
    { providerID: "mockb", id: "m-b" },
    { providerID: "mockc", id: "m-c" },
  ]);
  assert.equal(third.decision.retry, false);
  const attempts = runtime.values.get("fallback:attempts:ses-phase1:mocka/m-a");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ok, false);
  assert.equal(attempts[0].attempt, 1);
  assert.ok(attempts[0].ts >= startedAt);
  const state = runtime.values.get("fallback:session_state:ses-phase1");
  assert.equal(state.version, 1);
  assert.equal(state.transitions, 2);
  assert.deepEqual(state.visitedModels, ["mocka/m-a", "mockb/m-b", "mockc/m-c"]);
  await cleanup();
});

test("integration does not switch twice for a duplicate retry event", async () => {
  const runtime = createRuntime({
    enabled: true,
    fallback_models: ["mocka/m-a", "mockb/m-b"],
    cooldown_ms: 0,
  });
  const cleanup = await plugin.setup(runtime.ctx);
  const handler = runtime.handler();
  await runtime.captureContext();

  const first = retryEvent("mocka/m-a", 1);
  await handler(first);
  const duplicate = retryEvent("mocka/m-a", 1);
  await handler(duplicate);

  assert.equal(runtime.calls.switches.length, 1);
  assert.equal(duplicate.decision.retry, false);
  await cleanup();
});

test("integration serializes duplicate transitions for one session", async () => {
  const runtime = createRuntime({
    enabled: true,
    fallback_models: ["mocka/m-a", "mockb/m-b"],
    cooldown_ms: 0,
    switchDelay: 10,
  });
  const cleanup = await plugin.setup(runtime.ctx);
  const handler = runtime.handler();
  await runtime.captureContext();

  await Promise.all([
    handler(retryEvent("mocka/m-a", 1)),
    handler(retryEvent("mocka/m-a", 1)),
  ]);

  assert.equal(runtime.calls.switches.length, 1);
  await cleanup();
});

test("integration blocks a measured request that exceeds the destination safe context", async () => {
  const runtime = createRuntime({
    enabled: true,
    fallback_models: ["mocka/m-a", "mockb/m-b"],
    cooldown_ms: 0,
    modelLimits: {
      "mocka/m-a": { context: 100, output: 100 },
      "mockb/m-b": { context: 100, output: 100 },
    },
  });
  const cleanup = await plugin.setup(runtime.ctx);
  await runtime.captureContext("mocka/m-a", "x".repeat(1500));

  const event = retryEvent("mocka/m-a", 1);
  await runtime.handler()(event);

  assert.equal(runtime.calls.switches.length, 0);
  assert.equal(event.decision.retry, false);
  await cleanup();
});

test("integration isolates attempt cooldown state between concurrent sessions", async () => {
  const runtime = createRuntime({
    enabled: true,
    fallback_models: ["mocka/m-a", "mockb/m-b", "mockc/m-c"],
    max_attempts: 1,
    cooldown_ms: 60_000,
    max_transitions: 2,
  });
  const cleanup = await plugin.setup(runtime.ctx);
  await Promise.all([
    runtime.captureContext("mocka/m-a", "session one", "ses-one"),
    runtime.captureContext("mocka/m-a", "session two", "ses-two"),
  ]);
  await Promise.all([
    runtime.handler()(retryEvent("mocka/m-a", 1, "ses-one")),
    runtime.handler()(retryEvent("mocka/m-a", 1, "ses-two")),
  ]);
  await runtime.captureContext("mockb/m-b", "session one", "ses-one");
  const firstB = retryEvent("mockb/m-b", 1, "ses-one");
  await runtime.handler()(firstB);

  await runtime.captureContext("mocka/m-a", "session three", "ses-three");
  const thirdA = retryEvent("mocka/m-a", 1, "ses-three");
  await runtime.handler()(thirdA);

  const switched = runtime.calls.switches.map(({ sessionID, model }) => ({ sessionID, model }));
  assert.deepEqual(switched, [
    { sessionID: "ses-one", model: { providerID: "mockb", id: "m-b" } },
    { sessionID: "ses-two", model: { providerID: "mockb", id: "m-b" } },
    { sessionID: "ses-one", model: { providerID: "mockc", id: "m-c" } },
    { sessionID: "ses-three", model: { providerID: "mockb", id: "m-b" } },
  ]);
  assert.ok(runtime.values.has("fallback:attempts:ses-one:mocka/m-a"));
  assert.ok(runtime.values.has("fallback:attempts:ses-one:mockb/m-b"));
  assert.ok(runtime.values.has("fallback:attempts:ses-two:mocka/m-a"));
  assert.ok(runtime.values.has("fallback:attempts:ses-three:mocka/m-a"));
  await cleanup();
});

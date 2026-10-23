import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.js";

function createRuntime() {
  const values = new Map();
  const calls = { switches: [], tool: null, disposed: false };
  let retryHandler;
  let contextHandler;

  const ctx = {
    options: {
      enabled: true,
      fallback_models: ["mocka/m-a", "mockb/m-b"],
      require_side_effect_guard: false,
    },
    app: { version: "test-runtime" },
    cwd: "C:\\Users\\Norbe\\opencode-fallback-lab\\plugins\\opencode-fallback",
    storage: {
      async get(key) { return values.get(key); },
      async set(key, value) { values.set(key, value); },
    },
    session: {
      async hook(name, callback) {
        if (name === "retry") retryHandler = callback;
        if (name === "context") contextHandler = callback;
        return { async dispose() {} };
      },
      async switchModel(input) { calls.switches.push(input); },
    },
    model: {
      async list() {
        return {
          data: [
            { providerID: "mocka", id: "m-a", limit: { context: 32768, output: 8192 } },
            { providerID: "mockb", id: "m-b", limit: { context: 32768, output: 8192 } },
          ],
        };
      },
    },
    tool: {
      async transform(callback) {
        const editor = { add(tool) { calls.tool = tool; } };
        await callback(editor);
        return { async dispose() { calls.disposed = true; } };
      },
    },
  };

  return {
    ctx,
    calls,
    async execute(action, sessionID = "ses-control") {
      assert.ok(calls.tool, "V2 control tool was not registered");
      return calls.tool.execute({ action }, { sessionID });
    },
    getRetry() {
      assert.ok(retryHandler);
      return retryHandler;
    },
    getContext() {
      assert.ok(contextHandler);
      return contextHandler;
    },
  };
}

function contextEvent(sessionID) {
  return {
    sessionID,
    model: { providerID: "mocka", id: "m-a" },
    system: [],
    messages: [{ role: "user", content: "short request" }],
    tools: {},
    options: { maxTokens: 128 },
  };
}

function retryEvent(sessionID) {
  return {
    sessionID,
    model: { providerID: "mocka", id: "m-a" },
    error: { type: "provider.rate-limit", status: 429 },
    attempt: 1,
    decision: { retry: false },
  };
}

test("V2 control tool toggles fallback per session and resets persisted state", async () => {
  const runtime = createRuntime();
  const cleanup = await plugin.setup(runtime.ctx);

  const disabled = await runtime.execute("disable");
  assert.equal(JSON.parse(disabled.content).enabled, false);

  const disabledEvent = retryEvent("ses-control");
  await runtime.getRetry()(disabledEvent);
  assert.equal(disabledEvent.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);

  const enabled = await runtime.execute("enable");
  assert.equal(JSON.parse(enabled.content).enabled, true);
  await runtime.getContext()(contextEvent("ses-control"));
  const enabledEvent = retryEvent("ses-control");
  await runtime.getRetry()(enabledEvent);
  assert.equal(enabledEvent.decision.retry, true);
  assert.deepEqual(runtime.calls.switches, [
    { sessionID: "ses-control", model: { providerID: "mockb", id: "m-b" } },
  ]);

  const status = JSON.parse((await runtime.execute("status")).content);
  assert.equal(status.override, "enabled");
  assert.equal(status.currentModel, "mockb/m-b");

  const reset = JSON.parse((await runtime.execute("reset")).content);
  assert.equal(reset.override, null);
  assert.equal(reset.currentModel, null);
  assert.equal(runtime.calls.disposed, false);

  await cleanup();
  assert.equal(runtime.calls.disposed, true);
});

test("plugin remains usable when V2 tool registration is unavailable", async () => {
  const runtime = createRuntime();
  delete runtime.ctx.tool;
  const cleanup = await plugin.setup(runtime.ctx);
  await runtime.getContext()(contextEvent("ses-no-tool"));
  const event = retryEvent("ses-no-tool");
  await runtime.getRetry()(event);
  assert.equal(event.decision.retry, true);
  assert.equal(runtime.calls.switches.length, 1);
  await cleanup();
});

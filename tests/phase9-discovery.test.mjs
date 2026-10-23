import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../index.js";
import {
  discoverFreeModels,
  normalizeCatalogCost,
} from "../lib/discovery.js";

const requestWithTools = {
  tools: { shell: { description: "local test tool" } },
};

function model(providerID, id, extra = {}) {
  return {
    providerID,
    id,
    enabled: true,
    status: "active",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 32768, output: 4096 },
    cost: { input: 0, output: 0 },
    ...extra,
  };
}

test("normalizes zero-cost object and tiered catalog costs", () => {
  assert.deepEqual(normalizeCatalogCost({
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  }), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    known: true,
    free: true,
  });

  assert.deepEqual(normalizeCatalogCost([
    { input: 0, output: 0, cache: { read: 0, write: 0 }, tier: "context" },
    { input: 0, output: 0, tier: "default" },
  ]), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    known: true,
    free: true,
  });
});

test("strict discovery selects free compatible models and orders by capacity", async () => {
  const result = await discoverFreeModels({
    data: [
      model("small", "good", { limit: { context: 32768, output: 4096 } }),
      model("large", "good", { limit: { context: 131072, output: 8192 } }),
      model("paid", "bad", { cost: { input: 0.1, output: 0 } }),
      model("unknown", "bad", { cost: undefined }),
      model("disabled", "bad", { enabled: false }),
      model("deprecated", "bad", { status: "deprecated" }),
    ],
  }, { request: requestWithTools });

  assert.deepEqual(result.models.map(({ id }) => id), [
    "large/good",
    "small/good",
  ]);
  assert.equal(result.excluded["paid/bad"], "paid_model");
  assert.equal(result.excluded["unknown/bad"], "free_price_unknown");
  assert.equal(result.excluded["disabled/bad"], "model_disabled");
  assert.equal(result.excluded["deprecated/bad"], "model_deprecated");
});

test("unknown price is allowed only for an explicit model allowlist", async () => {
  const result = await discoverFreeModels({
    data: [
      model("local", "coder", { cost: undefined }),
      model("remote", "coder", { cost: undefined }),
    ],
  }, {
    request: requestWithTools,
    explicitFreeModels: ["local/coder"],
  });

  assert.deepEqual(result.models.map(({ id }) => id), ["local/coder"]);
  assert.equal(result.excluded["remote/coder"], "free_price_unknown");
});

test("unknown or incompatible tools fail closed", async () => {
  const result = await discoverFreeModels({
    data: [
      model("unknown-tools", "model", { capabilities: { input: ["text"], output: ["text"] } }),
      model("no-tools", "model", { capabilities: { tools: false, input: ["text"], output: ["text"] } }),
      model("good", "model"),
    ],
  }, { request: requestWithTools });

  assert.deepEqual(result.models.map(({ id }) => id), ["good/model"]);
  assert.equal(result.excluded["unknown-tools/model"], "tools_unsupported_or_unknown");
  assert.equal(result.excluded["no-tools/model"], "tools_unsupported_or_unknown");
});

test("async model inventories are bounded and supported", async () => {
  async function* inventory() {
    yield model("async", "first");
    yield model("async", "second");
    yield model("async", "third");
  }

  const result = await discoverFreeModels(inventory(), {
    request: { tools: {} },
    maxModels: 2,
  });

  assert.deepEqual(result.models.map(({ id }) => id), ["async/first", "async/second"]);
  assert.equal(result.truncated, true);
});

test("runtime discovers candidates without a manual fallback list", async () => {
  const values = new Map();
  let contextHandler;
  let retryHandler;
  const switches = [];
  const logDir = await mkdtemp(join(tmpdir(), "opencode-fallback-discovery-runtime-"));
  const models = [
    model("primary", "large", {
      limit: { context: 131072, output: 8192 },
      cost: { input: 0.2, output: 0.8 },
    }),
    model("free", "small", {
      limit: { context: 32768, output: 4096 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    }),
    model("paid", "large", { cost: { input: 0.1, output: 0.2 } }),
  ];
  const ctx = {
    options: {
      enabled: true,
      free_only: true,
      auto_discover_free_models: true,
      fallback_models: [],
      require_side_effect_guard: false,
      logDir,
    },
    cwd: logDir,
    app: { version: "discovery-test" },
    storage: {
      async get(key) { return values.get(key); },
      async set(key, value) { values.set(key, value); },
    },
    session: {
      async hook(name, callback) {
        if (name === "context") contextHandler = callback;
        if (name === "retry") retryHandler = callback;
        return { async dispose() {} };
      },
      async switchModel(input) { switches.push(input); },
    },
    model: { async list() { return { data: models }; } },
  };

  const cleanup = await plugin.setup(ctx);
  await contextHandler({
    sessionID: "ses-discovery",
    model: { providerID: "primary", id: "large" },
    system: [],
    messages: [{ role: "user", content: "short request" }],
    tools: { shell: { description: "test tool" } },
    options: { maxTokens: 128 },
  });
  const event = {
    sessionID: "ses-discovery",
    model: { providerID: "primary", id: "large" },
    error: { status: 429, message: "model rate limit exceeded" },
    attempt: 1,
    decision: { retry: false },
  };
  await retryHandler(event);

  assert.equal(event.decision.retry, true);
  assert.deepEqual(switches.map(({ model: switched }) => switched), [
    { providerID: "free", id: "small" },
  ]);
  await cleanup();
});

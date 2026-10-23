import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import plugin, { AsyncLogger } from "../index.js";

function createRuntime(options = {}) {
  let retryHandler;
  let contextHandler;
  const values = new Map();
  const ctx = {
    options: {
      enabled: true,
      fallback_models: ["mocka/m-a", "mockb/m-b"],
      require_side_effect_guard: false,
      debug: true,
      ...options,
    },
    cwd: process.cwd(),
    app: { version: "logger-test" },
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
      async switchModel() {},
    },
    model: {
      async list() {
        return { data: [
          { providerID: "mocka", id: "m-a", limit: { context: 32768, output: 8192 } },
          { providerID: "mockb", id: "m-b", limit: { context: 32768, output: 8192 } },
        ] };
      },
    },
  };
  return {
    ctx,
    retry() { assert.ok(retryHandler); return retryHandler; },
    context() { assert.ok(contextHandler); return contextHandler; },
  };
}

function contextEvent(sessionID) {
  return {
    sessionID,
    model: { providerID: "mocka", id: "m-a" },
    system: [],
    messages: [{ role: "user", content: "logger test" }],
    tools: {},
    options: { maxTokens: 32 },
  };
}

function retryEvent(sessionID) {
  return {
    sessionID,
    model: { providerID: "mocka", id: "m-a" },
    error: { status: 400, type: "bad_request_error" },
    attempt: 1,
    decision: { retry: false },
  };
}

async function waitForFile(path, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readFile(path, "utf8").catch(() => "");
}

test("AsyncLogger writes diagnostics without an unbounded queue", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "opencode-fallback-logger-"));
  const logger = new AsyncLogger(root, join(root, "fallback.log"));
  for (let index = 0; index < 150; index += 1) logger.log(`diagnostic-${index}`);
  assert.ok(logger.pending <= logger.maxPending);
  await logger.close();
  const text = await readFile(join(root, "fallback.log"), "utf8");
  assert.match(text, /diagnostic-0/);
  assert.ok(Buffer.byteLength(text, "utf8") < 5 * 1024 * 1024);
});

test("logger write failure does not break hook execution", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "opencode-fallback-logger-failure-"));
  const logTarget = join(root, "not-a-directory");
  await writeFile(logTarget, "file");
  const runtime = createRuntime({ logDir: logTarget });
  const cleanup = await plugin.setup(runtime.ctx);

  await runtime.context()(contextEvent("ses-logger-failure"));
  const event = retryEvent("ses-logger-failure");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  await cleanup();
});

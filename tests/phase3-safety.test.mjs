import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.js";
import { compactionRequestId, evaluateCompactionNeed } from "../lib/compaction.js";

function createEventBus() {
  const subscribers = new Set();
  return {
    subscribe({ signal } = {}) {
      let queue = [];
      let waiter = null;
      let closed = false;
      const iterator = {
        async next() {
          if (queue.length > 0) return { done: false, value: queue.shift() };
          if (closed) return { done: true, value: undefined };
          return new Promise((resolve) => { waiter = resolve; });
        },
        async return() {
          closed = true;
          if (waiter) {
            const resolve = waiter;
            waiter = null;
            resolve({ done: true, value: undefined });
          }
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() { return this; },
      };
      const subscriber = {
        emit(event) {
          if (closed) return;
          if (waiter) {
            const resolve = waiter;
            waiter = null;
            resolve({ done: false, value: event });
          } else {
            queue.push(event);
          }
        },
        close() { iterator.return(); },
      };
      signal?.addEventListener("abort", () => iterator.return(), { once: true });
      subscribers.add(subscriber);
      return iterator;
    },
    emit(event) {
      for (const subscriber of subscribers) subscriber.emit(event);
    },
    close() {
      for (const subscriber of subscribers) subscriber.close();
      subscribers.clear();
    },
  };
}

function createRuntime(options = {}, modelLimits = {}) {
  const values = new Map();
  const calls = { switches: [], switchSignals: [], compactions: [], compactSignals: [], contextSignals: [], disposals: [] };
  const events = createEventBus();
  let retryHandler;
  let contextHandler;

  const ctx = {
    options: { enabled: true, fallback_models: ["mocka/m-a", "mockb/m-b"], ...options },
    cwd: "C:\\Users\\Norbe\\opencode-fallback-lab\\plugins\\opencode-fallback",
    app: { version: "test-runtime" },
    storage: {
      async get(key) {
        if (options.storageNeverResolves === true) return new Promise(() => {});
        return values.get(key);
      },
      async set(key, value) {
        if (options.storageNeverResolves === true) return new Promise(() => {});
        if (options.storageFails === true) throw new Error("storage unavailable");
        values.set(key, value);
      },
    },
    session: {
      async hook(name, callback) {
        if (name === "retry") retryHandler = callback;
        if (name === "context") contextHandler = callback;
        return { async dispose() { calls.disposals.push(name); } };
      },
      async switchModel(input, requestOptions) {
        calls.switches.push(input);
        calls.switchSignals.push(requestOptions?.signal);
        if (options.switchNeverResolves === true) return new Promise(() => {});
      },
      async compact(input, requestOptions) {
        calls.compactions.push(input);
        calls.compactSignals.push(requestOptions?.signal);
      },
    },
    model: {
      async list() {
        if (options.modelListNeverResolves === true) return new Promise(() => {});
        return {
          data: [
            { providerID: "mocka", id: "m-a", limit: modelLimits["mocka/m-a"] || { context: 32768, output: 8192 } },
            { providerID: "mockb", id: "m-b", limit: modelLimits["mockb/m-b"] || { context: 32768, output: 8192 } },
          ],
        };
      },
    },
  };
  if (options.withEvents !== false) {
    ctx.event = { subscribe: (...args) => events.subscribe(...args) };
  }
  if (Array.isArray(options.compactionHistory)) {
    ctx.session.context = async (input, requestOptions) => {
      calls.contextSignals.push(requestOptions?.signal);
      return options.compactionHistory;
    };
  }
  if (options.compactNeverResolves === true) {
    ctx.session.compact = async (input, requestOptions) => {
      calls.compactSignals.push(requestOptions?.signal);
      return new Promise(() => {});
    };
  }
  if (options.contextNeverResolves === true) {
    ctx.session.context = async (input, requestOptions) => {
      calls.contextSignals.push(requestOptions?.signal);
      return new Promise(() => {});
    };
  }

  return {
    ctx,
    calls,
    events,
    async setup() { return plugin.setup(ctx); },
    context() { assert.ok(contextHandler); return contextHandler; },
    retry() { assert.ok(retryHandler); return retryHandler; },
  };
}

function contextEvent(sessionID, content, model = "mocka/m-a") {
  return {
    sessionID,
    model: { providerID: model.split("/")[0], id: model.split("/")[1] },
    system: [],
    messages: [{ role: "user", content }],
    tools: {},
    options: { maxTokens: 32 },
  };
}

function compactionID(sessionID, revision = 1) {
  return compactionRequestId(sessionID, revision);
}

function retryEvent(sessionID, model = "mocka/m-a") {
  return {
    sessionID,
    model: { providerID: model.split("/")[0], id: model.split("/")[1] },
    error: { type: "provider.rate-limit", status: 429 },
    attempt: 1,
    decision: { retry: false },
  };
}

async function settleEvents() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("compaction policy requests at the configured 80 percent threshold", () => {
  const result = evaluateCompactionNeed(
    { inputTokens: 76, outputTokens: 5, overflow: false },
    { context: 100, output: 32 },
    { safetyRatio: 0.8 },
  );

  assert.equal(result.request, true);
  assert.equal(result.reason, "context_threshold_reached");
  assert.equal(result.threshold, 80);
});

test("compaction policy supports an absolute buffer and rejects overflow", () => {
  const buffered = evaluateCompactionNeed(
    { inputTokens: 76, outputTokens: 5, overflow: false },
    { context: 100, output: 32 },
    { safetyRatio: 0.8, bufferTokens: 20 },
  );
  const overflow = evaluateCompactionNeed(
    { inputTokens: 70, outputTokens: 5, overflow: true },
    { context: 100, output: 32 },
    { safetyRatio: 0.8 },
  );

  assert.equal(buffered.request, true);
  assert.equal(buffered.threshold, 80);
  assert.equal(overflow.request, false);
  assert.equal(overflow.reason, "measurement_overflow");
});

test("fallback is vetoed after streamed output", async () => {
  const runtime = createRuntime();
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-stream", "short"));
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-stream" } });
  runtime.events.emit({ type: "session.text.delta", data: { sessionID: "ses-stream", delta: "partial" } });
  await settleEvents();

  const event = retryEvent("ses-stream");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("transport failure after an HTTP response is treated as an ambiguous stream", async () => {
  const runtime = createRuntime();
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-ambiguous-stream", "short"));
  runtime.events.emit({ type: "session.inbox.enqueued", data: { sessionID: "ses-ambiguous-stream" } });
  await settleEvents();

  const event = retryEvent("ses-ambiguous-stream");
  event.error = { type: "provider.transport", status: 200, message: "stream closed" };
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("an observable 408 timeout without a message remains eligible for fallback", async () => {
  const runtime = createRuntime();
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-timeout-408", "short"));
  runtime.events.emit({ type: "session.inbox.enqueued", data: { sessionID: "ses-timeout-408" } });
  await settleEvents();

  const event = retryEvent("ses-timeout-408");
  event.error = { type: "provider.error", status: 408 };
  await runtime.retry()(event);

  assert.equal(event.decision.retry, true);
  assert.equal(runtime.calls.switches.length, 1);
  await cleanup();
});

test("context snapshot allows a provider failure before step.started is observed", async () => {
  const runtime = createRuntime();
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-context-first", "short"));
  runtime.events.emit({ type: "session.inbox.enqueued", data: { sessionID: "ses-context-first" } });
  await settleEvents();

  const event = retryEvent("ses-context-first");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, true);
  assert.equal(runtime.calls.switches.length, 1);
  await cleanup();
});

test("fallback is fail-closed when the runtime event stream is unavailable", async () => {
  const runtime = createRuntime({ withEvents: false });
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-no-events", "short"));

  const event = retryEvent("ses-no-events");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("fallback is vetoed after a tool call", async () => {
  const runtime = createRuntime();
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-tool", "short"));
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-tool" } });
  runtime.events.emit({ type: "session.tool.called", data: { sessionID: "ses-tool", id: "tool-1", executed: true } });
  await settleEvents();

  const event = retryEvent("ses-tool");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("confirmed compaction plus a fresh context measurement allows a safe switch", async () => {
  const runtime = createRuntime({
    compaction_enabled: true,
    context_safety_ratio: 0.8,
    compactionHistory: [{ type: "compaction", id: compactionID("ses-compact"), status: "completed" }],
  }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-compact", "x".repeat(300)));
  await settleEvents();
  assert.equal(runtime.calls.compactions.length, 1);

  runtime.events.emit({ type: "session.compaction.started", data: { sessionID: "ses-compact", inputID: compactionID("ses-compact") } });
  runtime.events.emit({ type: "session.compaction.ended", data: { sessionID: "ses-compact" } });
  await settleEvents();
  await runtime.context()(contextEvent("ses-compact", "short after summary"));
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-compact" } });
  await settleEvents();

  const event = retryEvent("ses-compact");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, true);
  assert.equal(runtime.calls.switches.length, 1);
  await cleanup();
  assert.deepEqual(runtime.calls.disposals.sort(), ["context", "retry"]);
});

test("failed compaction keeps fallback blocked", async () => {
  const runtime = createRuntime({ compaction_enabled: true }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-compact-fail", "x".repeat(300)));
  await settleEvents();
  runtime.events.emit({ type: "session.compaction.started", data: { sessionID: "ses-compact-fail" } });
  runtime.events.emit({ type: "session.compaction.failed", data: { sessionID: "ses-compact-fail" } });
  await settleEvents();

  const event = retryEvent("ses-compact-fail");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("durable compaction failure overrides a misleading terminal event", async () => {
  const runtime = createRuntime({
    compaction_enabled: true,
    compactionHistory: [{ type: "compaction", id: compactionID("ses-durable-fail"), status: "failed" }],
  }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-durable-fail", "x".repeat(300)));
  await settleEvents();
  runtime.events.emit({ type: "session.compaction.started", data: { sessionID: "ses-durable-fail", inputID: compactionID("ses-durable-fail") } });
  runtime.events.emit({ type: "session.compaction.ended", data: { sessionID: "ses-durable-fail" } });
  await settleEvents();
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-durable-fail" } });
  await settleEvents();

  const event = retryEvent("ses-durable-fail");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("terminal compaction without durable state remains blocked", async () => {
  const runtime = createRuntime({ compaction_enabled: true }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-no-durable", "x".repeat(300)));
  await settleEvents();
  runtime.events.emit({ type: "session.compaction.started", data: { sessionID: "ses-no-durable", inputID: compactionID("ses-no-durable") } });
  runtime.events.emit({ type: "session.compaction.ended", data: { sessionID: "ses-no-durable" } });
  await settleEvents();
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-no-durable" } });
  await settleEvents();

  const event = retryEvent("ses-no-durable");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("unrelated compaction events cannot authorize a model switch", async () => {
  const runtime = createRuntime({
    compaction_enabled: true,
    compactionHistory: [{ type: "compaction", id: compactionID("ses-other"), status: "completed" }],
  }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-unrelated-compaction", "x".repeat(300)));
  await settleEvents();
  runtime.events.emit({
    type: "session.compaction.started",
    data: { sessionID: "ses-unrelated-compaction", inputID: compactionID("ses-other") },
  });
  runtime.events.emit({ type: "session.compaction.ended", data: { sessionID: "ses-unrelated-compaction" } });
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-unrelated-compaction" } });
  await settleEvents();

  const event = retryEvent("ses-unrelated-compaction");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("durable compaction ID mismatch keeps fallback blocked", async () => {
  const runtime = createRuntime({
    compaction_enabled: true,
    compactionHistory: [{ type: "compaction", id: compactionID("ses-other-durable"), status: "completed" }],
  }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-durable-mismatch", "x".repeat(300)));
  await settleEvents();
  runtime.events.emit({
    type: "session.compaction.started",
    data: { sessionID: "ses-durable-mismatch", inputID: compactionID("ses-durable-mismatch") },
  });
  runtime.events.emit({ type: "session.compaction.ended", data: { sessionID: "ses-durable-mismatch" } });
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-durable-mismatch" } });
  await settleEvents();

  const event = retryEvent("ses-durable-mismatch");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("durable compaction completion without a fresh context measurement remains blocked", async () => {
  const runtime = createRuntime({
    compaction_enabled: true,
    compactionHistory: [{ type: "compaction", id: compactionID("ses-stale-compaction"), status: "completed" }],
  }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-stale-compaction", "x".repeat(300)));
  await settleEvents();
  runtime.events.emit({ type: "session.compaction.started", data: { sessionID: "ses-stale-compaction", inputID: compactionID("ses-stale-compaction") } });
  runtime.events.emit({ type: "session.compaction.ended", data: { sessionID: "ses-stale-compaction" } });
  await settleEvents();
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-stale-compaction" } });
  await settleEvents();

  const event = retryEvent("ses-stale-compaction");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("completed compaction is insufficient when the refreshed destination still cannot fit", async () => {
  const runtime = createRuntime({
    compaction_enabled: true,
    compactionHistory: [{ type: "compaction", id: compactionID("ses-insufficient-after-compaction"), status: "completed" }],
  }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-insufficient-after-compaction", "x".repeat(300)));
  await settleEvents();
  runtime.events.emit({ type: "session.compaction.started", data: { sessionID: "ses-insufficient-after-compaction", inputID: compactionID("ses-insufficient-after-compaction") } });
  runtime.events.emit({ type: "session.compaction.ended", data: { sessionID: "ses-insufficient-after-compaction" } });
  await settleEvents();
  await runtime.context()(contextEvent("ses-insufficient-after-compaction", "x".repeat(300)));
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-insufficient-after-compaction" } });
  await settleEvents();

  const event = retryEvent("ses-insufficient-after-compaction");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("compaction admission timeout does not block the context hook", async () => {
  const runtime = createRuntime({
    compaction_enabled: true,
    compactNeverResolves: true,
    compaction_admission_timeout_ms: 100,
  }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  const started = Date.now();
  await runtime.context()(contextEvent("ses-compact-timeout", "x".repeat(300)));
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1_000);
  assert.equal(runtime.calls.compactions.length, 0);
  assert.equal(runtime.calls.compactSignals.length, 1);
  assert.equal(runtime.calls.compactSignals[0]?.aborted, true);
  await cleanup();
});

test("late compaction events cannot reopen an admission timeout", async () => {
  const runtime = createRuntime({
    compaction_enabled: true,
    compactNeverResolves: true,
    compaction_admission_timeout_ms: 100,
  }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-late-compaction", "x".repeat(300)));
  await settleEvents();
  runtime.events.emit({
    type: "session.compaction.started",
    data: { sessionID: "ses-late-compaction", inputID: compactionID("ses-late-compaction") },
  });
  runtime.events.emit({ type: "session.compaction.ended", data: { sessionID: "ses-late-compaction" } });
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-late-compaction" } });
  await settleEvents();

  const event = retryEvent("ses-late-compaction");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("compaction status timeout aborts only the context lookup", async () => {
  const runtime = createRuntime({
    compaction_enabled: true,
    contextNeverResolves: true,
    compaction_status_timeout_ms: 100,
  }, {
    "mocka/m-a": { context: 100, output: 32 },
    "mockb/m-b": { context: 100, output: 32 },
  });
  const cleanup = await runtime.setup();

  await runtime.context()(contextEvent("ses-context-timeout", "x".repeat(300)));
  runtime.events.emit({ type: "session.compaction.started", data: { sessionID: "ses-context-timeout", inputID: compactionID("ses-context-timeout") } });
  runtime.events.emit({ type: "session.compaction.ended", data: { sessionID: "ses-context-timeout" } });
  await settleEvents();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(runtime.calls.contextSignals.length, 1);
  assert.equal(runtime.calls.contextSignals[0]?.aborted, true);
  await cleanup();
});

test("model inventory timeout fails closed before a model switch", async () => {
  const runtime = createRuntime({
    modelListNeverResolves: true,
    model_list_timeout_ms: 100,
  });
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-model-list-timeout", "short"));
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-model-list-timeout" } });
  await settleEvents();

  const event = retryEvent("ses-model-list-timeout");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("switchModel timeout aborts the request and fails closed", async () => {
  const runtime = createRuntime({
    switchNeverResolves: true,
    switch_model_timeout_ms: 100,
  });
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-switch-timeout", "short"));
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-switch-timeout" } });
  await settleEvents();

  const event = retryEvent("ses-switch-timeout");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 1);
  assert.equal(runtime.calls.switchSignals[0]?.aborted, true);
  await cleanup();
});

test("storage timeout fails closed without blocking the retry hook", async () => {
  const runtime = createRuntime({
    storageNeverResolves: true,
    storage_timeout_ms: 100,
  });
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-storage-timeout", "short"));
  runtime.events.emit({ type: "session.step.started", data: { sessionID: "ses-storage-timeout" } });
  await settleEvents();

  const started = Date.now();
  const event = retryEvent("ses-storage-timeout");
  await runtime.retry()(event);

  assert.ok(Date.now() - started < 1_000);
  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

test("storage failure fails closed before a model switch", async () => {
  const runtime = createRuntime({ storageFails: true });
  const cleanup = await runtime.setup();
  await runtime.context()(contextEvent("ses-storage-fail", "short"));

  const event = retryEvent("ses-storage-fail");
  await runtime.retry()(event);

  assert.equal(event.decision.retry, false);
  assert.equal(runtime.calls.switches.length, 0);
  await cleanup();
});

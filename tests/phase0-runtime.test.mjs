import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalModelId,
  getRuntimeVersion,
  inspectRuntimeCapabilities,
  isSafeIdentifier,
  normalizeModelChain,
  normalizeAttempt,
  readStorageJson,
  redactDiagnosticText,
  redactForLog,
  writeStorageJson,
} from "../lib/runtime.js";

test("canonical model references preserve provider and model identity", () => {
  assert.equal(canonicalModelId({ providerID: "mocka", id: "m-a" }), "mocka/m-a");
  assert.equal(canonicalModelId({ providerID: "mocka", modelID: "m-a" }), "mocka/m-a");
  assert.equal(canonicalModelId({ providerID: "mocka" }), null);
});

test("fallback chain validation removes duplicates and rejects bare references", () => {
  assert.deepEqual(
    normalizeModelChain(["mocka/m-a", "mocka/m-a", "m-b", "mockb/m-b", "/broken"]),
    {
      valid: ["mocka/m-a", "mockb/m-b"],
      invalid: ["m-b", "/broken"],
      duplicates: ["mocka/m-a"],
    },
  );
});

test("runtime rejects control characters and oversized model references", () => {
  assert.equal(canonicalModelId("mocka/m-a\nmalicious"), null);
  assert.equal(canonicalModelId({ providerID: "mocka\u0000", id: "m-a" }), null);
  assert.equal(canonicalModelId(`mocka/${"m".repeat(512)}`), null);
  assert.equal(isSafeIdentifier("ses-safe_01"), true);
  assert.equal(isSafeIdentifier("ses-bad\r\nheader"), false);
  assert.equal(isSafeIdentifier("s".repeat(257)), false);
});

test("runtime normalizes untrusted attempt values to a bounded integer", () => {
  assert.equal(normalizeAttempt(2), 2);
  assert.equal(normalizeAttempt("3"), 3);
  assert.equal(normalizeAttempt(0), 1);
  assert.equal(normalizeAttempt(Infinity), 1);
  assert.equal(normalizeAttempt("9".repeat(100)), 1);
});

test("runtime version is optional but observable when exposed", () => {
  assert.equal(getRuntimeVersion({ app: { version: "2.1.3" } }), "2.1.3");
  assert.equal(getRuntimeVersion({}), "unknown");
});

test("runtime capability gate requires the operations used by fallback", () => {
  const ctx = {
    session: { hook() {}, switchModel() {} },
    storage: { get() {}, set() {} },
    model: { list() {} },
  };

  assert.deepEqual(
    inspectRuntimeCapabilities(ctx, { require_side_effect_guard: false }),
    {
      compatible: true,
      missing: [],
      optional: { controlTool: false, eventStream: false, compaction: false },
    },
  );

  const missingSwitch = inspectRuntimeCapabilities({
    ...ctx,
    session: { hook() {} },
  }, { require_side_effect_guard: false });
  assert.equal(missingSwitch.compatible, false);
  assert.deepEqual(missingSwitch.missing, ["session.switchModel"]);
});

test("runtime capability gate reports unavailable compaction without disabling fallback", () => {
  const result = inspectRuntimeCapabilities({
    session: { hook() {}, switchModel() {}, compact() {} },
    storage: { get() {}, set() {} },
    model: { list() {} },
  }, { compaction_enabled: true, require_side_effect_guard: false });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.optional.compaction, false);
});

test("storage adapter accepts JSON values and legacy serialized strings", async () => {
  const values = new Map([
    ["native", [{ ts: 1 }]],
    ["legacy", "[{\"ts\":2}]"],
  ]);
  const storage = {
    async get(key) { return values.get(key); },
    async set(key, value) { values.set(key, value); },
  };

  assert.deepEqual(await readStorageJson(storage, "native", []), [{ ts: 1 }]);
  assert.deepEqual(await readStorageJson(storage, "legacy", []), [{ ts: 2 }]);
  await writeStorageJson(storage, "new", [{ ts: 3 }]);
  assert.deepEqual(values.get("new"), [{ ts: 3 }]);
});

test("diagnostic redaction hides secrets and private content", () => {
  const safe = redactForLog({
    fallback_models: ["mocka/m-a"],
    apiKey: "secret-value",
    prompt: "private prompt",
    nested: { authorization: "Bearer secret" },
  });

  assert.deepEqual(safe, {
    fallback_models: ["mocka/m-a"],
    apiKey: "[REDACTED]",
    prompt: "[REDACTED]",
    nested: { authorization: "[REDACTED]" },
  });
});

test("diagnostic text redaction masks credentials and removes log injection controls", () => {
  const safe = redactDiagnosticText(
    "Authorization: Bearer super-secret-token\napiKey=another-secret password=hunter2",
  );

  assert.doesNotMatch(safe, /super-secret-token|another-secret|hunter2/);
  assert.doesNotMatch(safe, /[\r\n]/);
  assert.match(safe, /\[REDACTED\]/);
});

test("diagnostic option redaction handles circular values", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.deepEqual(redactForLog(cyclic), { self: "[CIRCULAR]" });
});

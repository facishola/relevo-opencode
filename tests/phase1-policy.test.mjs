import assert from "node:assert/strict";
import test from "node:test";
import { FallbackPolicy } from "../lib/policy.js";

test("policy classifies recoverable and permanent provider errors", () => {
  const policy = new FallbackPolicy({ enabled: true });

  assert.equal(policy.isRecoverableError({ status: 429 }), true);
  assert.equal(policy.isRecoverableError({ status: 503 }), true);
  assert.equal(policy.isRecoverableError({ type: "provider.transport", message: "timeout" }), true);
  assert.equal(policy.isRecoverableError({ status: 400 }), false);
  assert.equal(policy.isRecoverableError({ status: 400, isRetryable: true }), false);
  assert.equal(policy.isRecoverableError({ status: 403 }), false);
  assert.equal(policy.isPermanentError({ status: 400 }), true);
  assert.equal(policy.isPermanentError({ status: 403 }), true);
});

test("policy skips unavailable, cooled-down and already visited models", () => {
  const now = 1_000;
  const policy = new FallbackPolicy({
    enabled: true,
    fallback_models: ["mocka/m-a", "mockb/m-b", "mockc/m-c"],
    unavailable_models: ["mockb/m-b"],
    cooldown_ms: 100,
  });
  policy.recordAttempt("mockc/m-c", false, now);

  assert.equal(
    policy.selectNext("mocka/m-a", now, new Set(["mocka/m-a"])),
    null,
  );
  assert.equal(
    policy.selectNext("mocka/m-a", now + 200, new Set(["mocka/m-a", "mockb/m-b"])),
    "mockc/m-c",
  );
  assert.equal(
    policy.selectNext("mockc/m-c", now + 200, new Set(["mocka/m-a", "mockb/m-b", "mockc/m-c"])),
    null,
  );
});

test("policy enforces failure limits within the configured window", () => {
  const policy = new FallbackPolicy({
    enabled: true,
    fallback_models: ["mocka/m-a", "mockb/m-b"],
    max_attempts: 2,
    attempts_window_ms: 100,
    cooldown_ms: 0,
  });

  policy.recordAttempt("mocka/m-a", false, 100);
  policy.recordAttempt("mocka/m-a", false, 150);
  assert.equal(policy.attemptsExceeded("mocka/m-a", 150), true);
  assert.equal(policy.attemptsExceeded("mocka/m-a", 260), false);
});

test("policy treats invalid limits as unknown and bounds async model inventory", async () => {
  const policy = new FallbackPolicy({
    enabled: true,
    fallback_models: ["mocka/m-a", "mockb/m-b"],
  });

  const invalidLimits = await policy.canSafelySwitch(
    "mocka/m-a",
    "mockb/m-b",
    async () => ({
      data: [
        { providerID: "mocka", id: "m-a", limit: { context: 32768 } },
        { providerID: "mockb", id: "m-b", limit: { context: Infinity } },
      ],
    }),
  );
  assert.equal(invalidLimits.allow, false);
  assert.equal(invalidLimits.reason, "contexto_destino_desconocido");

  const boundedPolicy = new FallbackPolicy({
    enabled: true,
    fallback_models: ["mocka/m-a", "mockb/m-b"],
  });
  const boundedInventory = await boundedPolicy.canSafelySwitch(
    "mocka/m-a",
    "mockb/m-b",
    async function* () {
      for (let index = 0; index < 512; index += 1) {
        yield { providerID: "other", id: `m-${index}`, limit: { context: 32768 } };
      }
      yield { providerID: "mockb", id: "m-b", limit: { context: 32768 } };
    },
  );
  assert.equal(boundedInventory.allow, false);
  assert.equal(boundedInventory.reason, "contexto_destino_desconocido");
});

test("policy allows a smaller known destination for a request measured separately", async () => {
  const policy = new FallbackPolicy({
    enabled: true,
    fallback_models: ["primary/large", "free/small"],
  });
  const result = await policy.canSafelySwitch(
    "primary/large",
    "free/small",
    async () => ({
      data: [
        { providerID: "primary", id: "large", limit: { context: 131072, output: 8192 } },
        { providerID: "free", id: "small", limit: { context: 32768, output: 4096 } },
      ],
    }),
  );

  assert.equal(result.allow, true);
  assert.equal(result.reason, "contexto_destino_conocido");
});

import assert from "node:assert/strict";
import test from "node:test";
import { estimateContext, evaluateContextFit } from "../lib/context.js";

test("estimator includes system, messages, tools and output reserve inputs", () => {
  const estimate = estimateContext({
    system: [{ type: "text", text: "system instruction" }],
    messages: [{ role: "user", content: [{ type: "text", text: "user request" }] }],
    tools: { read: { description: "read files", input: { type: "object" } } },
    options: { maxTokens: 128 },
  });

  assert.ok(estimate.inputTokens > 0);
  assert.equal(estimate.outputTokens, 128);
  assert.ok(estimate.sections.system > 0);
  assert.ok(estimate.sections.messages > 0);
  assert.ok(estimate.sections.tools > 0);
  assert.equal(estimate.content, undefined);
});

test("a 500-token request is rejected for a 100-token destination", () => {
  const result = evaluateContextFit(
    { inputTokens: 500, outputTokens: 10, approximate: true },
    { limit: { context: 100, output: 100 } },
    { safetyRatio: 0.8 },
  );

  assert.equal(result.allow, false);
  assert.equal(result.reason, "request_exceeds_safe_context");
  assert.equal(result.meta.requiredTokens, 510);
  assert.equal(result.meta.safeLimit, 80);
});

test("the 80 percent safety threshold leaves room for output", () => {
  const allowed = evaluateContextFit(
    { inputTokens: 60, outputTokens: 10, approximate: true },
    { limit: { context: 100, output: 100 } },
    { safetyRatio: 0.8 },
  );
  const rejected = evaluateContextFit(
    { inputTokens: 71, outputTokens: 10, approximate: true },
    { limit: { context: 100, output: 100 } },
    { safetyRatio: 0.8 },
  );

  assert.equal(allowed.allow, true);
  assert.equal(allowed.reason, "request_within_safe_context");
  assert.equal(rejected.allow, false);
});

test("missing maxTokens still reserves the destination output limit", () => {
  const result = evaluateContextFit(
    { inputTokens: 60, outputTokens: 0, approximate: true },
    { limit: { context: 100, output: 100 } },
    { safetyRatio: 0.8 },
  );

  assert.equal(result.allow, false);
  assert.equal(result.meta.outputTokens, 100);
  assert.equal(result.reason, "request_exceeds_safe_context");
});

test("unknown or overflowing measurements fail closed", () => {
  const unknown = evaluateContextFit(
    { inputTokens: 10, outputTokens: 1, approximate: true },
    null,
    { safetyRatio: 0.8 },
  );
  const overflow = evaluateContextFit(
    { inputTokens: 10, outputTokens: 1, approximate: true, overflow: true },
    { limit: { context: 100, output: 100 } },
    { safetyRatio: 0.8 },
  );

  assert.equal(unknown.allow, false);
  assert.equal(unknown.reason, "destination_context_unknown");
  assert.equal(overflow.allow, false);
  assert.equal(overflow.reason, "request_measurement_overflow");
});

const DEFAULT_SAFETY_RATIO = 0.8;
const MIN_SAFETY_RATIO = 0.5;
const MAX_SAFETY_RATIO = 0.95;
const MAX_BUFFER_TOKENS = 10_000_000;

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_BUFFER_TOKENS
    ? number
    : 0;
}

function safetyRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SAFETY_RATIO;
  return Math.min(MAX_SAFETY_RATIO, Math.max(MIN_SAFETY_RATIO, number));
}

function contextLimit(model) {
  const value = Number(model?.context ?? model?.limit?.context);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Decides whether native compaction should be requested before the next safe
 * point. It never claims that compaction completed; the event tracker must
 * observe a completed event and the context hook must measure again.
 */
export function evaluateCompactionNeed(estimate, model, options = {}) {
  const limit = contextLimit(model);
  const ratio = safetyRatio(options.safetyRatio);
  const buffer = positiveInteger(options.bufferTokens);
  const threshold = buffer > 0
    ? Math.max(0, limit - buffer)
    : Math.floor(limit * ratio);
  const inputTokens = Math.max(0, Math.floor(Number(estimate?.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.floor(Number(estimate?.outputTokens) || 0));
  const requiredTokens = inputTokens + outputTokens;
  const meta = {
    contextLimit: limit,
    safetyRatio: ratio,
    bufferTokens: buffer,
    threshold,
    inputTokens,
    outputTokens,
    requiredTokens,
  };

  if (estimate?.overflow) return { request: false, reason: "measurement_overflow", ...meta };
  if (!limit) return { request: false, reason: "context_limit_unknown", ...meta };
  if (requiredTokens >= threshold) return { request: true, reason: "context_threshold_reached", ...meta };
  return { request: false, reason: "context_below_threshold", ...meta };
}

export function compactionRequestId(sessionID, revision) {
  const safeSession = typeof sessionID === "string" ? sessionID.slice(0, 160) : "unknown";
  const safeRevision = Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
  return `opencode-fallback-compaction:${safeSession}:${safeRevision}`;
}


const DEFAULT_CHARS_PER_TOKEN = 3;
const DEFAULT_SAFETY_RATIO = 0.8;
const MIN_SAFETY_RATIO = 0.5;
const MAX_SAFETY_RATIO = 0.95;
const MAX_MEASURED_CHARACTERS = 4_000_000;
const MAX_MEASURE_DEPTH = 32;

function positiveFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function boundedSafetyRatio(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return DEFAULT_SAFETY_RATIO;
  return Math.min(MAX_SAFETY_RATIO, Math.max(MIN_SAFETY_RATIO, ratio));
}

function boundedCharsPerToken(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio >= 1 && ratio <= 8
    ? ratio
    : DEFAULT_CHARS_PER_TOKEN;
}

function addCharacters(state, value) {
  state.characters += value;
  if (state.characters > MAX_MEASURED_CHARACTERS) state.overflow = true;
}

function measureValue(value, state, depth = 0) {
  if (state.overflow) return;
  if (depth > MAX_MEASURE_DEPTH) {
    state.overflow = true;
    return;
  }

  if (value === null || value === undefined) {
    addCharacters(state, 4);
    return;
  }
  if (typeof value === "string") {
    addCharacters(state, value.length + 2);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    addCharacters(state, String(value).length);
    return;
  }
  if (typeof value !== "object") {
    addCharacters(state, 8);
    return;
  }

  if (Array.isArray(value)) {
    addCharacters(state, 2);
    for (const item of value) measureValue(item, state, depth + 1);
    return;
  }

  addCharacters(state, 2);
  for (const [key, item] of Object.entries(value)) {
    addCharacters(state, key.length + 3);
    measureValue(item, state, depth + 1);
  }
}

function measureSection(value, charsPerToken) {
  const state = { characters: 0, overflow: false };
  measureValue(value, state);
  return {
    characters: state.characters,
    tokens: state.characters > 0 ? Math.ceil(state.characters / charsPerToken) : 0,
    overflow: state.overflow,
  };
}

function readContextLimit(model) {
  return positiveFiniteNumber(model?.context) || positiveFiniteNumber(model?.limit?.context);
}

function readOutputLimit(model) {
  return positiveFiniteNumber(model?.output) || positiveFiniteNumber(model?.limit?.output);
}

/**
 * Estimates the assembled request without retaining or returning its content.
 * The result is deliberately conservative and tokenizer-independent.
 */
export function estimateContext(request = {}, options = {}) {
  const charsPerToken = boundedCharsPerToken(options.charsPerToken);
  const sections = {
    system: measureSection(request.system, charsPerToken),
    messages: measureSection(request.messages, charsPerToken),
    tools: measureSection(request.tools, charsPerToken),
  };
  const characters = Object.values(sections).reduce((sum, section) => sum + section.characters, 0);
  const inputTokens = Object.values(sections).reduce((sum, section) => sum + section.tokens, 0);
  const outputTokens = Math.floor(positiveFiniteNumber(request.options?.maxTokens));

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    characters,
    approximate: true,
    overflow: Object.values(sections).some((section) => section.overflow),
    sections: Object.fromEntries(Object.entries(sections).map(([name, section]) => [name, section.tokens])),
  };
}

/**
 * Checks whether a measured request fits a destination model with a safety margin.
 * Unknown limits and measurements fail closed; callers may explicitly opt out.
 */
export function evaluateContextFit(estimate, model, options = {}) {
  const safetyRatio = boundedSafetyRatio(options.safetyRatio);
  const contextLimit = readContextLimit(model);
  const outputLimit = readOutputLimit(model);
  const inputTokens = Math.max(0, Math.floor(Number(estimate?.inputTokens) || 0));
  const requestedOutputTokens = Math.max(0, Math.floor(Number(estimate?.outputTokens) || 0));
  const outputTokens = requestedOutputTokens || outputLimit;
  const requiredTokens = inputTokens + outputTokens;
  const meta = {
    contextLimit,
    outputLimit,
    safetyRatio,
    safeLimit: contextLimit > 0 ? Math.floor(contextLimit * safetyRatio) : 0,
    inputTokens,
    outputTokens,
    requiredTokens,
    approximate: estimate?.approximate !== false,
  };

  if (estimate?.overflow) {
    return { allow: false, reason: "request_measurement_overflow", meta };
  }
  if (!contextLimit) {
    return { allow: false, reason: "destination_context_unknown", meta };
  }
  if (outputLimit && outputTokens > outputLimit) {
    return { allow: false, reason: "output_reserve_exceeds_destination_limit", meta };
  }
  if (requiredTokens > meta.safeLimit) {
    return { allow: false, reason: "request_exceeds_safe_context", meta };
  }
  return { allow: true, reason: "request_within_safe_context", meta };
}

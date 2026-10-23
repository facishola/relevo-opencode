import { canonicalModelId } from "./runtime.js";

const DEFAULT_MAX_MODELS = 512;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function readCostField(entry, directKeys, nestedKeys = []) {
  const directKey = directKeys.find((key) => Object.prototype.hasOwnProperty.call(entry, key));
  if (directKey) return finiteNonNegative(entry[directKey]);

  const nested = entry.cache;
  if (nested && typeof nested === "object") {
    const nestedKey = nestedKeys.find((key) => Object.prototype.hasOwnProperty.call(nested, key));
    if (nestedKey) return finiteNonNegative(nested[nestedKey]);
  }
  return undefined;
}

function combineCostField(entries, directKeys, nestedKeys = [], required = false) {
  const present = entries.some((entry) => (
    directKeys.some((key) => Object.prototype.hasOwnProperty.call(entry, key))
    || (entry.cache && nestedKeys.some((key) => Object.prototype.hasOwnProperty.call(entry.cache, key)))
  ));
  if (!present) return required ? null : null;

  const values = entries.map((entry) => readCostField(entry, directKeys, nestedKeys));
  if (values.some((value) => value === null)) return null;
  const knownValues = values.filter((value) => value !== undefined);
  if (knownValues.length === 0) return required ? null : null;
  return Math.max(...knownValues);
}

/**
 * Accepts the object shape used by older OpenCode runtimes and the tiered
 * array shape exposed by the current V2 model API.
 */
export function normalizeCatalogCost(value) {
  const entries = Array.isArray(value)
    ? value.filter((entry) => entry && typeof entry === "object")
    : value && typeof value === "object"
      ? [value]
      : [];
  if (entries.length === 0) return null;

  const input = combineCostField(entries, ["input"], [], true);
  const output = combineCostField(entries, ["output"], [], true);
  const cacheRead = combineCostField(entries, ["cacheRead"], ["read"]);
  const cacheWrite = combineCostField(entries, ["cacheWrite"], ["write"]);
  const known = input !== null && output !== null;
  const free = known
    && input === 0
    && output === 0
    && (cacheRead === null || cacheRead === 0)
    && (cacheWrite === null || cacheWrite === 0);

  return { input, output, cacheRead, cacheWrite, known, free };
}

function positiveLimit(model, key) {
  const value = Number(model?.limit?.[key]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hasTextCapability(capabilities, direction) {
  const values = capabilities?.[direction];
  return Array.isArray(values) && values.includes("text");
}

function requiresTools(request) {
  return Boolean(request?.tools && typeof request.tools === "object" && Object.keys(request.tools).length > 0);
}

function containsContentType(value, types, depth = 0) {
  if (depth > 8 || value === null || value === undefined || typeof value !== "object") return false;
  if (typeof value.type === "string" && types.has(value.type)) return true;
  if (Array.isArray(value)) return value.some((item) => containsContentType(item, types, depth + 1));
  return Object.values(value).some((item) => containsContentType(item, types, depth + 1));
}

export function getRequestRequirements(request = {}) {
  const input = ["text"];
  if (containsContentType(request.messages, new Set(["image", "input_image"]))) input.push("image");
  return {
    tools: request?.tools && typeof request.tools === "object"
      ? Object.fromEntries(Object.keys(request.tools).map((name) => [name, true]))
      : {},
    input,
  };
}

function modelReason(model, { request = {}, explicitFreeModels = new Set() } = {}) {
  const id = canonicalModelId(model);
  if (!id) return { id: null, reason: "invalid_model_reference" };
  if (model.enabled === false || model.disabled === true) return { id, reason: "model_disabled" };
  if (String(model.status || "").toLowerCase() === "deprecated") return { id, reason: "model_deprecated" };
  if (!positiveLimit(model, "context") || !positiveLimit(model, "output")) {
    return { id, reason: "model_limits_unknown" };
  }

  const capabilities = model.capabilities;
  const requiredInput = Array.isArray(request?.input) && request.input.length > 0
    ? request.input
    : ["text"];
  if (!requiredInput.every((type) => Array.isArray(capabilities?.input) && capabilities.input.includes(type))) {
    return { id, reason: "text_capability_unknown_or_unsupported" };
  }
  if (!hasTextCapability(capabilities, "output")) return { id, reason: "text_capability_unknown_or_unsupported" };
  if (requiresTools(request) && capabilities?.tools !== true) {
    return { id, reason: "tools_unsupported_or_unknown" };
  }

  const cost = normalizeCatalogCost(model.cost);
  const explicit = explicitFreeModels.has(id);
  if (!cost || !cost.known) {
    return explicit
      ? { id, model, cost: null, explicit: true }
      : { id, reason: "free_price_unknown" };
  }
  if (!cost.free) return { id, reason: "paid_model" };
  return { id, model, cost, explicit };
}

async function collectModels(inventory, maxModels) {
  const result = [];
  let truncated = false;
  const add = (model) => {
    if (result.length >= maxModels) {
      truncated = true;
      return false;
    }
    result.push(model);
    return true;
  };

  if (inventory && typeof inventory[Symbol.asyncIterator] === "function") {
    for await (const model of inventory) {
      if (!add(model)) break;
    }
  } else {
    const values = Array.isArray(inventory)
      ? inventory
      : Array.isArray(inventory?.data)
        ? inventory.data
        : [];
    for (const model of values) {
      if (!add(model)) break;
    }
  }
  return { models: result, truncated };
}

/**
 * Builds a deterministic, bounded list of strictly free candidates.
 * The provider is never contacted by this helper.
 */
export async function discoverFreeModels(inventory, options = {}) {
  const maxModels = Number.isSafeInteger(options.maxModels) && options.maxModels > 0
    ? Math.min(options.maxModels, DEFAULT_MAX_MODELS)
    : DEFAULT_MAX_MODELS;
  const explicitFreeModels = new Set(
    Array.isArray(options.explicitFreeModels)
      ? options.explicitFreeModels.map(canonicalModelId).filter(Boolean)
      : [],
  );
  const collected = await collectModels(inventory, maxModels);
  const excluded = {};
  const accepted = [];

  for (const candidate of collected.models) {
    const assessed = modelReason(candidate, { request: options.request, explicitFreeModels });
    if (!assessed.model) {
      if (assessed.id) excluded[assessed.id] = assessed.reason;
      continue;
    }
    accepted.push({
      id: assessed.id,
      model: assessed.model,
      cost: assessed.cost,
      explicit: assessed.explicit === true,
      context: positiveLimit(assessed.model, "context"),
      output: positiveLimit(assessed.model, "output"),
    });
  }

  accepted.sort((left, right) => (
    right.context - left.context
    || right.output - left.output
    || left.id.localeCompare(right.id)
  ));

  return { models: accepted, excluded, truncated: collected.truncated };
}

const SENSITIVE_KEY = /(api[-_]?key|authorization|credential|password|prompt|secret|token|private|header|body|content)/i;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001F\u007F]/g;
const MAX_MODEL_REF_LENGTH = 512;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_MODEL_ID_LENGTH = 384;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ATTEMPT = 1_000_000;

function isBoundedText(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !CONTROL_CHARACTERS.test(value);
}

export function parseModelRef(modelId) {
  if (typeof modelId !== "string") return null;
  const value = modelId.trim();
  if (!isBoundedText(value, MAX_MODEL_REF_LENGTH)) return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;

  const providerID = value.slice(0, slash);
  const id = value.slice(slash + 1);
  if (!isBoundedText(providerID, MAX_PROVIDER_ID_LENGTH)) return null;
  if (!isBoundedText(id, MAX_MODEL_ID_LENGTH)) return null;
  return { providerID, id };
}

export function canonicalModelId(model) {
  if (typeof model === "string") {
    const parsed = parseModelRef(model);
    return parsed ? `${parsed.providerID}/${parsed.id}` : null;
  }

  const providerID = typeof model?.providerID === "string" ? model.providerID.trim() : "";
  const id = typeof model?.id === "string"
    ? model.id.trim()
    : typeof model?.modelID === "string"
      ? model.modelID.trim()
      : "";
  const parsed = providerID && id ? parseModelRef(`${providerID}/${id}`) : null;
  return parsed ? `${parsed.providerID}/${parsed.id}` : null;
}

export function normalizeModelChain(models) {
  const valid = [];
  const invalid = [];
  const duplicates = [];
  const seen = new Set();

  for (const value of Array.isArray(models) ? models : []) {
    const modelId = canonicalModelId(value);
    if (!modelId) {
      invalid.push(value);
      continue;
    }
    if (seen.has(modelId)) {
      duplicates.push(modelId);
      continue;
    }
    seen.add(modelId);
    valid.push(modelId);
  }

  return { valid, invalid, duplicates };
}

export function getRuntimeVersion(ctx) {
  return typeof ctx?.app?.version === "string" && ctx.app.version.length > 0
    ? ctx.app.version
    : "unknown";
}

/**
 * Check the runtime capabilities required by the configured safety mode.
 * Capability detection is more reliable than trusting a version string alone:
 * OpenCode documents the APIs, but compatible builds can expose different
 * subsets while the plugin is being loaded.
 */
export function inspectRuntimeCapabilities(ctx, options = {}) {
  const missing = [];
  const compactionEnabled = options.compaction_enabled === true;
  const requireContextMetadata = options.require_context_check !== false || compactionEnabled;

  if (typeof ctx?.session?.hook !== "function") missing.push("session.hook");
  if (typeof ctx?.session?.switchModel !== "function") missing.push("session.switchModel");
  if (typeof ctx?.storage?.get !== "function") missing.push("storage.get");
  if (typeof ctx?.storage?.set !== "function") missing.push("storage.set");
  if (requireContextMetadata && typeof ctx?.model?.list !== "function") missing.push("model.list");

  const eventStream = typeof ctx?.event?.subscribe === "function";
  const compaction = eventStream
    && typeof ctx?.session?.compact === "function"
    && typeof ctx?.session?.context === "function";

  return {
    compatible: missing.length === 0,
    missing,
    optional: {
      controlTool: typeof ctx?.tool?.transform === "function",
      eventStream,
      compaction,
    },
  };
}

export function isSafeIdentifier(value, maxLength = MAX_IDENTIFIER_LENGTH) {
  return isBoundedText(value, maxLength);
}

export function normalizeAttempt(value) {
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= MAX_ATTEMPT
    ? attempt
    : 1;
}

export async function readStorageJson(storage, key, fallback) {
  try {
    const raw = await storage.get(key);
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      // Compatibilidad con valores string legítimos, como el modelo activo.
      return raw;
    }
  } catch {
    return fallback;
  }
}

export async function writeStorageJson(storage, key, value) {
  try {
    await storage.set(key, value);
    return true;
  } catch {
    return false;
  }
}

export function redactForLog(value, key = "", seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result = value.map((item) => redactForLog(item, key, seen));
    seen.delete(value);
    return result;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  const result = Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactForLog(entryValue, entryKey, seen),
    ]),
  );
  seen.delete(value);
  return result;
}

export function redactDiagnosticText(value, maxLength = 160) {
  let text = String(value ?? "");
  text = text.replace(CONTROL_CHARACTERS_GLOBAL, " ");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  text = text.replace(
    /((?:api[-_ ]?key|authorization|credential|password|secret|token)\s*[:=]\s*)([^\s,;]+)/gi,
    "$1[REDACTED]",
  );
  text = text.replace(
    /([?&](?:api[-_]?key|authorization|password|secret|token)=)[^&#\s]*/gi,
    "$1[REDACTED]",
  );
  text = text.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]");
  return text.slice(0, maxLength);
}

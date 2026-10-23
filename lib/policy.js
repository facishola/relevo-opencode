/**
 * Fase 8 — Motor puro de decisión de fallback de modelos.
 * Sin dependencias de OpenCode: probabile con `node` aislado.
 *
 * Responsabilidades:
 * - Clasificar un error como recuperable o permanente.
 * - Elegir el siguiente modelo de la cadena de fallback.
 * - Aplicar cooldown, intentos máximos y recuperación del modelo original.
 * - Decidir si compactar el contexto antes de cambiar de modelo (política de ventana).
 *
 * Toda entrada/salida son datos planos. No hay efectos secundarios.
 */

import { normalizeCatalogCost } from "./discovery.js";

const MAX_MODEL_LIST_ITEMS = 512;
const MAX_MODEL_META_CACHE_ITEMS = 128;
const MAX_ERROR_TEXT_LENGTH = 8192;

function positiveFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function providerOf(modelId) {
  if (typeof modelId !== "string") return null;
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : null;
}

function errorText(error) {
  const body = typeof error?.response?.body === "string"
    ? error.response.body
    : typeof error?.response?.body?.message === "string"
      ? error.response.body.message
      : "";
  return [
    error?.code,
    error?.type,
    error?.name,
    error?.message,
    body,
  ].filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join(" ")
    .slice(0, MAX_ERROR_TEXT_LENGTH);
}

export class FallbackPolicy {
  constructor(options = {}) {
    this.chain = Array.isArray(options.fallback_models) ? [...options.fallback_models] : [];
    this.unavailable = new Set(Array.isArray(options.unavailable_models) ? options.unavailable_models : []);
    this.retryableStatuses = new Set(Array.isArray(options.retry_on_errors) ? options.retry_on_errors : [429, 500, 502, 503, 504]);
    this.retryableTypes = new Set(Array.isArray(options.retryable_types) ? options.retryable_types : ["rate_limit_error", "provider.unavailable", "provider.overloaded"]);
    this.maxAttempts = Number(options.max_attempts) || 3;
    this.attemptsWindowMs = Number(options.attempts_window_ms) || 600000;
    this.cooldownMs = Number(options.cooldown_ms) || 60000;
    this.backoffMs = Number(options.backoff_ms) || 0;
    this.recoverOriginal = options.recover_original_model !== false;
    this.enabled = options.enabled !== false;
    this.freeOnly = options.free_only === true;
    this.freeModels = new Set(
      Array.isArray(options.free_models)
        ? options.free_models.filter((modelId) => typeof modelId === "string" && providerOf(modelId))
        : [],
    );
    this.minContextForSwitch = Number(options.min_context_for_switch) ?? 0;
    // Protección conservadora de contexto
    this.requireContextCheck = options.require_context_check !== false; // habilitado por defecto
    this.allowUnknownContext = options.allow_unknown_context === true; // deshabilitado por defecto (conservador)
    // modelo actual -> { attempts: [{ts, ok}], cooldownUntil, disabledSince }
    this.state = new Map();
    
    // Cache de metadatos de modelos: modelId -> { context, output }
    this.modelMetaCache = new Map();
  }

  // ---------- A: clasificación de errores ----------

  classifyError(error) {
    if (!error) {
      return { category: "unknown", scope: "model", recoverable: false, blockProvider: false };
    }

    const status = Number(error.statusCode || error.status || 0);
    const type = String(error.type || error.name || "").toLowerCase();
    const text = errorText(error).toLowerCase();
    const combined = `${type} ${text}`;

    if ([400, 401, 403, 404].includes(status)) {
      return { category: "permanent", scope: status === 404 ? "model" : "provider", recoverable: false, blockProvider: false };
    }

    if (
      status === 402
      || /insufficient\s+balance|payment\s+required|prepay|credit\s+balance|billing\s+(?:limit|blocked|disabled)/i.test(combined)
    ) {
      return { category: "billing", scope: "provider", recoverable: true, blockProvider: true };
    }

    const rateLimited = this.retryableStatuses.has(status)
      || this.retryableTypes.has(type)
      || /rate.?limit|quota|too many requests|resource.?exhausted|tokens?\s+per\s+(?:minute|day)|(?:i|o)?tpm|(?:r|t)pd/i.test(combined);
    if (rateLimited) {
      // Authentication text is deliberately excluded here. A provider can
      // include an `Authorization` header or API-key wording in a generic
      // 429 diagnostic without proving that the whole account/org is quota
      // blocked. Shared scope requires explicit quota/billing dimensions.
      const sharedScope = /organization|\borg\b|project|account|tenant|workspace|team|(?:i|o)?tpm|rpd|tpd|spend/i.test(combined);
      return {
        category: "rate_limit",
        scope: sharedScope ? "provider" : "model",
        recoverable: true,
        blockProvider: sharedScope,
      };
    }

    if (
      error.isRetryable === true
      || status === 408
      || type === "provider.transport"
      || type.includes("timeout")
      || /econn(?:reset|refused|aborted)|etimedout|enotfound|overload|unavailable|internal server|bad gateway|service unavailable/i.test(combined)
    ) {
      return { category: "transient", scope: "model", recoverable: true, blockProvider: false };
    }

    return { category: "unknown", scope: "model", recoverable: false, blockProvider: false };
  }

  isRecoverableError(error) {
    return this.classifyError(error).recoverable;
  }

  isPermanentError(error) {
    return this.classifyError(error).category === "permanent";
  }

  // ---------- A: inventario / disponibilidad de modelos ----------

  isConfigured(modelId) {
    return this.chain.includes(modelId);
  }

  isUnavailable(modelId) {
    return this.unavailable.has(modelId);
  }

  // ---------- A: siguiente modelo de la cadena ----------

  selectNext(currentModelId, now = Date.now(), visited = new Set(), selectionOptions = {}) {
    if (!this.enabled) return null;
    const blockedProviders = selectionOptions?.blockedProviders instanceof Set
      ? selectionOptions.blockedProviders
      : new Set(Array.isArray(selectionOptions?.blockedProviders) ? selectionOptions.blockedProviders : []);
    const eligible = (id) => (
      !visited.has(id)
      && !this.isUnavailable(id)
      && !blockedProviders.has(providerOf(id))
      && !this.isInCooldown(id, now)
      && !this.attemptsExceeded(id, now)
    );
    const idx = this.chain.indexOf(currentModelId);
    if (idx === -1) {
      return this.chain.find(eligible) || null;
    }

    const start = (idx + 1) % this.chain.length;
    let candidate = start;
    let checked = 0;
    while (checked < this.chain.length) {
      const id = this.chain[candidate];
      if (eligible(id)) {
        return id;
      }
      candidate = (candidate + 1) % this.chain.length;
      checked++;
    }
    return null; // todos en cooldown, no disponibles o agotados
  }

  isInCooldown(modelId, now = Date.now()) {
    const entry = this.state.get(modelId);
    if (!entry || !entry.cooldownUntil) return false;
    return now < entry.cooldownUntil;
  }

  // ---------- A: registrar intento ----------

  recordAttempt(modelId, ok, now = Date.now()) {
    let entry = this.state.get(modelId);
    if (!entry) {
      entry = { attempts: [], cooldownUntil: 0, disabledSince: 0 };
      this.state.set(modelId, entry);
    }
    entry.attempts.push({ ts: now, ok });
    // ventana deslizante
    const cutoff = now - this.attemptsWindowMs;
    entry.attempts = entry.attempts.filter((a) => a.ts >= cutoff);

    if (ok) {
      entry.cooldownUntil = 0;
      return;
    }

    // si falló, poner en cooldown
    entry.cooldownUntil = now + this.cooldownMs + this.backoffMs;
    entry.disabledSince = now;
  }

  // ---------- A: ¿agotados los intentos del modelo actual? ----------

  attemptsExceeded(modelId, now = Date.now()) {
    const entry = this.state.get(modelId);
    if (!entry) return false;
    const cutoff = now - this.attemptsWindowMs;
    const recent = entry.attempts.filter((a) => a.ts >= cutoff && !a.ok).length;
    return recent >= this.maxAttempts;
  }

  // ---------- A: modelo original para recuperación ----------

  getOriginalModel() {
    return this.chain[0] || null;
  }

  // ---------- E: protección conservadora de contexto ----------

  /**
   * Obtiene metadatos del modelo desde la cache o desde model.list() (async).
   * Esta función debe llamarse con await desde el hook.
   */
  async getModelMeta(modelId, modelListFn) {
    if (this.modelMetaCache.has(modelId)) {
      return this.modelMetaCache.get(modelId);
    }
    if (!modelListFn) {
      return null;
    }
    try {
      const models = await modelListFn();
      let found = null;
      if (models && typeof models[Symbol.asyncIterator] === 'function') {
        let inspected = 0;
        for await (const m of models) {
          if (inspected >= MAX_MODEL_LIST_ITEMS) break;
          inspected += 1;
          if (`${m.providerID}/${m.id}` === modelId) {
            found = m;
            break;
          }
        }
      } else if (models?.data && Array.isArray(models.data)) {
        found = models.data.find(m => `${m.providerID}/${m.id}` === modelId);
      } else if (Array.isArray(models)) {
        found = models.find(m => `${m.providerID}/${m.id}` === modelId);
      }
      if (found) {
        const meta = {
          context: positiveFiniteNumber(found.limit?.context),
          output: positiveFiniteNumber(found.limit?.output),
          cost: normalizeCatalogCost(found.cost),
        };
        if (this.modelMetaCache.size >= MAX_MODEL_META_CACHE_ITEMS) {
          const oldest = this.modelMetaCache.keys().next().value;
          this.modelMetaCache.delete(oldest);
        }
        this.modelMetaCache.set(modelId, meta);
        return meta;
      }
    } catch (e) {
      // Silencioso - fallback a null
    }
    return null;
  }

  async canUseModel(modelId, modelListFn) {
    if (!this.freeOnly) return { allow: true, reason: "free_only_disabled" };
    const meta = await this.getModelMeta(modelId, modelListFn);
    if (this.freeModels.has(modelId)) {
      if (!meta || !meta.cost || !meta.cost.known) {
        return meta
          ? { allow: true, reason: "explicit_free_allowlist", meta }
          : { allow: true, reason: "explicit_free_allowlist" };
      }
      if (!meta.cost.free) return { allow: false, reason: "paid_model", meta };
      return { allow: true, reason: "explicit_free_allowlist", meta };
    }
    const cost = meta?.cost;
    if (!cost || !cost.known) {
      return { allow: false, reason: "free_price_unknown", meta };
    }
    return cost.free
      ? { allow: true, reason: "catalog_zero_cost", meta }
      : { allow: false, reason: "paid_model", meta };
  }

  /**
   * Verifica si el cambio a nextModelId es seguro según la política conservadora.
   * Retorna { allow: boolean, reason: string, meta?: object }
   */
  async canSafelySwitch(currentModelId, nextModelId, modelListFn) {
    if (!this.requireContextCheck) {
      return { allow: true, reason: "context_check_disabled" };
    }

    const nextMeta = await this.getModelMeta(nextModelId, modelListFn);
    
    // 1. Contexto desconocido o ausente
    if (!nextMeta || !nextMeta.context || nextMeta.context <= 0) {
      if (this.allowUnknownContext) {
        return { allow: true, reason: "unknown_context_allowed_by_config", meta: nextMeta };
      }
      return { allow: false, reason: "contexto_destino_desconocido", meta: nextMeta };
    }

    // The measured request is checked separately by evaluateContextFit in the
    // runtime. A smaller destination is safe when the actual request fits it;
    // comparing declared window sizes would reject valid failovers.
    return { allow: true, reason: "contexto_destino_conocido", meta: nextMeta };
  }

  // Método estático de compatibilidad (para tests unitarios)
  static classifyModel(model) {
    const limit = (model && model.limit) || {};
    const context = Number(limit.context) || 0;
    const output = Number(limit.output) || 0;
    let tier;
    if (context >= 128000) tier = "grande";
    else if (context >= 32768) tier = "medio";
    else if (context > 0) tier = "pequeño";
    else tier = "desconocido";
    return { context, output, tier };
  }

  // ---------- utilidad de estado para tests ----------

  getState() {
    return {
      chain: this.chain,
      unavailable: [...this.unavailable],
      perModel: [...this.state.entries()].map(([id, e]) => ({
        id,
        attempts: e.attempts.length,
        recentFailures: e.attempts.filter((a) => !a.ok).length,
        cooldownUntil: e.cooldownUntil || 0,
        disabledSince: e.disabledSince || 0,
      })),
    };
  }
}

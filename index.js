/**
 * Fase 8 — Prototipo de plugin de fallback automático de modelos (OpenCode v2.1.3).
 * FORMATO V2: objeto { id, setup } exportado por defecto.
 *
 * ESTE PLUGIN PERMANECE DESACTIVADO (`enabled: false`) HASTA AUTORIZACIÓN EXPRESA.
 * El opencode.jsonc del laboratorio lo referencia únicamente para pruebas
 * aisladas y conserva la activación deshabilitada.
 *
 * Diseño (basado en evidencia de Fase 7):
 * - ctx.session.hook("retry", event) detecta errores recuperables en runtime.
 * - ctx.session.switchModel({ sessionID, model }) cambia el modelo del siguiente intento.
 * - ctx.session.context({ sessionID }) lee historial (no session.messages, que es undefined).
 * - ctx.storage persiste intentos / cooldowns entre reinicios del plugin.
 *
 * Limitaciones conocidas (documentadas en INFORME_FASE7.md):
 * - API de sesión no está tipada públicamente en @opencode-ai/plugin v2 (runtime).
 * - Límite duro de intentos integrado de OpenCode.
 * - Re-ejecución posible de herramientas no idempotentes.
 */

import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { FallbackPolicy } from "./lib/policy.js";
import { estimateContext, evaluateContextFit } from "./lib/context.js";
import { RuntimeActivityTracker } from "./lib/activity.js";
import { compactionRequestId, evaluateCompactionNeed } from "./lib/compaction.js";
import {
  canonicalModelId,
  getRuntimeVersion,
  inspectRuntimeCapabilities,
  isSafeIdentifier,
  normalizeModelChain,
  normalizeAttempt,
  parseModelRef,
  readStorageJson,
  redactDiagnosticText,
  redactForLog,
  writeStorageJson,
} from "./lib/runtime.js";

/**
 * Logger asíncrono no bloqueante con cola de escritura.
 * Evita bloquear el event loop en el hook de retry.
 */
export class AsyncLogger {
  constructor(logDir, logFile, maxLogBytes = 5 * 1024 * 1024) {
    this.logDir = logDir;
    this.logFile = logFile;
    this.maxLogBytes = Number.isSafeInteger(maxLogBytes) && maxLogBytes >= 16 * 1024
      ? Math.min(maxLogBytes, 50 * 1024 * 1024)
      : 5 * 1024 * 1024;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.maxPending = 100;
    this.directoryReady = null;
    this.closed = false;
    this.closing = false;
  }

  log(message) {
    if (this.closed || this.closing) return;
    if (this.pending >= this.maxPending) {
      process.stderr.write(`[${new Date().toISOString()}] [opencode-fallback] LOG QUEUE FULL: dropping diagnostic line\n`);
      return;
    }

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [opencode-fallback] ${redactDiagnosticText(message, 4096)}\n`;

    this.pending += 1;
    // Encolar escritura para no bloquear
    this.queue = this.queue.then(async () => {
      try {
        if (!this.directoryReady) {
          this.directoryReady = mkdir(this.logDir, { recursive: true }).catch((error) => {
            this.directoryReady = null;
            throw error;
          });
        }
        await this.directoryReady;
        let size = 0;
        try { size = (await stat(this.logFile)).size; } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (size + Buffer.byteLength(line, "utf8") <= this.maxLogBytes) {
          await appendFile(this.logFile, line);
        } else {
          process.stderr.write(`[${new Date().toISOString()}] [opencode-fallback] LOG FILE LIMIT: dropping diagnostic line\n`);
        }
      } catch (e) {
        // Log de error no bloqueante - solo stderr
        process.stderr.write(`[${new Date().toISOString()}] [opencode-fallback] LOG WRITE ERROR: ${redactDiagnosticText(e.message)}\n`);
      }
      process.stderr.write(line);
    }).catch(() => {}).finally(() => {
      this.pending -= 1;
    }); // Evitar unhandled rejection
  }

  async close() {
    if (this.closed) return;
    this.closing = true;
    await this.queue;
    this.closed = true;
  }
}

const LOG_DIR = "C:\\Users\\Norbe\\opencode-fallback-lab\\plugins\\opencode-fallback";
const LOG_FILE = join(LOG_DIR, "opencode-fallback.log");

function modelRef(modelId) {
  return parseModelRef(modelId);
}

function isObservableTransportError(error) {
  const type = String(error?.type || error?.name || "").toLowerCase();
  const code = String(error?.code || error?.cause?.code || "").toLowerCase();
  const status = Number(error?.statusCode ?? error?.status);
  return status === 408
    || type === "provider.transport"
    || type.includes("timeout")
    || /econn(?:reset|refused|aborted)|etimedout|enotfound/.test(code);
}

// Clave de storage para el modelo activo por sesión
const ACTIVE_MODEL_KEY = (sessionID) => `fallback:active_model:${sessionID}`;
const SESSION_STATE_KEY = (sessionID) => `fallback:session_state:${sessionID}`;
const SESSION_STATE_VERSION = 1;
const MAX_SESSION_STATE_ITEMS = 64;
const MAX_CONTEXT_SNAPSHOTS = 128;
const MAX_PROVIDER_BLOCKS = 128;

export default {
  id: "opencode-fallback",
  async setup(ctx) {
    const options = ctx?.options || {};
    const enabled = options.enabled === true;
    const debug = options.debug === true;
    const runtimeVersion = getRuntimeVersion(ctx);
    const chain = normalizeModelChain(options.fallback_models);
    const freeModels = normalizeModelChain(options.free_models);
    const unavailable = normalizeModelChain(options.unavailable_models);
    const effectiveChain = options.free_only === true
      ? chain.valid.filter((modelId) => freeModels.valid.includes(modelId))
      : chain.valid;
    const policyOptions = {
      ...options,
      fallback_models: effectiveChain,
      free_models: freeModels.valid,
      unavailable_models: unavailable.valid,
    };

    // Logger asíncrono
    const logDir = options.logDir || join(ctx.cwd || process.cwd(), "logs");
    const logFile = join(logDir, "opencode-fallback.log");
    const logger = new AsyncLogger(logDir, logFile, options.max_log_bytes);

    function log(message) {
      logger.log(message);
    }

    const freeOnlyConfigInvalid = enabled
      && options.free_only === true
      && (freeModels.valid.length === 0 || effectiveChain.length === 0);

    if (enabled) {
      const compatibility = inspectRuntimeCapabilities(ctx, options);
      if (!compatibility.compatible) {
        log(`PLUGIN INCOMPATIBLE runtimeVersion=${runtimeVersion} missing=${compatibility.missing.join(",")}`);
        return async () => { await logger.close(); };
      }
    }

    const contextSnapshots = new Map();
    const contextOptions = {
      charsPerToken: options.context_chars_per_token,
      safetyRatio: options.context_safety_ratio,
    };

    const activity = new RuntimeActivityTracker({
      maxSessions: MAX_CONTEXT_SNAPSHOTS,
      streamAvailable: options.require_side_effect_guard !== false && typeof ctx?.event?.subscribe === "function",
    });
    let eventController = null;
    let eventTask = null;
    let retryRegistration = null;
    let closing = false;
    let toolRegistration = null;
    const pendingTasks = new Set();
    const pendingAbortControllers = new Set();
    const sessionOverrides = new Map();
    // Shared provider/account quota state for the lifetime of this plugin setup.
    // It is bounded and deliberately not persisted across restarts: a stale
    // provider block must not permanently disable a free provider.
    const providerBlocks = new Map();

    function trackTask(task) {
      const tracked = Promise.resolve(task).catch(() => {});
      pendingTasks.add(tracked);
      tracked.then(() => pendingTasks.delete(tracked), () => pendingTasks.delete(tracked));
      return tracked;
    }

    function rememberContextSnapshot(sessionID, snapshot) {
      if (contextSnapshots.has(sessionID)) contextSnapshots.delete(sessionID);
      contextSnapshots.set(sessionID, snapshot);
      if (contextSnapshots.size > MAX_CONTEXT_SNAPSHOTS) {
        const oldest = contextSnapshots.keys().next().value;
        contextSnapshots.delete(oldest);
      }
    }

    if (debug) {
      log(`SETUP enabled=${enabled} runtimeVersion=${runtimeVersion} options=${JSON.stringify(redactForLog(options))} logDir=${logDir}`);
      if (chain.invalid.length || chain.duplicates.length || freeModels.invalid.length || freeModels.duplicates.length || unavailable.invalid.length || unavailable.duplicates.length) {
        log(`CONFIG normalized invalid=${JSON.stringify(redactForLog({ fallback_models: chain.invalid, free_models: freeModels.invalid, unavailable_models: unavailable.invalid }))} duplicates=${JSON.stringify(redactForLog({ fallback_models: chain.duplicates, free_models: freeModels.duplicates, unavailable_models: unavailable.duplicates }))}`);
      }
    }

    if (!enabled) {
      if (debug) log("PLUGIN DESACTIVADO (enabled: false). No se registran hooks.");
      return async () => { if (debug) log("CLEANUP (inactive)"); await logger.close(); };
    }

    if (freeOnlyConfigInvalid) {
      log("PLUGIN INCOMPATIBLE free_only=true requiere free_models y una cadena con destinos explícitamente gratuitos");
      return async () => { await logger.close(); };
    }

    if (options.require_side_effect_guard !== false && typeof ctx?.event?.subscribe === "function") {
      eventController = new AbortController();
      eventTask = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
            if (closing) break;
            const observed = activity.observe(event);
            const type = event?.type;
            if (debug) {
              const eventSessionID = event?.data?.sessionID || event?.properties?.sessionID;
              log(`EVENT type=${redactDiagnosticText(type, 120)} session=${isSafeIdentifier(eventSessionID) ? eventSessionID : "unknown"}`);
            }
            if (observed && (type === "session.compaction.ended" || type === "session.compaction.completed")) {
              const sessionID = event?.data?.sessionID || event?.properties?.sessionID;
              if (isSafeIdentifier(sessionID)) trackTask(verifyCompactionCompletion(sessionID));
            }
          }
        } catch (error) {
          if (!eventController.signal.aborted) {
            activity.setStreamAvailable(false);
            log(`EVENT STREAM ERROR: ${redactDiagnosticText(error?.message)}`);
          }
        }
      })();
    } else if (options.require_side_effect_guard !== false) {
      activity.setStreamAvailable(false);
      log("EVENT STREAM UNAVAILABLE: fallback fail-closed para evitar reejecución ambigua");
    }

    const policy = new FallbackPolicy(policyOptions);
    const configuredMaxTransitions = Number(options.max_transitions);
    const maxTransitions = Number.isInteger(configuredMaxTransitions) && configuredMaxTransitions > 0
      ? Math.min(configuredMaxTransitions, MAX_SESSION_STATE_ITEMS)
      : Math.min(Math.max(1, policy.chain.length), MAX_SESSION_STATE_ITEMS);

    function emptySessionState() {
      return {
        version: SESSION_STATE_VERSION,
        activeModel: null,
        visitedModels: [],
        transitions: 0,
        handledAttempts: [],
      };
    }

    function normalizeSessionState(value) {
      const state = emptySessionState();
      if (!value || value.version !== SESSION_STATE_VERSION) return state;

      state.activeModel = typeof value.activeModel === "string" && parseModelRef(value.activeModel)
        ? value.activeModel
        : null;
      state.visitedModels = Array.isArray(value.visitedModels)
        ? value.visitedModels.filter((modelId) => typeof modelId === "string" && parseModelRef(modelId)).slice(-MAX_SESSION_STATE_ITEMS)
        : [];
      state.transitions = Number.isInteger(value.transitions) && value.transitions >= 0
        ? Math.min(value.transitions, MAX_SESSION_STATE_ITEMS)
        : 0;
      state.handledAttempts = Array.isArray(value.handledAttempts)
        ? value.handledAttempts
          .filter((key) => isSafeIdentifier(key, 512))
          .slice(-MAX_SESSION_STATE_ITEMS)
        : [];
      return state;
    }

    function remember(list, value) {
      if (!list.includes(value)) list.push(value);
      if (list.length > MAX_SESSION_STATE_ITEMS) list.splice(0, list.length - MAX_SESSION_STATE_ITEMS);
    }

    function providerIdOf(modelId) {
      return parseModelRef(modelId)?.providerID || null;
    }

    function providerCooldownMs() {
      const explicit = Number(options.provider_cooldown_ms);
      if (Number.isFinite(explicit) && explicit >= 0) {
        return Math.min(Math.floor(explicit), 30 * 60 * 1000);
      }
      // A zero model cooldown means "retry this model immediately". It must
      // not turn an explicit provider-wide quota into an immediate retry of
      // the same provider; keep provider scope conservative by default.
      const modelCooldown = Number(options.cooldown_ms);
      return Number.isFinite(modelCooldown) && modelCooldown > 0
        ? Math.min(Math.floor(modelCooldown), 30 * 60 * 1000)
        : 60_000;
    }

    function blockProvider(modelId, classification, now) {
      if (!classification?.blockProvider) return;
      const providerID = providerIdOf(modelId);
      if (!providerID) return;
      const permanent = classification.category === "billing";
      providerBlocks.delete(providerID);
      providerBlocks.set(providerID, {
        providerID,
        permanent,
        blockedUntil: permanent ? 0 : now + providerCooldownMs(),
        reason: classification.category,
      });
      while (providerBlocks.size > MAX_PROVIDER_BLOCKS) {
        providerBlocks.delete(providerBlocks.keys().next().value);
      }
    }

    function activeBlockedProviders(now = Date.now()) {
      const blocked = new Set();
      for (const [providerID, entry] of providerBlocks) {
        if (entry.permanent || now < entry.blockedUntil) {
          blocked.add(providerID);
        } else {
          providerBlocks.delete(providerID);
        }
      }
      return blocked;
    }

    function providerBlockStatus(now = Date.now()) {
      activeBlockedProviders(now);
      return [...providerBlocks.values()].map((entry) => ({ ...entry }));
    }

    async function loadSessionState(sessionID) {
      try {
        const value = await withTimeout(
          () => readStorageJson(ctx.storage, SESSION_STATE_KEY(sessionID), null),
          options.storage_timeout_ms,
        );
        return normalizeSessionState(value);
      } catch {
        return emptySessionState();
      }
    }

    async function saveSessionState(sessionID, state) {
      try {
        return await withTimeout(
          () => writeStorageJson(ctx.storage, SESSION_STATE_KEY(sessionID), state),
          options.storage_timeout_ms,
        );
      } catch {
        return false;
      }
    }

    // Estado persistente de intentos por modelo (ctx.storage).
    async function loadAttempts(sessionID, modelId) {
      try {
        const value = await withTimeout(
          () => readStorageJson(ctx.storage, `fallback:attempts:${sessionID}:${modelId}`, []),
          options.storage_timeout_ms,
        );
        if (!Array.isArray(value)) return [];
        return value
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => ({
            ts: Number.isFinite(entry.ts) ? entry.ts : 0,
            ok: entry.ok === true,
            attempt: normalizeAttempt(entry.attempt),
          }))
          .slice(-MAX_SESSION_STATE_ITEMS);
      } catch { return []; }
    }
    async function saveAttempts(sessionID, modelId, attempts) {
      try {
        return await withTimeout(
          () => writeStorageJson(ctx.storage, `fallback:attempts:${sessionID}:${modelId}`, attempts),
          options.storage_timeout_ms,
        );
      } catch {
        return false;
      }
    }

    // Obtener/guardar modelo activo para una sesión
    async function getActiveModel(sessionID) {
      try {
        const value = await withTimeout(
          () => readStorageJson(ctx.storage, `fallback:active_model:${sessionID}`, null),
          options.storage_timeout_ms,
        );
        return typeof value === "string" && parseModelRef(value) ? value : null;
      } catch { return null; }
    }
    async function setActiveModel(sessionID, modelId) {
      try {
        return await withTimeout(
          () => writeStorageJson(ctx.storage, `fallback:active_model:${sessionID}`, modelId),
          options.storage_timeout_ms,
        );
      } catch {
        return false;
      }
    }

    function getSessionOverride(sessionID) {
      return sessionOverrides.get(sessionID) || null;
    }

    function isSessionEnabled(sessionID) {
      const override = getSessionOverride(sessionID);
      if (override === "enabled") return true;
      if (override === "disabled") return false;
      return enabled;
    }

    function boundedSessionOverride(sessionID, value) {
      if (!isSafeIdentifier(sessionID)) return false;
      if (value === null) sessionOverrides.delete(sessionID);
      else sessionOverrides.set(sessionID, value);
      while (sessionOverrides.size > MAX_CONTEXT_SNAPSHOTS) {
        const oldest = sessionOverrides.keys().next().value;
        sessionOverrides.delete(oldest);
      }
      return true;
    }

    async function controlStatus(sessionID, action) {
      const state = await loadSessionState(sessionID);
      return {
        action,
        sessionID,
        enabled: isSessionEnabled(sessionID),
        globalEnabled: enabled,
        override: getSessionOverride(sessionID),
        currentModel: state.activeModel,
        transitions: state.transitions,
        visitedModels: state.visitedModels,
        fallbackModels: effectiveChain,
        freeOnly: options.free_only === true,
        freeModels: freeModels.valid,
        unavailableModels: unavailable.valid,
        blockedProviders: providerBlockStatus(),
      };
    }

    function controlResponse(value, isError = false) {
      return { content: JSON.stringify(value), ...(isError ? { isError: true } : {}) };
    }

    async function executeSessionControl(input, toolContext) {
      const action = typeof input?.action === "string" ? input.action : "";
      const sessionID = toolContext?.sessionID || toolContext?.sessionId;
      if (!isSafeIdentifier(sessionID)) {
        return controlResponse({ action, enabled: false, error: "sessionID_required" }, true);
      }
      if (!["enable", "disable", "status", "reset"].includes(action)) {
        return controlResponse({ action, error: "invalid_action" }, true);
      }

      if (action === "enable") boundedSessionOverride(sessionID, "enabled");
      if (action === "disable") boundedSessionOverride(sessionID, "disabled");
      if (action === "reset") {
        boundedSessionOverride(sessionID, null);
        const resetState = await saveSessionState(sessionID, emptySessionState());
        const resetModel = await setActiveModel(sessionID, null);
        if (!resetState || !resetModel) {
          return controlResponse({ action, sessionID, error: "storage_unavailable" }, true);
        }
      }
      return controlResponse(await controlStatus(sessionID, action));
    }

    if (typeof ctx?.tool?.transform === "function") {
      try {
        toolRegistration = await ctx.tool.transform((editor) => {
          editor.add({
            name: "model_fallback_control",
            description: "Enable, disable, inspect, or reset model fallback for this session.",
            input: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["enable", "disable", "status", "reset"],
                },
              },
              required: ["action"],
              additionalProperties: false,
            },
            execute: executeSessionControl,
          });
        });
        if (debug) log("SESSION CONTROL registrado");
      } catch (error) {
        if (debug) log(`SESSION CONTROL REGISTRO FALLÓ: ${redactDiagnosticText(error?.message)}`);
      }
    } else if (debug) {
      log("SESSION CONTROL no disponible: ctx.tool.transform ausente; se conserva el modo de configuración");
    }

    const transitionQueues = new Map();

    function enqueueSessionTransition(sessionID, task) {
      const previous = transitionQueues.get(sessionID) || Promise.resolve();
      const current = previous.catch(() => {}).then(task);
      transitionQueues.set(sessionID, current);
      return current.finally(() => {
        if (transitionQueues.get(sessionID) === current) transitionQueues.delete(sessionID);
      });
    }

    let contextRegistration;
    try {
      contextRegistration = await ctx.session.hook("context", async (event) => {
        if (closing) return;
        const sessionID = event?.sessionID;
        const modelId = canonicalModelId(event?.model);
        if (!isSafeIdentifier(sessionID) || !modelId) return;
        if (!isSessionEnabled(sessionID)) {
          if (debug) log(`CONTEXT OMITIDO session=${sessionID} reason=session_disabled`);
          return;
        }

        const revision = activity.beginContext(sessionID);
        const estimate = estimateContext(event, contextOptions);
        rememberContextSnapshot(sessionID, {
          modelId,
          estimate,
          revision,
          capturedAt: Date.now(),
          compactionCompletedAt: activity.snapshot(sessionID)?.compactionCompletedAt || 0,
        });
        if (debug) {
          log(`CONTEXT CAPTURE session=${sessionID} model=${modelId} inputTokens=${estimate.inputTokens} outputTokens=${estimate.outputTokens} overflow=${estimate.overflow}`);
        }
        if (options.compaction_enabled === true && event?.kind !== "compaction") {
          await maybeRequestCompaction(sessionID, modelId, estimate, revision);
        }
      });
    } catch (e) {
      if (debug) log(`CONTEXT HOOK REGISTRO FALLÓ: ${redactDiagnosticText(e.message)}`);
    }

    async function maybeRequestCompaction(sessionID, modelId, estimate, revision) {
      if (closing) return;
      if (!activity.streamAvailable || typeof ctx?.session?.compact !== "function") {
        if (debug) log(`COMPACTION OMITIDA session=${sessionID} reason=runtime_compaction_or_events_unavailable`);
        return;
      }

      const modelMeta = await policy.getModelMeta(modelId, () => ctx.model.list());
      const need = evaluateCompactionNeed(estimate, modelMeta, {
        safetyRatio: options.compaction_threshold_ratio ?? options.context_safety_ratio,
        bufferTokens: options.compaction_buffer_tokens,
      });
      if (debug) log(`COMPACTION CHECK session=${sessionID} model=${modelId} request=${need.request} reason=${need.reason} threshold=${need.threshold}`);
      if (!need.request) return;

      const state = activity.snapshot(sessionID);
      if (
        state?.compactionStatus === "requested"
        || state?.compactionStatus === "running"
        || state?.compactionStatus === "completed_unverified"
      ) return;
      if (state?.compactionStatus === "failed") {
        if (debug) log(`COMPACTION OMITIDA session=${sessionID} reason=previous_compaction_failed`);
        return;
      }
      const requestID = compactionRequestId(sessionID, revision);
      if (!activity.markCompactionRequested(sessionID, revision, requestID)) return;

      try {
        await withTimeout(
          (signal) => ctx.session.compact({
            sessionID,
            id: requestID,
            delivery: "queue",
          }, { signal }),
          options.compaction_admission_timeout_ms,
        );
        if (debug) log(`COMPACTION ADMITIDA session=${sessionID} revision=${revision}`);
      } catch (error) {
        activity.markCompactionRequestFailed(sessionID);
        if (debug) log(`COMPACTION ERROR session=${sessionID} message=${redactDiagnosticText(error?.message)}`);
      }
    }

    function withTimeout(operation, configuredTimeout) {
      const rawTimeout = Number(configuredTimeout);
      const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 100
        ? Math.min(Math.floor(rawTimeout), 30_000)
        : 5_000;
      const controller = new AbortController();
      pendingAbortControllers.add(controller);
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("operation timeout"));
          reject(new Error("operation timeout"));
        }, timeoutMs);
      });
      return Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout])
        .finally(() => {
          clearTimeout(timer);
          pendingAbortControllers.delete(controller);
        });
    }

    async function listModelsBounded() {
      return withTimeout(() => ctx.model.list(), options.model_list_timeout_ms);
    }

    async function verifyCompactionCompletion(sessionID) {
      if (closing) return;
      if (typeof ctx?.session?.context !== "function") {
        activity.markCompactionVerified(sessionID, false);
        if (debug) log(`COMPACTION VERIFY session=${sessionID} status=durable_state_unavailable`);
        return;
      }
      try {
        const expectedID = activity.snapshot(sessionID)?.compactionActiveID
          || activity.snapshot(sessionID)?.compactionRequestID;
        if (!expectedID) {
          activity.markCompactionVerified(sessionID, false);
          if (debug) log(`COMPACTION VERIFY session=${sessionID} status=correlation_unavailable`);
          return;
        }
        const history = await withTimeout(
          (signal) => ctx.session.context({ sessionID }, { signal }),
          options.compaction_status_timeout_ms,
        );
        const messages = Array.isArray(history)
          ? history
          : Array.isArray(history?.data)
            ? history.data
            : [];
        const compaction = [...messages].reverse().find((message) => message?.type === "compaction");
        const durableID = compaction?.id || compaction?.messageID;
        if (durableID !== expectedID) {
          activity.markCompactionVerified(sessionID, false);
          if (debug) log(`COMPACTION VERIFY session=${sessionID} status=correlation_mismatch`);
          return;
        }
        const status = compaction?.status || compaction?.payload?.status;
        activity.markCompactionVerified(sessionID, status === "completed");
        if (debug) log(`COMPACTION VERIFY session=${sessionID} status=${status || "unknown"}`);
      } catch (error) {
        activity.markCompactionVerified(sessionID, false);
        if (debug) log(`COMPACTION VERIFY ERROR session=${sessionID} message=${redactDiagnosticText(error?.message)}`);
      }
    }

    async function handleRetry(event) {
        const now = Date.now();
        const sessionID = event?.sessionID;
        const currentModel = event?.model;
        const error = event?.error || {};
        const attempt = normalizeAttempt(event?.attempt);
        const decision = event?.decision;
        if (!decision || typeof decision !== "object") {
          if (debug) log("DECISION retry=false (evento sin decision mutable)");
          return;
        }

        if (!isSafeIdentifier(sessionID)) {
          if (debug) log("DECISION retry=false (sessionID ausente)");
          decision.retry = false;
          return;
        }

        if (!isSessionEnabled(sessionID)) {
          if (debug) log(`DECISION sin cambios (session_disabled) session=${sessionID}`);
          return;
        }

        const sessionState = await loadSessionState(sessionID);
        // The policy's cooldown/attempt state is scoped to this session. The
        // model metadata cache remains shared, but failures in one session
        // must never make a destination unavailable in another session.
        const decisionPolicy = new FallbackPolicy(policyOptions);
        const classification = decisionPolicy.classifyError(error);

        // Determinar el modelo ACTUAL: usar el guardado en storage, o fallback a event.model
        const observedModelId = canonicalModelId(currentModel);
        let currentId = observedModelId || sessionState.activeModel || await getActiveModel(sessionID);
        if (!currentId) {
          // Primera vez: usar event.model o primer modelo de la cadena
          if (observedModelId) {
            currentId = observedModelId;
          } else if (policy.chain.length > 0) {
            currentId = policy.chain[0];
          }
          // Guardar como modelo activo inicial
          if (currentId) {
            sessionState.activeModel = currentId;
            remember(sessionState.visitedModels, currentId);
            if (!await setActiveModel(sessionID, currentId)) {
              if (debug) log("DECISION retry=false (storage no disponible al fijar modelo activo)");
              decision.retry = false;
              return;
            }
          }
        } else {
          sessionState.activeModel = currentId;
          remember(sessionState.visitedModels, currentId);
        }

        if (!await saveSessionState(sessionID, sessionState)) {
          if (debug) log("DECISION retry=false (storage no disponible al guardar estado)");
          decision.retry = false;
          return;
        }

        if (debug) {
          log(`RETRY session=${sessionID} activeModel=${currentId} eventModel=${observedModelId || "unknown"} attempt=${attempt} status=${error.statusCode ?? error.status} type=${error.type} category=${classification.category} scope=${classification.scope} message_present=${Boolean(error.message)}`);
        }

        // 1. Errores permanentes: nunca fallback.
        if (decisionPolicy.isPermanentError(error)) {
          if (debug) log(`DECISION retry=false (error permanente: ${error.statusCode ?? error.status})`);
          decision.retry = false;
          return;
        }

        // 2. Error no recuperable: no fallback.
        if (!classification.recoverable && !isObservableTransportError(error)) {
          if (debug) log(`DECISION retry=false (no recuperable)`);
          decision.retry = false;
          return;
        }

        // A transport error after an HTTP 2xx response may mean that the
        // provider already emitted part of a stream. The runtime can deliver
        // this retry event before ctx.event publishes the corresponding text
        // delta, so the absence of a partial-output event is not evidence of
        // safety. Fail closed for this ambiguous boundary; a transport
        // failure without an HTTP response remains eligible for fallback.
        const transportStatus = Number(error.statusCode ?? error.status);
        if (error.type === "provider.transport" && transportStatus >= 200 && transportStatus < 300) {
          if (debug) log("DECISION retry=false (side effect guard: ambiguous_stream_transport)");
          decision.retry = false;
          return;
        }

        if (options.require_side_effect_guard !== false) {
          const activityCheck = activity.canRetry(sessionID);
          if (!activityCheck.allow) {
            if (debug) log(`DECISION retry=false (side effect guard: ${activityCheck.reason})`);
            decision.retry = false;
            return;
          }
        }

        blockProvider(currentId, classification, now);
        if (debug && classification.blockProvider) {
          log(`PROVIDER BLOCK provider=${providerIdOf(currentId) || "unknown"} category=${classification.category} permanent=${classification.category === "billing"}`);
        }

        const attemptKey = `${observedModelId || currentId || "unknown"}:${attempt}`;
        if (sessionState.handledAttempts.includes(attemptKey)) {
          if (debug) log(`DECISION retry=false (intento duplicado: ${attemptKey})`);
          decision.retry = false;
          return;
        }
        remember(sessionState.handledAttempts, attemptKey);

        if (currentId) {
          const attempts = await loadAttempts(sessionID, currentId);
          for (const entry of attempts) decisionPolicy.recordAttempt(currentId, entry.ok, entry.ts);
          decisionPolicy.recordAttempt(currentId, false, now);
          attempts.push({ ts: now, ok: false, attempt });
          if (attempts.length > MAX_SESSION_STATE_ITEMS) attempts.splice(0, attempts.length - MAX_SESSION_STATE_ITEMS);
          if (!await saveAttempts(sessionID, currentId, attempts)) {
            if (debug) log("DECISION retry=false (storage no disponible al guardar intentos)");
            decision.retry = false;
            return;
          }
        }

        if (sessionState.transitions >= maxTransitions) {
          await saveSessionState(sessionID, sessionState);
          if (debug) log(`DECISION retry=false (presupuesto de transiciones agotado: ${maxTransitions})`);
          decision.retry = false;
          return;
        }

        // 3. Límite de intentos del modelo actual agotado: no reintentar con el mismo,
        // pero permitir que selectNext busque el siguiente disponible.
        if (decisionPolicy.attemptsExceeded(currentId, now)) {
          if (debug) log(`MODELO AGOTADO: ${currentId} (max_attempts=${decisionPolicy.maxAttempts}), buscando siguiente...`);
        }

        // 4. Seleccionar siguiente modelo de la cadena respetando cooldown y agotamiento.
        const candidateVisited = new Set(sessionState.visitedModels);
        let nextId = null;
        while (true) {
          const candidate = decisionPolicy.selectNext(
            currentId,
            now,
            candidateVisited,
            { blockedProviders: activeBlockedProviders(now) },
          );
          if (!candidate) break;
          candidateVisited.add(candidate);
          const freeCheck = await decisionPolicy.canUseModel(candidate, listModelsBounded);
          if (freeCheck.allow) {
            nextId = candidate;
            break;
          }
          if (debug) log(`DESTINO OMITIDO model=${candidate} reason=${freeCheck.reason}`);
        }
        if (!nextId) {
          await saveSessionState(sessionID, sessionState);
          if (debug) log(`DECISION retry=false (cadena agotada: no quedan modelos disponibles)`);
          decision.retry = false;
          return;
        }

        // 5. PROTECCIÓN CONSERVADORA DE CONTEXTO (Fase 11)
        // Verificar si el modelo destino tiene contexto suficiente antes de cambiar.
        const contextCheck = await decisionPolicy.canSafelySwitch(currentId, nextId, listModelsBounded);
        if (debug) log(`CONTEXT CHECK: current=${currentId} next=${nextId} allow=${contextCheck.allow} reason=${contextCheck.reason} meta=${JSON.stringify(contextCheck.meta)}`);
        if (!contextCheck.allow) {
          if (debug) log(`DECISION retry=false (contexto insuficiente: ${contextCheck.reason})`);
          decision.retry = false;
          return;
        }

        if (options.require_context_check !== false) {
          const snapshot = contextSnapshots.get(sessionID);
          const snapshotMatchesModel = snapshot?.modelId === (observedModelId || currentId);
          if (!snapshot || !snapshotMatchesModel) {
            if (options.allow_unknown_context === true) {
              if (debug) log("CONTEXT CHECK: snapshot ausente o stale; permitido por allow_unknown_context");
            } else {
              if (debug) log("DECISION retry=false (snapshot de contexto ausente o stale)");
              decision.retry = false;
              return;
            }
          } else {
            const nextMeta = await decisionPolicy.getModelMeta(nextId, listModelsBounded);
            const fit = evaluateContextFit(snapshot.estimate, nextMeta, contextOptions);
            if (debug) log(`CONTEXT FIT: current=${currentId} next=${nextId} allow=${fit.allow} reason=${fit.reason} meta=${JSON.stringify(fit.meta)}`);
            if (!fit.allow) {
              const activityState = activity.snapshot(sessionID);
              const compactionNeedsFreshMeasurement = activityState && (
                activityState.compactionStatus === "requested"
                || activityState.compactionStatus === "running"
                || activityState.compactionStatus === "completed_unverified"
                || activityState.compactionStatus === "failed"
                || activityState.compactionCompletedAt > (snapshot.capturedAt || 0)
              );
              if (compactionNeedsFreshMeasurement) {
                if (debug) log(`DECISION retry=false (compaction no confirmada o medición stale: ${activityState.compactionStatus})`);
                decision.retry = false;
                return;
              }
              if (options.allow_unknown_context === true && fit.reason === "destination_context_unknown") {
                if (debug) log("CONTEXT FIT: destino desconocido permitido por allow_unknown_context");
              } else {
                if (debug) log(`DECISION retry=false (request no cabe: ${fit.reason})`);
                decision.retry = false;
                return;
              }
            }
          }
        }

        // 6. Cambiar modelo para el siguiente intento.
        try {
          const nextModel = modelRef(nextId);
          if (!nextModel) throw new Error(`referencia de modelo inválida: ${nextId}`);
          await withTimeout(
            (signal) => ctx.session.switchModel({ sessionID, model: nextModel }, { signal }),
            options.switch_model_timeout_ms,
          );
          // Guardar el nuevo modelo activo
          if (!await setActiveModel(sessionID, nextId)) throw new Error("storage unavailable");
          sessionState.activeModel = nextId;
          remember(sessionState.visitedModels, nextId);
          sessionState.transitions += 1;
          if (!await saveSessionState(sessionID, sessionState)) throw new Error("storage unavailable");
          if (debug) log(`SWITCHMODEL -> ${nextId} (guardado como activo)`);
        } catch (e) {
          if (debug) log(`SWITCHMODEL ERROR: ${redactDiagnosticText(e.message)}`);
          decision.retry = false;
          return;
        }

        // 7. Permitir reintento con el nuevo modelo, sin demora adicional.
        decision.retry = true;
        decision.delay = 0;
        if (debug) log(`DECISION retry=true delay=0 -> ${nextId}`);
    }

    // Registrar hook de reintento (evidencia Fase 7: existe en runtime v2.1.3).
    try {
      retryRegistration = await ctx.session.hook("retry", async (event) => {
        const sessionID = event?.sessionID;
        if (!isSafeIdentifier(sessionID)) return handleRetry(event);
        return enqueueSessionTransition(sessionID, () => handleRetry(event));
      });

      if (debug) log("HOOK retry registrado");
    } catch (e) {
      log(`HOOK retry REGISTRO FALLÓ: ${redactDiagnosticText(e.message)}`);
    }

    return async () => {
      closing = true;
      if (debug) log("CLEANUP");
      if (eventController) eventController.abort();
      for (const controller of pendingAbortControllers) controller.abort(new Error("plugin cleanup"));
      if (eventTask) await eventTask.catch(() => {});
      await Promise.all([...pendingTasks]);
      contextSnapshots.clear();
      activity.clear();
      sessionOverrides.clear();
      providerBlocks.clear();
      if (retryRegistration?.dispose) await retryRegistration.dispose();
      if (contextRegistration?.dispose) await contextRegistration.dispose();
      if (toolRegistration?.dispose) await toolRegistration.dispose();
      await logger.close();
    };
  },
};

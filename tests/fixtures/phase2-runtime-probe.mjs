import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

function idOf(value) {
  if (typeof value === "string") return value.slice(0, 160);
  if (!value || typeof value !== "object") return undefined;
  const providerID = typeof value.providerID === "string" ? value.providerID : undefined;
  const modelID = typeof value.id === "string" ? value.id : undefined;
  if (providerID && modelID) return `${providerID}/${modelID}`;
  return undefined;
}

function safeStatus(value) {
  if (typeof value === "string" && value.length <= 80) return value;
  return undefined;
}

function modelSummary(model) {
  const ref = idOf(model);
  return ref ? { ref } : undefined;
}

function contextSummary(event) {
  return {
    kind: "hook-context",
    sessionID: idOf(event?.sessionID),
    requestKind: safeStatus(event?.kind),
    model: modelSummary(event?.model),
    keys: Object.keys(event || {}).sort(),
    systemItems: Array.isArray(event?.system) ? event.system.length : undefined,
    messageItems: Array.isArray(event?.messages) ? event.messages.length : undefined,
    toolNames: event?.tools && typeof event.tools === "object" ? Object.keys(event.tools).sort() : [],
    optionNames: event?.options && typeof event.options === "object" ? Object.keys(event.options).sort() : [],
  };
}

function compactionSummary(event) {
  return {
    kind: "hook-compaction",
    sessionID: idOf(event?.sessionID),
    requestKind: safeStatus(event?.kind),
    model: modelSummary(event?.model),
    keys: Object.keys(event || {}).sort(),
    messageItems: Array.isArray(event?.messages) ? event.messages.length : undefined,
    resultAlreadySet: event?.result !== undefined,
  };
}

function retrySummary(event) {
  return {
    kind: "hook-retry",
    sessionID: idOf(event?.sessionID),
    model: modelSummary(event?.model),
    attempt: Number.isFinite(event?.attempt) ? event.attempt : undefined,
    errorKeys: event?.error && typeof event.error === "object" ? Object.keys(event.error).sort() : [],
    decisionKeys: event?.decision && typeof event.decision === "object" ? Object.keys(event.decision).sort() : [],
  };
}

function eventSummary(event) {
  const properties = event?.data && typeof event.data === "object"
    ? event.data
    : event?.properties && typeof event.properties === "object"
      ? event.properties
      : {};
  const part = properties.part && typeof properties.part === "object" ? properties.part : undefined;
  const state = part?.state && typeof part.state === "object" ? part.state : undefined;

  return {
    kind: "server-event",
    type: safeStatus(event?.type),
    topLevelKeys: Object.keys(event || {}).sort(),
    dataKeys: Object.keys(properties).sort(),
    sessionID: idOf(properties.sessionID),
    messageID: idOf(properties.messageID),
    status: safeStatus(properties.status ?? state?.status),
    partType: safeStatus(part?.type),
    partStateKeys: state ? Object.keys(state).sort() : [],
  };
}

export default {
  id: "phase2-runtime-probe",
  async setup(ctx) {
    const logFile = ctx?.options?.log_file;
    if (typeof logFile !== "string" || logFile.length === 0) {
      throw new Error("phase2-runtime-probe requires options.log_file");
    }

    let writeChain = Promise.resolve();
    const write = (record) => {
      writeChain = writeChain.then(async () => {
        await mkdir(dirname(logFile), { recursive: true });
        await appendFile(logFile, `${JSON.stringify({
          at: new Date().toISOString(),
          runtime: ctx?.app?.version,
          ...record,
        })}\n`);
      });
      return writeChain.catch(() => {});
    };

    await write({ kind: "setup", contextKeys: Object.keys(ctx || {}).sort() });

    const registrations = [];
    registrations.push(await ctx.session.hook("context", (event) => {
      void write(contextSummary(event));
    }));
    registrations.push(await ctx.session.hook("compaction", (event) => {
      void write(compactionSummary(event));
    }));
    registrations.push(await ctx.session.hook("retry", (event) => {
      void write(retrySummary(event));
    }));

    if (ctx?.options?.register_tool === true) {
      registrations.push(await ctx.tool.transform((editor) => {
        editor.add({
          name: "phase2_probe_tool",
          description: "Local-only probe tool used to observe tool lifecycle events.",
          input: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          async execute(input, toolContext) {
            await write({
              kind: "tool-execute",
              inputKeys: Object.keys(input || {}).sort(),
              aborted: Boolean(toolContext?.signal?.aborted),
            });
            return { content: "phase2 probe tool completed" };
          },
        });
      }));
      const availableTools = await ctx.tool.list();
      await write({
        kind: "tool-list",
        names: availableTools.map((tool) => tool?.id).filter((id) => typeof id === "string").sort(),
      });
    }

    const controller = new AbortController();
    const eventTask = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await write(eventSummary(event));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          await write({ kind: "event-stream-error", errorType: error?.name, errorMessagePresent: Boolean(error?.message) });
        }
      }
    })();

    return async () => {
      controller.abort();
      await eventTask.catch(() => {});
      for (const registration of registrations.reverse()) {
        await registration?.dispose?.();
      }
      await write({ kind: "cleanup" });
      await writeChain;
    };
  },
};

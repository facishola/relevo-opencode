const DEFAULT_MAX_SESSIONS = 128;

function payloadOf(event) {
  return event?.data && typeof event.data === "object"
    ? event.data
    : event?.properties && typeof event.properties === "object"
      ? event.properties
      : {};
}

function sessionIdOf(event, data = payloadOf(event)) {
  const value = data.sessionID ?? data.sessionId ?? event?.sessionID ?? event?.sessionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function newState(sessionID) {
  return {
    sessionID,
    observedEvents: 0,
    lastEventAt: 0,
    contextRevision: 0,
    compactionStatus: "idle",
    compactionStartedAt: 0,
    compactionCompletedAt: 0,
    compactionFailedAt: 0,
    compactionRequestRevision: 0,
    compactionRequestID: null,
    compactionActiveID: null,
    partialOutput: false,
    toolActivity: false,
    ambiguousStream: false,
    stepStarted: false,
  };
}

export class RuntimeActivityTracker {
  constructor({ maxSessions = DEFAULT_MAX_SESSIONS, streamAvailable = false } = {}) {
    this.maxSessions = Number.isInteger(maxSessions) && maxSessions > 0
      ? Math.min(maxSessions, DEFAULT_MAX_SESSIONS)
      : DEFAULT_MAX_SESSIONS;
    this.streamAvailable = streamAvailable === true;
    this.states = new Map();
  }

  setStreamAvailable(value) {
    this.streamAvailable = value === true;
  }

  ensure(sessionID) {
    let state = this.states.get(sessionID);
    if (!state) {
      state = newState(sessionID);
      this.states.set(sessionID, state);
      if (this.states.size > this.maxSessions) {
        const oldest = this.states.keys().next().value;
        this.states.delete(oldest);
      }
    }
    return state;
  }

  beginContext(sessionID) {
    const state = this.ensure(sessionID);
    state.contextRevision += 1;
    return state.contextRevision;
  }

  observe(event) {
    const type = typeof event?.type === "string" ? event.type : "";
    const data = payloadOf(event);
    const sessionID = sessionIdOf(event, data);
    if (!sessionID) return false;

    const state = this.ensure(sessionID);
    state.observedEvents += 1;
    state.lastEventAt = Date.now();

    if (type === "session.step.started") {
      state.stepStarted = true;
      state.partialOutput = false;
      state.toolActivity = false;
      state.ambiguousStream = false;
      return true;
    }

    if (type === "session.text.started" || type === "session.text.delta" || type === "session.text.ended") {
      state.partialOutput = true;
      return true;
    }

    if (
      type === "session.tool.input.started"
      || type === "session.tool.input.ended"
      || type === "session.tool.called"
      || type === "session.tool.progress"
      || type === "session.tool.success"
      || type === "session.tool.error"
    ) {
      state.toolActivity = true;
      return true;
    }

    if (type === "session.step.streamed" && !state.partialOutput && !state.toolActivity) {
      state.ambiguousStream = true;
      return true;
    }

    if (type === "session.compaction.started") {
      const inputID = typeof data.inputID === "string" ? data.inputID : null;
      if (state.compactionStatus !== "requested"
        || !state.compactionRequestID
        || !inputID
        || inputID !== state.compactionRequestID) return false;
      state.compactionActiveID = inputID;
      state.compactionStatus = "running";
      state.compactionStartedAt = Date.now();
      return true;
    }

    if (type === "session.compaction.ended" || type === "session.compaction.completed") {
      const inputID = typeof data.inputID === "string" ? data.inputID : null;
      if (!state.compactionActiveID || (inputID && inputID !== state.compactionActiveID)) return false;
      state.compactionStatus = "completed_unverified";
      state.compactionCompletedAt = 0;
      return true;
    }

    if (type === "session.compaction.failed") {
      const inputID = typeof data.inputID === "string" ? data.inputID : null;
      if (!state.compactionActiveID || (inputID && inputID !== state.compactionActiveID)) return false;
      state.compactionStatus = "failed";
      state.compactionFailedAt = Date.now();
      return true;
    }

    return true;
  }

  markCompactionRequested(sessionID, revision = 0, requestID = null) {
    const state = this.ensure(sessionID);
    if (state.compactionStatus === "running" || state.compactionStatus === "requested") return false;
    if (revision > 0 && state.compactionRequestRevision === revision) return false;
    if (typeof requestID !== "string" || requestID.length === 0) return false;
    state.compactionStatus = "requested";
    state.compactionRequestRevision = revision;
    state.compactionRequestID = requestID;
    state.compactionActiveID = null;
    state.compactionStartedAt = 0;
    state.compactionCompletedAt = 0;
    state.compactionFailedAt = 0;
    return true;
  }

  markCompactionRequestFailed(sessionID) {
    const state = this.ensure(sessionID);
    state.compactionStatus = "failed";
    state.compactionActiveID = null;
    state.compactionFailedAt = Date.now();
  }

  markCompactionVerified(sessionID, verified) {
    const state = this.ensure(sessionID);
    if (verified === true) {
      state.compactionStatus = "completed";
      state.compactionCompletedAt = Date.now();
      state.compactionFailedAt = 0;
      state.compactionActiveID = null;
      return;
    }
    state.compactionStatus = "failed";
    state.compactionActiveID = null;
    state.compactionFailedAt = Date.now();
  }

  snapshot(sessionID) {
    const state = this.states.get(sessionID);
    return state ? { ...state } : null;
  }

  canRetry(sessionID) {
    if (!this.streamAvailable) {
      return { allow: false, reason: "runtime_event_stream_unavailable" };
    }
    const state = this.states.get(sessionID);
    if (!state || state.observedEvents === 0) {
      return { allow: false, reason: "session_activity_unknown" };
    }
    if (state.partialOutput) {
      return { allow: false, reason: "partial_output_observed" };
    }
    if (state.toolActivity) {
      return { allow: false, reason: "tool_activity_observed" };
    }
    if (state.ambiguousStream) {
      return { allow: false, reason: "ambiguous_stream_observed" };
    }
    if (!state.stepStarted) {
      if (state.contextRevision > 0) {
        return { allow: true, reason: "context_snapshot_before_step_event" };
      }
      return { allow: false, reason: "session_activity_unknown" };
    }
    return { allow: true, reason: "no_partial_side_effect_observed" };
  }

  clear() {
    this.states.clear();
  }
}


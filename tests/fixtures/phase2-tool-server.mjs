import http from "node:http";

const port = Number(process.env.MOCK_PORT || 9150);
let requestCount = 0;
let toolCallSent = false;

function sendChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendToolCall(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sendChunk(res, {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_phase2_probe",
          type: "function",
          function: {
            name: "shell",
            arguments: JSON.stringify({ command: "Write-Output phase2-tool-probe", description: "local-only probe" }),
          },
        }],
      },
    }],
  });
  sendChunk(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendFinal(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sendChunk(res, { choices: [{ delta: { content: "TOOL_PROBE_COMPLETE" } }] });
  sendChunk(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requestCount += 1;
      let parsed;
      try { parsed = JSON.parse(body); } catch {}
      const toolNames = Array.isArray(parsed?.tools)
        ? parsed.tools.map((tool) => tool?.function?.name || tool?.name).filter(Boolean)
        : [];
      console.log(`[PHASE2-TOOL] request=${requestCount} tools=${toolNames.join(",")}`);
      if (toolNames.includes("shell") && !toolCallSent) {
        toolCallSent = true;
        sendToolCall(res);
      }
      else sendFinal(res);
    });
    return;
  }

  if (req.url === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "m-a", object: "model", owned_by: "phase2-tool" }] }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

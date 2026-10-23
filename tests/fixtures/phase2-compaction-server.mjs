import http from "node:http";

const port = Number(process.env.MOCK_PORT || 9149);
const summary = [
  "## Objective",
  "Complete the isolated OpenCode runtime probe.",
  "",
  "## Requirements",
  "- Preserve the session objective and continue local validation.",
  "",
  "## Decisions",
  "- Use only loopback fixtures and fail closed on unknown state.",
  "",
  "## Completed",
  "- Captured context and compaction lifecycle events.",
  "",
  "## Active Work",
  "- Validate the completed compaction marker.",
  "",
  "## Blockers",
  "- None.",
  "",
  "## Next Move",
  "- Continue with local context and fallback tests.",
  "",
  "## Relevant Files",
  "- None.",
].join("\n");

function sendStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const chunks = summary.match(/.{1,80}(?:\s|$)/g) || [summary];
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    req.resume();
    req.on("end", () => sendStream(res));
    return;
  }

  if (req.url === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [{ id: "m-a", object: "model", owned_by: "phase2-compaction" }],
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

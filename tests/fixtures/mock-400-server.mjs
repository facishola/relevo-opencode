import http from "node:http";

const port = Number(process.env.PHASE0_400_PORT || 9129);
let completionRequests = 0;

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      completionRequests += 1;
      let model = "unknown";
      try { model = JSON.parse(body).model || model; } catch {}
      console.log(`[Phase0 Mock 400] Request #${completionRequests} model=${model}`);
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "Bad Request",
          type: "bad_request_error",
          code: "invalid_request",
        },
      }));
      return;
    }

    if (request.url === "/v1/models" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: "m-a", object: "model", owned_by: "phase0-mock" }],
      }));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Not found" } }));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[Phase0 Mock 400] Listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

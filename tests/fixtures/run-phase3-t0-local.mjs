import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LAB = "C:/Users/Norbe/opencode-fallback-lab";
const ROOT = `${LAB}/plugins/opencode-fallback`;
const NODE = "C:/Program Files/nodejs/node.exe";
const OPENCODE = "C:/Users/Norbe/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe";
const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
const XDG = `${LAB}/xdg-iso/t0-${stamp}`;
const CONFIG_DIR = `${XDG}/config/opencode`;
const DATA_DIR = `${XDG}/data`;
const CACHE_DIR = `${XDG}/cache`;
const STATE_DIR = `${XDG}/state`;
const LOG_DIR = `${ROOT}/tests/fixtures/phase3-t0-runtime/logs`;
const CONFIG_FILE = `${CONFIG_DIR}/opencode.jsonc`;
const MOCK = `${LAB}/xdg-iso/mocks/mock-flexible.js`;
const PORTS = [9129, 9130, 9131];

const config = {
  $schema: "https://opencode.ai/config.json",
  model: "mocka/m-a",
  share: "disabled",
  providers: {
    mocka: {
      name: "Mock A",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:9129/v1", apiKey: "test" },
      models: { "m-a": { name: "Mock A", limit: { context: 32768, output: 8192 } } },
    },
    mockb: {
      name: "Mock B",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:9130/v1", apiKey: "test" },
      models: { "m-b": { name: "Mock B", limit: { context: 32768, output: 8192 } },
      },
    },
    mockc: {
      name: "Mock C",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { baseURL: "http://127.0.0.1:9131/v1", apiKey: "test" },
      models: { "m-c": { name: "Mock C", limit: { context: 32768, output: 8192 } },
      },
    },
  },
  plugins: [{
    package: ROOT,
    options: {
      enabled: true,
      fallback_models: ["mocka/m-a", "mockb/m-b", "mockc/m-c"],
      retry_on_errors: [429, 500, 502, 503, 504],
      max_attempts: 3,
      max_transitions: 2,
      cooldown_ms: 0,
      context_safety_ratio: 0.8,
      require_context_check: true,
      allow_unknown_context: false,
      require_side_effect_guard: true,
      compaction_enabled: false,
      debug: true,
      logDir: LOG_DIR,
    },
  }],
};

function baseEnv() {
  return {
    ...process.env,
    OPENCODE_CONFIG_DIR: CONFIG_DIR,
    XDG_CONFIG_HOME: `${XDG}/config`,
    XDG_DATA_HOME: DATA_DIR,
    XDG_CACHE_HOME: CACHE_DIR,
    XDG_STATE_HOME: STATE_DIR,
    OPENCODE_PASSWORD: `phase3-t0-${stamp}`,
  };
}

function captureProcess(file, args, env) {
  const child = spawn(file, args, {
    cwd: ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr?.on("data", (chunk) => stderr.push(chunk));
  child.output = () => ({
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  });
  return child;
}

async function stopTree(child) {
  if (!child?.pid) return;
  try {
    await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } catch {
    if (!child.killed) child.kill();
  }
}

async function waitForPort(port, timeoutMs = 20_000) {
  const net = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`port ${port} did not open`);
}

async function runOpenCode(label) {
  const child = captureProcess(
    OPENCODE,
    ["run", "--standalone", "--model", "mocka/m-a", `T0 baseline ${label}`],
    baseEnv(),
  );
  const result = await new Promise((resolve) => {
    const timer = setTimeout(async () => {
      await stopTree(child);
      resolve({ label, code: null, timeout: true, ...child.output() });
    }, 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ label, code, timeout: false, ...child.output() });
    });
  });
  return result;
}

await mkdir(CONFIG_DIR, { recursive: true });
await mkdir(LOG_DIR, { recursive: true });
await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);

const mocks = PORTS.map((port) => captureProcess(NODE, [MOCK], {
  ...baseEnv(),
  MOCK_TEST: "T0",
  MOCK_PORT: String(port),
}));

try {
  await Promise.all(PORTS.map((port) => waitForPort(port)));
  const runs = [await runOpenCode("one")];
  await new Promise((resolve) => setTimeout(resolve, 500));
  const mockOutput = mocks.map((mock) => mock.output());
  const pluginLog = await readFile(`${LOG_DIR}/opencode-fallback.log`, "utf8").catch(() => "");
  const posts = Object.fromEntries(PORTS.map((port, index) => [
    String(port), (mockOutput[index].stdout.match(/POST \/v1\/chat\/completions/g) || []).length,
  ]));
  const pass = runs.every((run) => run.code === 0 && !run.timeout)
    && posts["9129"] === 2
    && posts["9130"] === 0
    && posts["9131"] === 0
    && /HOOK retry registrado/.test(pluginLog)
    && /CONTEXT CAPTURE/.test(pluginLog);
  console.log(JSON.stringify({ pass, stamp, posts, runs, hookEvidence: {
    retryRegistered: /HOOK retry registrado/.test(pluginLog),
    contextCaptured: /CONTEXT CAPTURE/.test(pluginLog),
  }, mockOutput }, null, 2));
  process.exitCode = pass ? 0 : 1;
} finally {
  for (const mock of mocks.reverse()) await stopTree(mock);
}

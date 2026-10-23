import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCENARIO = process.env.PHASE3_SCENARIO || "T1";
const SCENARIO_LABEL = SCENARIO.toLowerCase();
const SERVER_PORT = Number(process.env.PHASE3_SERVER_PORT || 28900);

const LAB = "C:\\Users\\Norbe\\opencode-fallback-lab";
const ROOT = "C:\\Users\\Norbe\\opencode-fallback-lab\\plugins\\opencode-fallback";
const XDG = join(LAB, "xdg-iso");
const LOGS = join(XDG, "logs");
const CONFIG_SOURCE = join(ROOT, "tests", "fixtures", "phase3-t1-config", "opencode.jsonc");
const CONFIG_DEST = join(XDG, "config", "opencode", "opencode.jsonc");
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const OPENCODE = "C:\\Users\\Norbe\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe";
const names = ["mocka", "mockb", "mockc"];
const ports = [9129, 9130, 9131];
const PLUGIN_LOG = join(ROOT, "tests", "fixtures", "phase3-t1-runtime", "logs", "opencode-fallback.log");

function start(file, args, env, outFile) {
  const child = spawn(file, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  child.output = async () => {
    const text = child.readOutput();
    await import("node:fs/promises").then(({ writeFile }) => writeFile(outFile, text));
    return text;
  };
  child.readOutput = () => Buffer.concat(chunks).toString("utf8");
  child.closed = new Promise((resolve) => child.once("close", resolve));
  return child;
}

async function stopTree(child) {
  if (!child?.pid) return;
  try {
    await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } catch {
    if (!child.killed) child.kill();
  }
  await Promise.race([
    child.closed || Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`port ${port} did not open`);
}

async function waitForPluginEvidence(offset, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(PLUGIN_LOG, "utf8").catch(() => "");
    const delta = text.slice(offset);
    const ready = SCENARIO === "T2"
      ? /DECISION retry=false \(error permanente: 400\)/.test(delta)
      : /SWITCHMODEL -> mockb\/m-b/.test(delta) && /DECISION retry=true/.test(delta);
    if (ready) return delta;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const text = await readFile(PLUGIN_LOG, "utf8").catch(() => "");
  return text.slice(offset);
}

await mkdir(LOGS, { recursive: true });
await mkdir(join(XDG, "config", "opencode"), { recursive: true });
await writeFile(CONFIG_DEST, await readFile(CONFIG_SOURCE));
const initialPluginLog = await readFile(PLUGIN_LOG, "utf8").catch(() => "");
const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
const children = [];
try {
  console.log(`starting mocks and server ${stamp}`);
  for (let index = 0; index < names.length; index += 1) {
    children.push(start(
      NODE,
      [join(XDG, "mocks", "mock-flexible.js")],
      { MOCK_TEST: SCENARIO, MOCK_PORT: String(ports[index]) },
      join(LOGS, `phase3_${SCENARIO_LABEL}_${names[index]}_${stamp}.out`),
    ));
  }
  const server = start(
    OPENCODE,
    ["serve", "--port", String(SERVER_PORT), "--hostname", "127.0.0.1"],
    {
      XDG_CONFIG_HOME: join(XDG, "config"),
      OPENCODE_CONFIG_DIR: join(XDG, "config", "opencode"),
      XDG_DATA_HOME: join(XDG, "data"),
      XDG_CACHE_HOME: join(XDG, "cache"),
      XDG_STATE_HOME: join(XDG, "state"),
      OPENCODE_PASSWORD: "phase3-t1-local-password",
    },
    join(LOGS, `phase3_${SCENARIO_LABEL}_server_${stamp}.out`),
  );
  children.push(server);
  console.log("waiting for local listeners");
  await Promise.all([SERVER_PORT, ...ports].map((port) => waitForPort(port)));
  console.log(`local listeners ready; running ${SCENARIO}`);

  const result = await new Promise((resolve) => {
    const child = spawn(OPENCODE, ["run", "--server", `http://127.0.0.1:${SERVER_PORT}`, "--model", "mocka/m-a", `Test Phase3 ${SCENARIO}: fallback`], {
      cwd: ROOT,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(XDG, "config"),
        OPENCODE_CONFIG_DIR: join(XDG, "config", "opencode"),
        XDG_DATA_HOME: join(XDG, "data"),
        XDG_CACHE_HOME: join(XDG, "cache"),
        XDG_STATE_HOME: join(XDG, "state"),
        OPENCODE_PASSWORD: "phase3-t1-local-password",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    setTimeout(() => { void stopTree(child); }, 60_000).unref();
  });

  const mockLogs = children.slice(0, names.length).map((child, index) => ({
    name: names[index],
    text: child.readOutput(),
  }));
  const pluginLog = await waitForPluginEvidence(initialPluginLog.length);
  const posts = Object.fromEntries(mockLogs.map(({ name, text }) => [
    name,
    (text.match(/POST \/v1\/chat\/completions/g) || []).length,
  ]));
  const evidence = {
    retryHook: /HOOK retry registrado/.test(pluginLog),
    switchToB: /SWITCHMODEL -> mockb\/m-b/.test(pluginLog),
    retryAllowed: /DECISION retry=true/.test(pluginLog),
    permanentRejected: /DECISION retry=false \(error permanente: 400\)/.test(pluginLog),
  };
  const pass = SCENARIO === "T2"
    ? result.code !== 0
      && posts.mocka === 2
      && posts.mockb === 0
      && posts.mockc === 0
      && evidence.retryHook
      && evidence.permanentRejected
      && !evidence.switchToB
    : result.code === 0
      && /MOCKB: Response from MOCKB/.test(result.stdout)
      && posts.mocka === 2
      && posts.mockb === 1
      && posts.mockc === 0
      && evidence.retryHook
      && evidence.switchToB
      && evidence.retryAllowed;
  console.log(JSON.stringify({
    pass,
    exit: result.code,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    posts,
    evidence,
    stamp,
  }, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    await stopTree(child);
  }
  await Promise.all(children.map((child) => child.output?.().catch(() => {})));
}

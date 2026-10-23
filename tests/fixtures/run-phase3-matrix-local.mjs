import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LAB = "C:\\Users\\Norbe\\opencode-fallback-lab";
const ROOT = join(LAB, "plugins", "opencode-fallback");
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const OPENCODE = "C:\\Users\\Norbe\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe";
const MOCK = join(LAB, "xdg-iso", "mocks", "mock-flexible.js");
const PORTS = [9129, 9130, 9131];
const NAMES = ["mocka", "mockb", "mockc"];
const DEFAULT_SCENARIOS = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11"];
const requested = process.env.PHASE3_SCENARIOS || process.env.PHASE3_SCENARIO || DEFAULT_SCENARIOS.join(",");
const scenarios = requested.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);

function start(file, args, env) {
  const child = spawn(file, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.readStdout = () => Buffer.concat(stdout).toString("utf8");
  child.readStderr = () => Buffer.concat(stderr).toString("utf8");
  child.readOutput = () => `${child.readStdout()}${child.readStderr()}`;
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`port ${port} did not open`);
}

async function getFreePort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function modelConfig(name, context = 32768) {
  const provider = name === "mocka" ? "mocka" : name === "mockb" ? "mockb" : "mockc";
  const id = name === "mocka" ? "m-a" : name === "mockb" ? "m-b" : "m-c";
  return {
    name: name.toUpperCase(),
    package: "aisdk:@ai-sdk/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${name === "mocka" ? 9129 : name === "mockb" ? 9130 : 9131}/v1`, apiKey: "test" },
    models: { [id]: { name: name.toUpperCase(), limit: { context, output: 8192 } } },
    provider,
  };
}

function makeConfig(scenario, pluginLogDir) {
  const mockBContext = scenario === "T6" ? 4096 : 32768;
  const mockCContext = scenario === "T7" ? 65536 : 32768;
  const a = modelConfig("mocka");
  const b = modelConfig("mockb", mockBContext);
  const c = modelConfig("mockc", mockCContext);
  delete a.provider;
  delete b.provider;
  delete c.provider;
  return {
    $schema: "https://opencode.ai/config.json",
    model: "mocka/m-a",
    share: "disabled",
    skills: [join(ROOT, "skills").replaceAll("\\", "/")],
    providers: { mocka: a, mockb: b, mockc: c },
    plugins: [{
      package: ROOT.replaceAll("\\", "/"),
      options: {
        enabled: scenario !== "T5",
        fallback_models: ["mocka/m-a", "mockb/m-b", "mockc/m-c"],
        retry_on_errors: [429, 500, 502, 503, 504],
        retryable_types: ["provider.transport"],
        max_attempts: 3,
        max_transitions: 2,
        cooldown_ms: 0,
        context_safety_ratio: 0.8,
        require_context_check: true,
        allow_unknown_context: false,
        require_side_effect_guard: true,
        compaction_enabled: false,
        debug: true,
        logDir: pluginLogDir,
      },
    }],
  };
}

function expected(scenario, result, posts, pluginLog) {
  const common = /HOOK retry registrado/.test(pluginLog);
  switch (scenario) {
    case "T0":
    case "T11":
      return result.code === 0 && /MOCKA: Response from MOCKA/.test(result.stdout)
        && posts.mocka === 2 && posts.mockb === 0 && posts.mockc === 0
        && common && /CONTEXT CAPTURE/.test(pluginLog);
    case "T1":
    case "T9":
      return result.code === 0 && /MOCKB: Response from MOCKB/.test(result.stdout)
        && posts.mocka === 2 && posts.mockb === 1 && posts.mockc === 0
        && common && /SWITCHMODEL -> mockb\/m-b/.test(pluginLog)
        && /DECISION retry=true/.test(pluginLog)
        && (scenario !== "T9" || /guardado como activo/.test(pluginLog));
    case "T2":
      return result.code !== 0 && posts.mocka === 2 && posts.mockb === 0 && posts.mockc === 0
        && common && /error permanente: 400/.test(pluginLog) && !/SWITCHMODEL ->/.test(pluginLog);
    case "T3":
      return result.code !== 0 && posts.mocka === 2 && posts.mockb === 0 && posts.mockc === 0
        && common && /error permanente: 401/.test(pluginLog) && !/SWITCHMODEL ->/.test(pluginLog);
    case "T4":
      return result.code !== 0 && posts.mocka === 2 && posts.mockb === 1 && posts.mockc === 1
        && common && /presupuesto de transiciones agotado/.test(pluginLog)
        && !/mocka\/m-a \(guardado/.test(pluginLog);
    case "T5":
      return result.code === 0 && /MOCKA: Response from MOCKA/.test(result.stdout)
        && posts.mocka === 2 && posts.mockb === 0 && posts.mockc === 0
        && !common && /PLUGIN DESACTIVADO/.test(pluginLog);
    case "T6":
      return result.code !== 0 && posts.mocka === 2 && posts.mockb === 0 && posts.mockc === 0
        && common && /contexto_destino_menor_sin_conteo_fiable|request no cabe/.test(pluginLog)
        && !/SWITCHMODEL ->/.test(pluginLog);
    case "T7":
      return result.code === 0 && /MOCKB: Response from MOCKB/.test(result.stdout)
        && posts.mocka === 2 && posts.mockb === 1 && posts.mockc === 0
        && common && /SWITCHMODEL -> mockb\/m-b/.test(pluginLog);
    case "T8":
      return result.code !== 0 && posts.mocka >= 1 && posts.mockb === 0 && posts.mockc === 0
        && common && /side effect guard: partial_output|side_effect/.test(pluginLog)
        && !/SWITCHMODEL ->/.test(pluginLog);
    case "T10":
      return result.code === 0 && /MOCKC: Response from MOCKC/.test(result.stdout)
        && posts.mocka === 2 && posts.mockb === 1 && posts.mockc === 1
        && common && /SWITCHMODEL -> mockc\/m-c/.test(pluginLog)
        && !/SWITCHMODEL -> mocka\/m-a/.test(pluginLog);
    case "T12":
      return result.code === 0 && /MOCKB: Response from MOCKB/.test(result.stdout)
        && posts.mocka === 2 && posts.mockb === 1 && posts.mockc === 0
        && common && /type=provider\.transport/.test(pluginLog)
        && /SWITCHMODEL -> mockb\/m-b/.test(pluginLog);
    default:
      return false;
  }
}

async function runScenario(scenario, index) {
  const stamp = `${Date.now()}_${process.pid}_${index}`;
  const runRoot = join(LAB, "xdg-iso", "phase3-matrix", `${scenario}-${stamp}`);
  const configDir = join(runRoot, "config", "opencode");
  const dataDir = join(runRoot, "data");
  const cacheDir = join(runRoot, "cache");
  const stateDir = join(runRoot, "state");
  const logDir = join(runRoot, "plugin-logs");
  const logsDir = join(runRoot, "process-logs");
  const configFile = join(configDir, "opencode.jsonc");
  const serverPort = await getFreePort();
  const env = {
    XDG_CONFIG_HOME: join(runRoot, "config"),
    OPENCODE_CONFIG_DIR: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_STATE_HOME: stateDir,
    OPENCODE_PASSWORD: `phase3-matrix-${scenario}-${stamp}`,
  };
  const children = [];
  await mkdir(configDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(configFile, `${JSON.stringify(makeConfig(scenario, logDir), null, 2)}\n`);

  try {
    for (let index = 0; index < NAMES.length; index += 1) {
      children.push(start(
        NODE,
        [MOCK],
        { ...env, MOCK_TEST: scenario, MOCK_PORT: String(PORTS[index]) },
      ));
    }
    const server = start(
      OPENCODE,
      ["serve", "--port", String(serverPort), "--hostname", "127.0.0.1"],
      env,
    );
    children.push(server);
    await Promise.all([serverPort, ...PORTS].map((port) => waitForPort(port)));

    const result = await new Promise((resolve) => {
      const child = start(
        OPENCODE,
        ["run", "--server", `http://127.0.0.1:${serverPort}`, "--model", "mocka/m-a", `Phase3 ${scenario} local fixture`],
        env,
      );
      let settled = false;
      const finish = async (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value.timeout) await stopTree(child);
        resolve({ code: value.code, timeout: Boolean(value.timeout), stdout: child.readStdout(), stderr: child.readStderr() });
      };
      const timer = setTimeout(() => { void finish({ code: null, timeout: true }); }, 60_000);
      child.closed.then((code) => finish({ code, timeout: false }));
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    const mockOutputs = children.slice(0, NAMES.length).map((child) => child.readOutput());
    const posts = Object.fromEntries(mockOutputs.map((text, index) => [
      NAMES[index], (text.match(/POST \/v1\/chat\/completions/g) || []).length,
    ]));
    const pluginLog = await readFile(join(logDir, "opencode-fallback.log"), "utf8").catch(() => "");
    const pass = expected(scenario, result, posts, pluginLog);
    await writeFile(join(logsDir, "mocks.log"), mockOutputs.map((text, index) => `### ${NAMES[index]}\n${text}`).join("\n"));
    await writeFile(join(logsDir, "server.log"), children.at(-1)?.readOutput() || "");
    await writeFile(join(logsDir, "run.json"), JSON.stringify({ scenario, result, posts, pass }, null, 2));
    return { scenario, pass, result, posts, pluginLog, runRoot };
  } finally {
    for (const child of children.reverse()) await stopTree(child);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const results = [];
for (let index = 0; index < scenarios.length; index += 1) {
  const scenario = scenarios[index];
  try {
    const result = await runScenario(scenario, index);
    results.push(result);
    console.log(JSON.stringify({ scenario, pass: result.pass, exit: result.result.code, posts: result.posts, runRoot: result.runRoot }, null, 2));
    if (!result.pass) break;
  } catch (error) {
    results.push({ scenario, pass: false, error: error?.message || String(error) });
    console.error(JSON.stringify(results.at(-1), null, 2));
    break;
  }
}

const pass = results.length === scenarios.length && results.every((result) => result.pass);
console.log(JSON.stringify({ pass, scenarios, results: results.map(({ scenario, pass: scenarioPass, result, posts, runRoot, error }) => ({ scenario, pass: scenarioPass, exit: result?.code, posts, runRoot, error })) }, null, 2));
if (!pass) process.exitCode = 1;

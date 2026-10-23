import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const LAB = "C:\\Users\\Norbe\\opencode-fallback-lab";
const ROOT = "C:\\Users\\Norbe\\opencode-fallback-lab\\plugins\\opencode-fallback";
const CONFIG_DIR = join(ROOT, "tests", "fixtures", "phase3-t1-config");
const LOG_DIR = join(ROOT, "tests", "fixtures", "phase3-t1-runtime", "logs");
const XDG = join(LAB, "xdg-iso");
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const OPENCODE = "C:\\Users\\Norbe\\AppData\\Roaming\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe";
const ports = [9129, 9130, 9131];

function spawnCapture(file, args, env) {
  const child = spawn(file, args, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  child.readOutput = () => Buffer.concat(output).toString("utf8");
  return child;
}

async function waitForPort(port) {
  const net = await import("node:net");
  const deadline = Date.now() + 20_000;
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

await mkdir(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
const mocks = ports.map((port) => spawnCapture(NODE, [join(XDG, "mocks", "mock-flexible.js")], {
  MOCK_TEST: "T1",
  MOCK_PORT: String(port),
}));

try {
  await Promise.all(ports.map(waitForPort));
  const result = await new Promise((resolve) => {
    const run = spawnCapture(OPENCODE, ["run", "--standalone", "--model", "mocka/m-a", "Test Phase3 T1: fallback"], {
      OPENCODE_CONFIG_DIR: CONFIG_DIR,
      XDG_CONFIG_HOME: join(XDG, "config"),
      XDG_DATA_HOME: join(XDG, "data"),
      XDG_CACHE_HOME: join(XDG, "cache"),
      XDG_STATE_HOME: join(XDG, "state"),
      OPENCODE_PASSWORD: "phase3-t1-standalone-password",
    });
    run.on("close", (code) => resolve({ code, output: run.readOutput() }));
    setTimeout(() => run.kill(), 60_000).unref();
  });
  const texts = mocks.map((mock) => mock.readOutput());
  await Promise.all(mocks.map((mock, index) => import("node:fs/promises").then(({ writeFile }) => writeFile(join(LOG_DIR, `mock-${ports[index]}-${stamp}.log`), mock.readOutput()))));
  console.log(JSON.stringify({
    exit: result.code,
    output: result.output.trim(),
    posts: Object.fromEntries(ports.map((port, index) => [String(port), (texts[index].match(/POST \/v1\/chat\/completions/g) || []).length])),
    stamp,
  }, null, 2));
} finally {
  for (const mock of mocks.reverse()) {
    if (!mock.killed) mock.kill();
  }
  await readFile(join(LOG_DIR, "unused"), "utf8").catch(() => {});
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = join(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmInvocation = existsSync(npmCli)
  ? { command: process.execPath, prefix: [npmCli] }
  : { command: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] };

async function runNpm(args, cwd) {
  return execFileAsync(npmInvocation.command, [...npmInvocation.prefix, ...args], {
    cwd,
    windowsHide: true,
  });
}

test("release metadata is public, reproducible, and licensed", async () => {
  assert.notEqual(packageJson.private, true);
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.repository?.type, "git");
  assert.match(packageJson.repository?.url ?? "", /github\.com\/facishola\/relevo-opencode/);
  assert.ok(existsSync(join(root, "LICENSE")));
  assert.ok(existsSync(join(root, "SECURITY.md")));

  const validation = await execFileAsync(process.execPath, [join(root, "scripts", "validate-package.mjs")], {
    cwd: root,
    windowsHide: true,
  });
  assert.match(validation.stdout, /"pass": true/);
});

test("release package excludes tests and generated or sensitive artifacts", async () => {
  const destination = await mkdtemp(join(tmpdir(), "opencode-fallback-pack-"));
  const result = await runNpm([
    "pack",
    "--ignore-scripts",
    "--offline",
    "--pack-destination",
    destination,
    "--json",
  ], root);
  const metadata = JSON.parse(result.stdout.trim())[0];
  const names = metadata.files.map((entry) => entry.path);

  assert.ok(names.includes("index.js"));
  assert.ok(names.includes("LICENSE"));
  assert.ok(names.includes("README.md"));
  assert.ok(names.includes("scripts/install.mjs"));
  assert.ok(names.every((name) => !/^(tests|logs|\.git|\.npm-cache-local)\//i.test(name)));
  assert.ok(names.every((name) => !/(\.db(?:-|$)|\.log$|\.tgz$|_broken$|secret|credential|token)/i.test(name)));
});

test("a packed release installs and runs the portable installer", async () => {
  const packageDestination = await mkdtemp(join(tmpdir(), "opencode-fallback-release-"));
  const project = await mkdtemp(join(tmpdir(), "opencode-fallback-consumer-"));
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true }, null, 2), "utf8");

  const packResult = await runNpm([
    "pack",
    "--ignore-scripts",
    "--offline",
    "--pack-destination",
    packageDestination,
    "--json",
  ], root);
  const tarball = join(packageDestination, JSON.parse(packResult.stdout.trim())[0].filename);
  await runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], project);

  const installed = join(project, "node_modules", packageJson.name);
  assert.ok(existsSync(join(installed, "scripts", "install.mjs")));
  const target = await mkdtemp(join(tmpdir(), "opencode-fallback-consumer-target-"));
  const installResult = await execFileAsync(process.execPath, [
    join(installed, "scripts", "install.mjs"),
    "--target",
    target,
  ], { windowsHide: true });
  assert.match(installResult.stdout, /created-disabled/);
  assert.ok(existsSync(join(target, "vendor", "opencode-fallback", "index.js")));
  assert.match(await readFile(join(target, "opencode.jsonc"), "utf8"), /"enabled": false/);
});

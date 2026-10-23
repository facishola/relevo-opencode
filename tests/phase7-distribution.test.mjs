import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const installer = join(root, "scripts", "install.mjs");

async function runInstaller(target, ...extra) {
  return execFileAsync(process.execPath, [installer, "--source", root, "--target", target, ...extra], {
    cwd: root,
    windowsHide: true,
  });
}

test("distribution installer creates a disabled project integration", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-fallback-install-"));
  const result = await runInstaller(target);
  const config = await readFile(join(target, "opencode.jsonc"), "utf8");

  assert.match(result.stdout, /created-disabled/);
  assert.match(config, /"enabled": false/);
  assert.match(config, /vendor\/opencode-fallback/);
  assert.match(await readFile(join(target, "vendor", "opencode-fallback", "index.js"), "utf8"), /export default/);
  assert.match(await readFile(join(target, ".opencode", "commands", "fallback", "enable.md"), "utf8"), /Habilita/);
  assert.match(await readFile(join(target, ".opencode", "skills", "opencode-fallback-setup", "SKILL.md"), "utf8"), /autoinvoke: false/);
  const validation = await execFileAsync(process.execPath, [join(root, "scripts", "validate-install.mjs"), "--target", target], { windowsHide: true });
  assert.match(validation.stdout, /"pass": true/);
});

test("distribution installer preserves an existing OpenCode config", async () => {
  const target = await mkdtemp(join(tmpdir(), "opencode-fallback-existing-"));
  const existing = '{\n  "model": "local/model",\n  // keep this comment\n}\n';
  const configPath = join(target, "opencode.jsonc");
  await writeFile(configPath, existing, "utf8");

  const result = await runInstaller(target);
  assert.match(result.stdout, /manual-merge-required/);
  assert.equal(await readFile(configPath, "utf8"), existing);
});


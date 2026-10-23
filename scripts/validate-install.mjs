import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const targetIndex = args.indexOf("--target");
const target = resolve(targetIndex >= 0 ? args[targetIndex + 1] : process.cwd());
const configPath = [join(target, "opencode.jsonc"), join(target, "opencode.json")]
  .find((candidate) => existsSync(candidate));
const configText = configPath ? await readFile(configPath, "utf8") : "";
const checks = [
  ["config", Boolean(configPath)],
  ["plugin-disabled", /["']?enabled["']?\s*:\s*false/.test(configText) && configText.includes("vendor/opencode-fallback")],
  ["plugin", existsSync(join(target, "vendor", "opencode-fallback", "index.js"))],
  ["plugin-package", existsSync(join(target, "vendor", "opencode-fallback", "package.json"))],
  ["commands", existsSync(join(target, ".opencode", "commands", "fallback", "install.md"))],
  ["skill", existsSync(join(target, ".opencode", "skills", "opencode-fallback-setup", "SKILL.md"))],
];
const result = { target, pass: checks.every(([, pass]) => pass), checks: Object.fromEntries(checks) };
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;


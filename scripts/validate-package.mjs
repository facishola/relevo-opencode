import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const checks = [];

function check(name, pass, detail) {
  checks.push({ name, pass, ...(detail ? { detail } : {}) });
}

check("public-package", packageJson.private !== true, "package.json must not declare private=true");
check("stable-semver", /^\d+\.\d+\.\d+$/.test(packageJson.version), `version=${packageJson.version}`);
check("license", packageJson.license === "MIT" && existsSync(join(root, "LICENSE")));
check("repository", packageJson.repository?.type === "git" && typeof packageJson.repository?.url === "string");
check("entrypoint", packageJson.type === "module" && packageJson.main === "./index.js" && packageJson.exports?.["."] === "./index.js");

const requiredFiles = [
  "index.js",
  "lib",
  "skills",
  "commands",
  "scripts/install.mjs",
  "scripts/validate-install.mjs",
  "README.md",
  "README.txt",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md",
];
for (const entry of requiredFiles) check(`file:${entry}`, existsSync(join(root, entry)));

const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
check("files-allowlist", packageFiles.length > 0 && !packageFiles.some((entry) => /^(tests|logs|\.git|\.npm-cache-local)(\/|$)/i.test(entry)));
check("no-runtime-dependencies", !packageJson.dependencies || Object.keys(packageJson.dependencies).length === 0);

const failed = checks.filter((entry) => !entry.pass);
const result = { pass: failed.length === 0, root, version: packageJson.version, checks };
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;

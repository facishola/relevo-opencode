import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = resolve(SCRIPT_DIR, "..");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`Argumento inesperado: ${value}`);
    const key = value.slice(2);
    if (key === "dry-run") {
      args.dryRun = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Falta valor para --${key}`);
    args[key] = next;
    index += 1;
  }
  return args;
}

function requiredSourceFiles(source) {
  return ["index.js", "package.json", "lib", "skills", "commands", "scripts"]
    .filter((entry) => !existsSync(join(source, entry)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = resolve(args.source || DEFAULT_SOURCE);
  const target = resolve(args.target || process.cwd());
  const pluginTarget = join(target, "vendor", "opencode-fallback");
  const commandTarget = join(target, ".opencode", "commands", "fallback");
  const skillTarget = join(target, ".opencode", "skills", "opencode-fallback-setup");
  const missing = requiredSourceFiles(source);

  if (missing.length > 0) {
    throw new Error(`Origen inválido; faltan: ${missing.join(", ")}`);
  }
  const relativeTarget = relative(source, target);
  const targetInsideSource = relativeTarget === ""
    || (relativeTarget !== ".."
      && !relativeTarget.startsWith(`..${sep}`)
      && !isAbsolute(relativeTarget));
  if (targetInsideSource) {
    throw new Error("El destino no puede estar dentro del directorio fuente");
  }

  const managedTargets = [];
  for (const entry of ["index.js", "lib", "package.json", "package-lock.json"]) {
    if (existsSync(join(source, entry))) managedTargets.push(join(pluginTarget, entry));
  }
  for (const entry of await readdir(join(source, "commands", "fallback"))) {
    managedTargets.push(join(commandTarget, entry));
  }
  managedTargets.push(join(skillTarget, "SKILL.md"));
  const existingManaged = managedTargets.filter((entry) => existsSync(entry));
  if (!args.dryRun && existingManaged.length > 0) {
    throw new Error(`El destino ya contiene archivos administrados; no se modifica: ${existingManaged.join(", ")}`);
  }

  const configCandidates = [join(target, "opencode.jsonc"), join(target, "opencode.json")];
  const configExists = configCandidates.find((candidate) => existsSync(candidate));
  const planned = [
    `${pluginTarget} (runtime)`,
    `${commandTarget} (comandos)`,
    `${skillTarget} (skill)`,
    configExists
      ? `${configExists} (requiere merge manual, no se sobrescribe)`
      : `${join(target, "opencode.jsonc")} (configuración desactivada)`,
  ];

  if (args.dryRun) {
    console.log(JSON.stringify({ source, target, planned, configExists: Boolean(configExists) }, null, 2));
    return;
  }

  await mkdir(pluginTarget, { recursive: true });
  for (const entry of ["index.js", "lib", "package.json", "package-lock.json"]) {
    if (existsSync(join(source, entry))) {
      await cp(join(source, entry), join(pluginTarget, entry), { recursive: true, force: false });
    }
  }
  await mkdir(commandTarget, { recursive: true });
  await cp(join(source, "commands", "fallback"), commandTarget, { recursive: true, force: false });
  await mkdir(skillTarget, { recursive: true });
  await cp(join(source, "skills", "opencode-fallback-setup", "SKILL.md"), join(skillTarget, "SKILL.md"), { force: false });

  if (!configExists) {
    const config = `{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./vendor/opencode-fallback",
      "options": {
        "enabled": false,
        "free_only": true,
        "auto_discover_free_models": true,
        "fallback_models": [],
        "free_models": [],
        "compaction_enabled": false
      }
    }
  ],
  "skills": ["./.opencode/skills"]
}\n`;
    await writeFile(join(target, "opencode.jsonc"), config, "utf8");
  }

  console.log(JSON.stringify({ source, target, installed: true, config: configExists ? "manual-merge-required" : "created-disabled" }, null, 2));
}

main().catch((error) => {
  console.error(`[opencode-fallback] install failed: ${error.message}`);
  process.exitCode = 1;
});


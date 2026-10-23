import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

test("package exposes the OpenCode plugin entrypoint", () => {
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.main, "./index.js");
  assert.deepEqual(packageJson.exports, { ".": "./index.js" });
  assert.ok(packageJson.files.includes("index.js"));
  assert.ok(packageJson.files.includes("lib"));
  assert.ok(packageJson.files.includes("skills"));
  assert.ok(packageJson.files.includes("commands"));
  assert.ok(packageJson.files.includes("scripts"));
  assert.ok(packageJson.files.includes("README.txt"));
});

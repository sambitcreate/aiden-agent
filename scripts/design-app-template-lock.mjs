#!/usr/bin/env node
// Regenerates resources/design-app-template/package-lock.json (design mode v2
// Phase 3d, S105). A builder's dependency bump, run by hand with
// `npm run design-app-template:lock` after changing the template's pins: it
// reaches the npm registry like any `npm install` on a developer machine.
// Nothing runs it at runtime, in tests or in CI.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const template = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", "design-app-template");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aiden-design-app-lock-"));
try {
  for (const name of ["package.json", ".npmrc"]) fs.copyFileSync(path.join(template, name), path.join(scratch, name));
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: scratch,
    stdio: "inherit",
  });
  const lock = JSON.parse(fs.readFileSync(path.join(scratch, "package-lock.json"), "utf8"));
  lock.name = "design-app";
  if (lock.packages?.[""]) lock.packages[""].name = "design-app";
  fs.writeFileSync(path.join(template, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  process.stdout.write(`Wrote ${path.relative(process.cwd(), path.join(template, "package-lock.json"))}\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
